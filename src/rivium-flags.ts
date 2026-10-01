import { backoffDelayMs, parseRetryAfter } from './backoff';
import { buildSnapshot, evaluate, Snapshot } from './engine';
import {
  EvalResult,
  EvaluationContext,
  FlagDetail,
  JsonValue,
  Logger,
  Reason,
  RiviumFlagsConfig,
  RiviumFlagsEvent,
  RiviumFlagsEventPayload,
  RiviumFlagsListener,
  ServerFlagsPayload,
  ValueType,
} from './types';
import { UsageReporter } from './usage';
import { SDK_PLATFORM, SDK_VERSION } from './version';

const DEFAULT_BASE_URL = 'https://flags.rivium.co';
const DEFAULT_POLL_SECONDS = 30;
const MIN_POLL_SECONDS = 10;
const DEFAULT_INIT_TIMEOUT_MS = 5000;

type FetchOutcome = 'ok' | 'not_modified' | 'retry' | 'stop';

function defaultLogger(debug: boolean): Logger {
  const p = '[Rivium Flags]';
  return {
    debug: (m) => {
      if (debug) console.debug(`${p} ${m}`);
    },
    info: (m) => console.info(`${p} ${m}`),
    warn: (m) => console.warn(`${p} ${m}`),
    error: (m) => console.error(`${p} ${m}`),
  };
}

function isBrowser(): boolean {
  const g = globalThis as any;
  return typeof g.window !== 'undefined' && typeof g.window.document !== 'undefined';
}

/**
 * Rivium Flags server SDK. Downloads the project's flag rules with the server
 * secret (`GET /server/v2/flags`), keeps them fresh with ETag polling, and
 * evaluates every flag locally — no network call per evaluation.
 *
 * @example
 * ```ts
 * const flags = new RiviumFlags({
 *   apiKey: process.env.RIVIUM_API_KEY!,
 *   serverSecret: process.env.RIVIUM_FLAGS_SERVER_SECRET!,
 *   environment: 'production',
 * });
 * await flags.init();
 *
 * const ctx = { userId: 'user-123', attributes: { plan: 'pro' } };
 * if (flags.isEnabled('new-checkout', ctx)) { ... }
 * const theme = flags.getString('theme', ctx, 'light');
 * ```
 */
export class RiviumFlags {
  private readonly apiKey: string;
  private readonly serverSecret: string;
  private readonly environment: string | null;
  private readonly baseUrl: string;
  private readonly pollMs: number;
  private readonly initTimeoutMs: number;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly usage: UsageReporter | null;

  private snapshot: Snapshot | null = null;
  private etag: string | null = null;
  private ready = false;
  private closed = false;
  private stopped = false;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<FetchOutcome> | null = null;
  private initPromise: Promise<void> | null = null;
  private listeners: { [E in RiviumFlagsEvent]: Set<RiviumFlagsListener<E>> } = {
    ready: new Set(),
    update: new Set(),
    error: new Set(),
  };

  constructor(config: RiviumFlagsConfig) {
    if (isBrowser()) {
      throw new Error(
        'Rivium Flags: RiviumFlags (server SDK) must not run in a browser — it needs the server secret. ' +
          'Use the client SDK with the public key instead.',
      );
    }
    if (!config || !config.apiKey) throw new Error('Rivium Flags: apiKey is required');
    if (!config.serverSecret) throw new Error('Rivium Flags: serverSecret is required for the server SDK');

    this.apiKey = config.apiKey;
    this.serverSecret = config.serverSecret;
    this.environment = config.environment || null;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const poll = config.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS;
    this.pollMs = poll <= 0 ? 0 : Math.max(poll, MIN_POLL_SECONDS) * 1000;
    this.initTimeoutMs = config.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.log = config.logger || defaultLogger(!!config.debug);
    const f = config.fetch || (globalThis as any).fetch;
    if (typeof f !== 'function') throw new Error('Rivium Flags: no fetch available (Node.js 18+ required)');
    this.fetchImpl = f.bind(globalThis);
    this.usage = config.sendUsage
      ? new UsageReporter({
          url: `${this.baseUrl}/server/v2/usage`,
          headers: () => this.headers(),
          environment: this.environment,
          fetch: this.fetchImpl,
          logger: this.log,
        })
      : null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Fetch the rules and start polling. Resolves after the first successful
   * fetch, or after `initTimeoutMs`, or when the server refuses the keys —
   * it never rejects. Until rules arrive every getter returns your default
   * with reason `NOT_READY`.
   */
  init(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.closed = false;
    this.initPromise = new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve();
        }
      };
      const t = setTimeout(() => {
        if (!this.ready) this.log.warn(`rules not loaded after ${this.initTimeoutMs} ms; serving defaults until they arrive`);
        done();
      }, this.initTimeoutMs);
      unref(t);
      this.cycle().then(done, done);
    });
    return this.initPromise;
  }

  /** True once rules have been loaded at least once. */
  isReady(): boolean {
    return this.ready;
  }

  /** Fetch the rules now (also restarts polling after a 401 / 403 / 404 stopped it). */
  async refresh(): Promise<void> {
    if (this.closed) return;
    this.stopped = false;
    this.failures = 0;
    await this.cycle();
  }

  /** Stop polling and flush pending usage counts. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.usage) await this.usage.close();
  }

  /** Subscribe to `ready`, `update` (rules changed) or `error`. Returns an unsubscribe function. */
  on<E extends RiviumFlagsEvent>(event: E, listener: RiviumFlagsListener<E>): () => void {
    (this.listeners[event] as Set<RiviumFlagsListener<E>>).add(listener);
    return () => {
      (this.listeners[event] as Set<RiviumFlagsListener<E>>).delete(listener);
    };
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  /** `true` only when the flag is served on (reason `ON` / `VARIANT`); `defaultValue` when not found / not ready. */
  isEnabled(key: string, context: EvaluationContext = {}, defaultValue = false): boolean {
    const r = this.evaluateKey(key, context);
    return r ? r.enabled : defaultValue;
  }

  getBoolean(key: string, context: EvaluationContext, defaultValue: boolean): boolean {
    return this.typed(key, context, defaultValue, 'boolean').value;
  }

  getString(key: string, context: EvaluationContext, defaultValue: string): string {
    return this.typed(key, context, defaultValue, 'string').value;
  }

  getNumber(key: string, context: EvaluationContext, defaultValue: number): number {
    return this.typed(key, context, defaultValue, 'number').value;
  }

  getJson<T = JsonValue>(key: string, context: EvaluationContext, defaultValue: T): T {
    return this.typed(key, context, defaultValue, 'json').value;
  }

  /**
   * The full result: value (or `defaultValue`), enabled, variant, reason, version.
   * Pass `valueType` to get `TYPE_MISMATCH` (and your default) when the flag has another type.
   */
  getDetail<T = unknown>(key: string, context: EvaluationContext, defaultValue: T, valueType?: ValueType): FlagDetail<T> {
    return valueType ? this.typed(key, context, defaultValue, valueType) : this.detail(key, context, defaultValue);
  }

  /** Every flag evaluated for one context. Empty until rules are loaded. */
  getAll(context: EvaluationContext = {}): Record<string, FlagDetail> {
    const out: Record<string, FlagDetail> = {};
    if (!this.snapshot) return out;
    for (const key of [...this.snapshot.flags.keys()].sort()) {
      out[key] = this.detail(key, context, undefined);
    }
    return out;
  }

  /** Keys of the loaded flags. */
  getFlagKeys(): string[] {
    return this.snapshot ? [...this.snapshot.flags.keys()].sort() : [];
  }

  // ── Internals: evaluation ─────────────────────────────────────────────────

  private evaluateKey(key: string, context: EvaluationContext): EvalResult | null {
    if (!this.snapshot) return null;
    const flag = this.snapshot.flags.get(key);
    if (!flag) return null;
    const r = evaluate(flag, context || {}, this.snapshot);
    this.usage?.count(r.key, r.variant, r.enabled);
    return r;
  }

  private missing<T>(key: string, defaultValue: T): FlagDetail<T> {
    const reason: Reason = this.snapshot ? 'FLAG_NOT_FOUND' : 'NOT_READY';
    return { key, value: defaultValue, enabled: false, variant: null, reason, version: null, valueType: null };
  }

  private detail<T>(key: string, context: EvaluationContext, defaultValue: T): FlagDetail<T> {
    const r = this.evaluateKey(key, context);
    if (!r) return this.missing(key, defaultValue);
    return {
      key,
      value: r.value as T,
      enabled: r.enabled,
      variant: r.variant,
      reason: r.reason,
      version: r.version,
      valueType: r.valueType,
    };
  }

  private typed<T>(key: string, context: EvaluationContext, defaultValue: T, expected: ValueType): FlagDetail<T> {
    const d = this.detail(key, context, defaultValue);
    if (d.valueType === null) return d;
    if (d.valueType !== expected || !valueMatches(expected, d.value)) {
      return { ...d, value: defaultValue, enabled: false, variant: null, reason: 'TYPE_MISMATCH' };
    }
    return d;
  }

  // ── Internals: fetching ───────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'x-server-secret': this.serverSecret,
      'x-rivium-sdk': `${SDK_PLATFORM}/${SDK_VERSION}`,
    };
  }

  /** One fetch, then schedule the next one. */
  private async cycle(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const outcome = await this.fetchOnce();
    if (this.closed) return;
    if (outcome === 'stop') {
      this.stopped = true;
      return;
    }
    let delay: number;
    if (outcome === 'retry') delay = this.retryDelay;
    else if (this.pollMs > 0) delay = this.pollMs;
    else return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.closed && !this.stopped) void this.cycle();
    }, delay);
    unref(this.timer);
  }

  private retryDelay = 0;

  private fetchOnce(): Promise<FetchOutcome> {
    if (!this.inFlight) {
      this.inFlight = this.doFetch().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async doFetch(): Promise<FetchOutcome> {
    const url = `${this.baseUrl}/server/v2/flags${
      this.environment ? `?environment=${encodeURIComponent(this.environment)}` : ''
    }`;
    const headers = this.headers();
    if (this.etag && this.snapshot) headers['If-None-Match'] = this.etag;

    let res: Response;
    try {
      res = await this.fetchImpl(url, { method: 'GET', headers });
    } catch (err) {
      return this.retry(undefined, `network error: ${errorMessage(err)}`);
    }

    if (res.status === 304) {
      this.failures = 0;
      this.log.debug('rules unchanged (304)');
      return 'not_modified';
    }
    if (res.status === 200) {
      let body: ServerFlagsPayload;
      try {
        body = (await res.json()) as ServerFlagsPayload;
      } catch (err) {
        return this.retry(undefined, `invalid response body: ${errorMessage(err)}`);
      }
      if (!body || !Array.isArray(body.flags)) return this.retry(undefined, 'invalid response body: no flags');
      this.snapshot = buildSnapshot(body.flags, Array.isArray(body.segments) ? body.segments : []);
      this.etag = res.headers.get('etag');
      this.failures = 0;
      const flagCount = body.flags.length;
      this.log.debug(`loaded ${flagCount} flags`);
      if (!this.ready) {
        this.ready = true;
        this.emit('ready', { flagCount });
      } else {
        this.emit('update', { flagCount });
      }
      return 'ok';
    }

    const { code, message } = await readError(res);
    const detail = `HTTP ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`;
    if (res.status === 429) {
      return this.retry(res.status, `rate limited (${detail})`, parseRetryAfter(res.headers.get('retry-after')), code);
    }
    if (res.status >= 500) return this.retry(res.status, detail, null, code);

    // 400 / 401 / 403 / 404 / 413: do not retry automatically.
    const hint =
      res.status === 401
        ? 'check the API key and server secret, and that Flags is enabled for the project'
        : res.status === 403
          ? 'the server secret is required, or this IP is not in its allow-list'
          : res.status === 404
            ? code === 'environment_not_found'
              ? `environment "${this.environment}" does not exist or is inactive`
              : `not found at ${this.baseUrl}`
            : 'request refused';
    this.log.error(`could not load rules (${detail}); ${hint}. Polling stopped until refresh().`);
    this.emit('error', { status: res.status, code, message: detail });
    return 'stop';
  }

  private retry(status: number | undefined, message: string, retryAfter: number | null = null, code?: string): FetchOutcome {
    this.failures += 1;
    this.retryDelay = backoffDelayMs(this.failures, retryAfter);
    this.log.warn(`could not load rules (${message}); keeping the last rules, retrying in ${Math.round(this.retryDelay / 1000)} s`);
    this.emit('error', { status, code, message });
    return 'retry';
  }

  private emit<E extends RiviumFlagsEvent>(event: E, payload: RiviumFlagsEventPayload[E]): void {
    for (const l of this.listeners[event] as Set<RiviumFlagsListener<E>>) {
      try {
        l(payload);
      } catch (err) {
        this.log.error(`listener for "${event}" threw: ${errorMessage(err)}`);
      }
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function unref(t: any): void {
  if (t && typeof t.unref === 'function') t.unref();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readError(res: Response): Promise<{ code?: string; message?: string }> {
  try {
    const body = (await res.json()) as any;
    const message = Array.isArray(body?.message) ? body.message.join('; ') : body?.message;
    return { code: typeof body?.code === 'string' ? body.code : undefined, message: typeof message === 'string' ? message : undefined };
  } catch {
    return {};
  }
}

function valueMatches(type: ValueType, v: unknown): boolean {
  switch (type) {
    case 'boolean':
      return typeof v === 'boolean';
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    default:
      return v !== undefined;
  }
}
