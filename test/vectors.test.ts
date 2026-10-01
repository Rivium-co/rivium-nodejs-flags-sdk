import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RiviumFlags, bucket, buildSnapshot, evaluate } from '../src';
import { loadVectors, mockFetch, silentLogger } from './helpers';

const vectors = loadVectors();
const total = vectors.suites.reduce((n, s) => n + s.cases.length, 0);

test(`hash vectors (${vectors.hashVectors.length})`, () => {
  for (const h of vectors.hashVectors) {
    assert.equal(bucket(h.flagKey, h.salt, h.purpose, h.id), h.bucket, `${h.flagKey}.${h.salt}.${h.purpose}.${h.id}`);
  }
});

test(`engine passes every evaluation vector (${total})`, () => {
  let passed = 0;
  for (const suite of vectors.suites) {
    const snapshot = buildSnapshot(suite.flags, suite.segments);
    for (const c of suite.cases) {
      const flag = snapshot.flags.get(c.flagKey)!;
      const r = evaluate(flag, c.context, snapshot);
      const got = { enabled: r.enabled, value: r.value, variant: r.variant, reason: r.reason };
      assert.deepStrictEqual(got, c.expected, `${suite.name} / ${c.name}`);
      passed++;
    }
  }
  assert.equal(passed, 171);
});

test(`public API (getDetail through RiviumFlags) passes every evaluation vector (${total})`, async () => {
  let passed = 0;
  for (const suite of vectors.suites) {
    const { fetch } = mockFetch(() => ({
      status: 200,
      body: { schemaVersion: 2, environment: null, generatedAt: new Date().toISOString(), flags: suite.flags, segments: suite.segments },
      headers: { etag: '"s2-x"' },
    }));
    const flags = new RiviumFlags({ apiKey: 'rv_test_x', serverSecret: 'rv_srv_x', fetch, logger: silentLogger, pollIntervalSeconds: 0 });
    await flags.init();
    for (const c of suite.cases) {
      const d = flags.getDetail(c.flagKey, c.context, 'DEFAULT');
      assert.deepStrictEqual(
        { enabled: d.enabled, value: d.value, variant: d.variant, reason: d.reason },
        c.expected,
        `${suite.name} / ${c.name}`,
      );
      assert.equal(flags.isEnabled(c.flagKey, c.context, !c.expected.enabled), c.expected.enabled);
      passed++;
    }
    await flags.close();
  }
  assert.equal(passed, 171);
});
