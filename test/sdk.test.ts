import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RiviumFlags } from '../src';
import { backoffDelayMs, parseRetryAfter } from '../src/backoff';
import { mockFetch, silentLogger } from './helpers';

const payload = {
  schemaVersion: 2,
  environment: 'production',
  generatedAt: '2026-10-01T12:00:00.000Z',
  flags: [
    { key: 'on-bool', valueType: 'boolean', enabled: true, rolloutPercentage: 100, salt: 'a1b2c3d4e5f6', rules: null, variants: [], offValue: false, prerequisites: [], version: 3 },
    { key: 'theme', valueType: 'string', enabled: true, rolloutPercentage: 100, salt: 'a1b2c3d4e5f6', rules: null, variants: [{ key: 'dark', value: 'dark', weight: 100 }], offValue: 'light', prerequisites: [], version: 7 },
    { key: 'limit', valueType: 'number', enabled: true, rolloutPercentage: 100, salt: 'a1b2c3d4e5f6', rules: null, variants: [{ key: 'ten', value: 10, weight: 100 }], offValue: 1, prerequisites: [], version: 1 },
    { key: 'cfg', valueType: 'json', enabled: true, rolloutPercentage: 100, salt: 'a1b2c3d4e5f6', rules: null, variants: [{ key: 'a', value: { x: 1 }, weight: 100 }], offValue: null, prerequisites: [], version: 1 },
  ],
  segments: [],
};

function ok() {
  return { status: 200, body: payload, headers: { etag: '"s2-abc"' } };
}

const base = { apiKey: 'rv_test_key', serverSecret: 'rv_srv_secret', logger: silentLogger, pollIntervalSeconds: 0 };

test('constructor requires apiKey and serverSecret', () => {
  assert.throws(() => new RiviumFlags({ apiKey: '', serverSecret: 'x' } as any), /apiKey/);
  assert.throws(() => new RiviumFlags({ apiKey: 'x' } as any), /serverSecret/);
});

test('refuses to run in a browser', () => {
  const g = globalThis as any;
  g.window = { document: {} };
  try {
    assert.throws(() => new RiviumFlags({ ...base, fetch: mockFetch(ok).fetch }), /browser/);
  } finally {
    delete g.window;
  }
});

test('GET /server/v2/flags with key, secret, sdk header and environment', async () => {
  const m = mockFetch(ok);
  const flags = new RiviumFlags({ ...base, environment: 'production', baseUrl: 'https://flags.example/', fetch: m.fetch });
  await flags.init();
  assert.equal(m.calls.length, 1);
  const c = m.calls[0];
  assert.equal(c.method, 'GET');
  assert.equal(c.url, 'https://flags.example/server/v2/flags?environment=production');
  assert.equal(c.headers['x-api-key'], 'rv_test_key');
  assert.equal(c.headers['x-server-secret'], 'rv_srv_secret');
  assert.equal(c.headers['x-rivium-sdk'], 'node/0.2.0');
  assert.equal(c.headers['if-none-match'], undefined);
  assert.ok(flags.isReady());
  await flags.close();
});

test('ETag: refresh sends If-None-Match and 304 keeps the rules', async () => {
  let n = 0;
  const m = mockFetch(() => (n++ === 0 ? ok() : { status: 304 }));
  const flags = new RiviumFlags({ ...base, fetch: m.fetch });
  await flags.init();
  await flags.refresh();
  assert.equal(m.calls[1].headers['if-none-match'], '"s2-abc"');
  assert.equal(flags.getString('theme', { userId: 'u' }, 'x'), 'dark');
  await flags.close();
});

test('typed getters, reasons and defaults', async () => {
  const flags = new RiviumFlags({ ...base, fetch: mockFetch(ok).fetch });
  const ctx = { userId: 'u1' };
  // Before rules are loaded
  assert.equal(flags.getDetail('on-bool', ctx, false).reason, 'NOT_READY');
  assert.equal(flags.isEnabled('on-bool', ctx, true), true);
  await flags.init();

  assert.equal(flags.getBoolean('on-bool', ctx, false), true);
  assert.equal(flags.getString('theme', ctx, 'x'), 'dark');
  assert.equal(flags.getNumber('limit', ctx, 0), 10);
  assert.deepEqual(flags.getJson('cfg', ctx, {}), { x: 1 });

  const mismatch = flags.getDetail('theme', ctx, 0, 'number');
  assert.equal(mismatch.reason, 'TYPE_MISMATCH');
  assert.equal(mismatch.value, 0);
  assert.equal(mismatch.enabled, false);
  assert.equal(mismatch.variant, null);
  assert.equal(flags.getJson('theme', ctx, { d: 1 }).d, 1);
  assert.equal(flags.getBoolean('theme', ctx, false), false);
  assert.equal(flags.getString('on-bool', ctx, 'd'), 'd');

  const missing = flags.getDetail('nope', ctx, 'fallback');
  assert.deepEqual(missing, { key: 'nope', value: 'fallback', enabled: false, variant: null, reason: 'FLAG_NOT_FOUND', version: null, valueType: null });

  const detail = flags.getDetail('theme', ctx, 'x');
  assert.deepEqual(detail, { key: 'theme', value: 'dark', enabled: true, variant: 'dark', reason: 'VARIANT', version: 7, valueType: 'string' });

  const all = flags.getAll(ctx);
  assert.deepEqual(Object.keys(all), ['cfg', 'limit', 'on-bool', 'theme']);
  assert.deepEqual(flags.getFlagKeys(), ['cfg', 'limit', 'on-bool', 'theme']);
  await flags.close();
});

test('401 stops polling until refresh(); error event; never logs secrets', async () => {
  const logged: string[] = [];
  const logger = { debug: (m: string) => logged.push(m), info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m), error: (m: string) => logged.push(m) };
  let status = 401;
  const m = mockFetch(() => (status === 401 ? { status: 401, body: { statusCode: 401, message: 'Invalid API key' } } : ok()));
  const flags = new RiviumFlags({ ...base, logger, fetch: m.fetch, pollIntervalSeconds: 10 });
  const errors: any[] = [];
  flags.on('error', (e) => errors.push(e));
  await flags.init();
  assert.equal(flags.isReady(), false);
  assert.equal(errors[0].status, 401);
  assert.equal((flags as any).stopped, true);
  assert.equal((flags as any).timer, null);
  assert.ok(logged.every((l) => !l.includes('rv_test_key') && !l.includes('rv_srv_secret')));
  status = 200;
  await flags.refresh();
  assert.equal(flags.isReady(), true);
  await flags.close();
});

test('429 keeps last rules and backs off at least Retry-After', async () => {
  let n = 0;
  const m = mockFetch(() => (n++ === 0 ? ok() : { status: 429, headers: { 'retry-after': '7' } }));
  const flags = new RiviumFlags({ ...base, fetch: m.fetch });
  await flags.init();
  await flags.refresh();
  assert.ok((flags as any).retryDelay >= 7000);
  assert.equal(flags.getBoolean('on-bool', {}, false), true);
  await flags.close();
});

test('network error keeps last rules', async () => {
  let n = 0;
  const m = mockFetch(() => (n++ === 0 ? ok() : Promise.reject(new Error('ECONNRESET'))));
  const flags = new RiviumFlags({ ...base, fetch: m.fetch });
  await flags.init();
  await flags.refresh();
  assert.equal(flags.getString('theme', {}, 'x'), 'dark');
  await flags.close();
});

test('init resolves after initTimeoutMs when the server does not answer', async () => {
  const m = mockFetch(() => new Promise<never>(() => {}));
  const flags = new RiviumFlags({ ...base, fetch: m.fetch, initTimeoutMs: 50 });
  const t = Date.now();
  await flags.init();
  assert.ok(Date.now() - t < 1000);
  assert.equal(flags.getDetail('x', {}, 1).reason, 'NOT_READY');
  await flags.close();
});

test('usage: aggregated counts posted on close, no user ids', async () => {
  const m = mockFetch((c) => (c.url.endsWith('/server/v2/usage') ? { status: 202, body: { accepted: 2 } } : ok()));
  const flags = new RiviumFlags({ ...base, environment: 'production', fetch: m.fetch, sendUsage: true });
  await flags.init();
  for (let i = 0; i < 3; i++) flags.isEnabled('on-bool', { userId: `u${i}` });
  flags.getString('theme', { userId: 'secret-user' }, 'x');
  flags.isEnabled('missing', { userId: 'u' });
  await flags.close();
  const post = m.calls.find((c) => c.url.endsWith('/server/v2/usage'))!;
  assert.ok(post);
  assert.equal(post.method, 'POST');
  assert.equal(post.headers['x-server-secret'], 'rv_srv_secret');
  assert.equal(post.body.environment, 'production');
  assert.ok(Date.parse(post.body.periodEnd) >= Date.parse(post.body.periodStart));
  assert.deepEqual(
    post.body.counts.sort((a: any, b: any) => a.flagKey.localeCompare(b.flagKey)),
    [
      { flagKey: 'on-bool', variant: null, enabled: true, count: 3 },
      { flagKey: 'theme', variant: 'dark', enabled: true, count: 1 },
    ],
  );
  assert.ok(!JSON.stringify(post.body).includes('secret-user'));
});

test('usage is off by default', async () => {
  const m = mockFetch(ok);
  const flags = new RiviumFlags({ ...base, fetch: m.fetch });
  await flags.init();
  flags.isEnabled('on-bool', { userId: 'u' });
  await flags.close();
  assert.equal(m.calls.filter((c) => c.url.includes('usage')).length, 0);
});

test('backoff: Retry-After default 5 s, ×2, capped at 5 min, ±20 %', () => {
  const mid = () => 0.5; // no jitter
  assert.equal(backoffDelayMs(1, null, mid), 5000);
  assert.equal(backoffDelayMs(2, null, mid), 10000);
  assert.equal(backoffDelayMs(20, null, mid), 300000);
  assert.equal(backoffDelayMs(1, 12, mid), 12000);
  assert.equal(backoffDelayMs(1, null, () => 0), 4000);
  assert.equal(backoffDelayMs(1, null, () => 1), 6000);
  assert.equal(backoffDelayMs(1, 10, () => 0), 10000); // never earlier than Retry-After
  assert.equal(parseRetryAfter('7'), 7);
  assert.equal(parseRetryAfter(null), null);
});
