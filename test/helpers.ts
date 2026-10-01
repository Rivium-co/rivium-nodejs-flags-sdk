import * as fs from 'fs';
import * as path from 'path';

export interface VectorCase {
  name: string;
  flagKey: string;
  context: { userId?: string | null; anonymousId?: string | null; attributes?: Record<string, any> };
  expected: { enabled: boolean; value: any; variant: string | null; reason: string };
}
export interface VectorSuite {
  name: string;
  flags: any[];
  segments: any[];
  cases: VectorCase[];
}
export interface Vectors {
  hashVectors: Array<{ flagKey: string; salt: string; purpose: 'rollout' | 'variant'; id: string; bucket: number }>;
  suites: VectorSuite[];
}

export function loadVectors(): Vectors {
  // Works from the source tree and from the compiled .test-build tree.
  const candidates = [
    path.join(__dirname, 'fixtures', 'sdk-test-vectors.json'),
    path.join(__dirname, '..', '..', 'test', 'fixtures', 'sdk-test-vectors.json'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error('sdk-test-vectors.json not found');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

export type Responder = (call: Call) => { status: number; body?: any; headers?: Record<string, string> } | Promise<never>;

/** A fetch double that records calls and answers with `responder`. */
export function mockFetch(responder: Responder) {
  const calls: Call[] = [];
  const fn = (async (url: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = String(v);
    const call: Call = {
      url: String(url),
      method: init.method || 'GET',
      headers,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = await responder(call);
    const h = new Headers(r.headers || {});
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: h });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
