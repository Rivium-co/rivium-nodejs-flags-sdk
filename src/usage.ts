import { Logger } from './types';

/** Optional evaluation counts for `POST /server/v2/usage`. Not billed. */

const FLUSH_INTERVAL_MS = 60_000;
const MAX_DISTINCT = 500;
const MAX_PER_REQUEST = 1000;
const MAX_COUNT = 10_000_000;

export interface UsageEntry {
  flagKey: string;
  variant: string | null;
  enabled: boolean;
  count: number;
}

export interface UsageReporterOptions {
  url: string;
  headers: () => Record<string, string>;
  environment: string | null;
  fetch: typeof fetch;
  logger: Logger;
  flushIntervalMs?: number;
}

export class UsageReporter {
  private entries = new Map<string, UsageEntry>();
  private periodStart: Date | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending = new Set<Promise<void>>();

  constructor(private readonly opts: UsageReporterOptions) {}

  /** Count one evaluation. No user ids are kept or sent. */
  count(flagKey: string, variant: string | null, enabled: boolean): void {
    if (!this.periodStart) this.periodStart = new Date();
    this.ensureTimer();
    const id = `${flagKey}\u0000${variant ?? ''}\u0000${variant === null ? 'n' : 'v'}\u0000${enabled ? 1 : 0}`;
    const e = this.entries.get(id);
    if (e) {
      e.count += 1;
      if (e.count >= MAX_COUNT) this.flush();
    } else {
      this.entries.set(id, { flagKey, variant, enabled, count: 1 });
      if (this.entries.size >= MAX_DISTINCT) this.flush();
    }
  }

  /** Send what has been counted so far. */
  flush(): Promise<void> {
    if (this.entries.size === 0 || !this.periodStart) return Promise.resolve();
    const counts = [...this.entries.values()];
    const periodStart = this.periodStart.toISOString();
    const periodEnd = new Date().toISOString();
    this.entries = new Map();
    this.periodStart = null;
    const sends: Promise<void>[] = [];
    for (let i = 0; i < counts.length; i += MAX_PER_REQUEST) {
      const body = {
        environment: this.opts.environment,
        periodStart,
        periodEnd,
        counts: counts.slice(i, i + MAX_PER_REQUEST),
      };
      const p = this.send(body, true).finally(() => this.pending.delete(p));
      this.pending.add(p);
      sends.push(p);
    }
    return Promise.all(sends).then(() => undefined);
  }

  /** Stop the timer and flush; waits for every in-flight report. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    await Promise.all([...this.pending]);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.opts.flushIntervalMs ?? FLUSH_INTERVAL_MS);
    const t = this.timer as any;
    if (t && typeof t.unref === 'function') t.unref();
  }

  private async send(body: unknown, retry: boolean): Promise<void> {
    try {
      const res = await this.opts.fetch(this.opts.url, {
        method: 'POST',
        headers: { ...this.opts.headers(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.status >= 200 && res.status < 300) return;
      if (res.status >= 500 && retry) return this.send(body, false);
      this.opts.logger.warn(`usage report dropped (HTTP ${res.status})`);
    } catch (err) {
      if (retry) return this.send(body, false);
      this.opts.logger.warn(`usage report dropped (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
