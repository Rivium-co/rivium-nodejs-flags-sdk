/**
 * The Rivium Flags evaluation engine. Pure and
 * synchronous; a port of the server engine, checked against the shared test
 * vectors (test/fixtures/sdk-test-vectors.json).
 */
import { sha256Hex } from './hash';
import {
  Condition,
  EvalResult,
  EvaluationContext,
  FlagConfig,
  Group,
  Reason,
  SegmentConfig,
} from './types';

export const MAX_PREREQUISITE_DEPTH = 10;

/** Flags and segments of one environment, indexed by key. */
export interface Snapshot {
  flags: Map<string, FlagConfig>;
  segments: Map<string, SegmentConfig>;
}

export function buildSnapshot(flags: FlagConfig[], segments: SegmentConfig[]): Snapshot {
  return {
    flags: new Map(flags.map((f) => [f.key, f])),
    segments: new Map(segments.map((s) => [s.key, s])),
  };
}

/** 0…9999: SHA-256 of `flagKey.salt.purpose.id`, first 32 bits mod 10000. */
export function bucket(flagKey: string, salt: string, purpose: 'rollout' | 'variant', id: string): number {
  const digest = sha256Hex(`${flagKey}.${salt}.${purpose}.${id}`);
  return parseInt(digest.slice(0, 8), 16) % 10000;
}

/** `userId` when non-empty, else `anonymousId` when non-empty, else null. */
export function bucketingId(ctx: EvaluationContext): string | null {
  if (typeof ctx.userId === 'string' && ctx.userId.length > 0) return ctx.userId;
  if (typeof ctx.anonymousId === 'string' && ctx.anonymousId.length > 0) return ctx.anonymousId;
  return null;
}

function attributeLookup(ctx: EvaluationContext): (name: string) => unknown {
  const attrs = ctx.attributes || {};
  return (name: string) => {
    if (name === 'userId') return ctx.userId ?? undefined;
    if (name === 'anonymousId') return ctx.anonymousId ?? undefined;
    return Object.prototype.hasOwnProperty.call(attrs, name) ? (attrs as any)[name] : undefined;
  };
}

/** JSON structural equality; numbers compared numerically; object key order ignored. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as any)[k], (b as any)[k]));
}

function off(flag: FlagConfig, reason: Reason): EvalResult {
  return {
    key: flag.key,
    valueType: flag.valueType,
    enabled: false,
    value: flag.offValue ?? false,
    variant: null,
    reason,
    version: flag.version,
  };
}

function on(flag: FlagConfig, value: any, variant: string | null, reason: Reason): EvalResult {
  return { key: flag.key, valueType: flag.valueType, enabled: true, value, variant, reason, version: flag.version };
}

/** Evaluate one flag. Never throws: a malformed config gives the off value with reason `ERROR`. */
export function evaluate(flag: FlagConfig, ctx: EvaluationContext, snapshot: Snapshot): EvalResult {
  try {
    return evaluateInner(flag, ctx || {}, snapshot, [], new Map());
  } catch {
    return off(flag, 'ERROR');
  }
}

function evaluateInner(
  flag: FlagConfig,
  ctx: EvaluationContext,
  snapshot: Snapshot,
  path: string[],
  segmentCache: Map<string, boolean>,
): EvalResult {
  // 2. Off
  if (!flag.enabled) return off(flag, 'DISABLED');

  // 3. Prerequisites (same environment, same context)
  const prerequisites = flag.prerequisites || [];
  if (prerequisites.length > 0) {
    const nextPath = [...path, flag.key];
    if (nextPath.length > MAX_PREREQUISITE_DEPTH) return off(flag, 'PREREQUISITE_FAILED');
    for (const pre of prerequisites) {
      const preFlag = snapshot.flags.get(pre.flagKey);
      if (!preFlag || nextPath.includes(pre.flagKey)) return off(flag, 'PREREQUISITE_FAILED');
      const r = evaluateInner(preFlag, ctx, snapshot, nextPath, segmentCache);
      if (r.reason === 'ERROR') return off(flag, 'PREREQUISITE_FAILED');
      const passed =
        pre.expectedValue === undefined || pre.expectedValue === null
          ? r.enabled
          : deepEqual(r.value, pre.expectedValue);
      if (!passed) return off(flag, 'PREREQUISITE_FAILED');
    }
  }

  // 4. Targeting rules
  if (flag.rules && countConditions(flag.rules) > 0) {
    const attr = attributeLookup(ctx);
    const segment = (key: string): boolean => {
      const cached = segmentCache.get(key);
      if (cached !== undefined) return cached;
      const seg = snapshot.segments.get(key);
      // Segment rules never reference segments; a missing segment never matches.
      const result = !!seg && (!seg.rules || matchGroup(seg.rules, attr, () => false));
      segmentCache.set(key, result);
      return result;
    };
    if (!matchGroup(flag.rules, attr, segment)) return off(flag, 'NOT_TARGETED');
  }

  const id = bucketingId(ctx);

  // 5. Rollout
  const rollout = Number(flag.rolloutPercentage);
  if (!(rollout >= 100)) {
    if (!(rollout > 0)) return off(flag, 'OUTSIDE_ROLLOUT');
    if (id === null) return off(flag, 'NO_BUCKETING_ID');
    if (bucket(flag.key, flag.salt, 'rollout', id) >= rollout * 100) return off(flag, 'OUTSIDE_ROLLOUT');
  }

  // 6. Variants
  const variants = flag.variants || [];
  if (variants.length > 0) {
    const sole = variants.find((v) => v.weight >= 100);
    if (sole) return on(flag, sole.value, sole.key, 'VARIANT');
    if (id === null) return off(flag, 'NO_BUCKETING_ID');
    const b = bucket(flag.key, flag.salt, 'variant', id);
    let cumulative = 0;
    for (const v of variants) {
      cumulative += Number(v.weight) * 100;
      if (b < cumulative) return on(flag, v.value, v.key, 'VARIANT');
    }
    const first = variants[0];
    return on(flag, first.value, first.key, 'VARIANT');
  }

  // 7. On
  return on(flag, true, null, 'ON');
}

// ── Rules ─────────────────────────────────────────────────────────────

const OPERATORS = new Set([
  'equals',
  'not_equals',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
  'greater_than',
  'greater_than_or_equal',
  'less_than',
  'less_than_or_equal',
  'regex',
  'exists',
  'in_segment',
  'not_in_segment',
]);

/** The positive operator a negative one negates. */
const NEGATIONS: Record<string, string> = {
  not_equals: 'equals',
  not_in: 'in',
  not_contains: 'contains',
  not_in_segment: 'in_segment',
};

function isGroup(item: any): item is Group {
  return !!item && typeof item === 'object' && Array.isArray(item.rules);
}

export function countConditions(group: Group | null): number {
  if (!group) return 0;
  let n = 0;
  for (const item of group.rules) n += isGroup(item) ? countConditions(item) : 1;
  return n;
}

const NUMERIC_STRING = /^-?\d+(\.\d+)?$/;

export function numeric(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && NUMERIC_STRING.test(x)) return Number(x);
  return null;
}

export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const ta = typeof a;
  const tb = typeof b;
  if (ta === tb && (ta === 'string' || ta === 'number' || ta === 'boolean')) return a === b;
  if (ta === 'number' && tb === 'string') return numeric(b) !== null && numeric(b) === a;
  if (ta === 'string' && tb === 'number') return numeric(a) !== null && numeric(a) === b;
  if (ta === 'boolean' && tb === 'string') return (b === 'true' && a === true) || (b === 'false' && a === false);
  if (ta === 'string' && tb === 'boolean') return (a === 'true' && b === true) || (a === 'false' && b === false);
  return false;
}

type SegmentMatcher = (segmentKey: string) => boolean;

function matchGroup(group: Group, attr: (name: string) => unknown, segment: SegmentMatcher): boolean {
  if (group.rules.length === 0) return true;
  if (group.operator === 'OR') return group.rules.some((item) => matchItem(item, attr, segment));
  return group.rules.every((item) => matchItem(item, attr, segment));
}

function matchItem(item: Condition | Group, attr: (name: string) => unknown, segment: SegmentMatcher): boolean {
  return isGroup(item) ? matchGroup(item, attr, segment) : matchCondition(item, attr, segment);
}

function matchCondition(c: Condition, attr: (name: string) => unknown, segment: SegmentMatcher): boolean {
  const op = typeof c.operator === 'string' ? c.operator : '';
  const positive = NEGATIONS[op];
  if (positive) return !matchCondition({ ...c, operator: positive }, attr, segment);

  if (op === 'in_segment') {
    const keys = Array.isArray(c.value) ? c.value : [c.value];
    return keys.some((k) => typeof k === 'string' && segment(k));
  }
  if (!OPERATORS.has(op)) return false;

  const userValue = attr(c.attribute);
  if (op === 'exists') {
    const present = userValue !== undefined && userValue !== null;
    return c.value === false ? !present : present;
  }
  if (Array.isArray(userValue)) return userValue.some((v) => matchScalar(op, v, c.value));
  return matchScalar(op, userValue, c.value);
}

function matchScalar(op: string, userValue: unknown, ruleValue: any): boolean {
  if (userValue === undefined || userValue === null) return false;
  switch (op) {
    case 'equals':
      return looseEquals(userValue, ruleValue);
    case 'in': {
      // Canonical rules carry an array; a legacy comma-separated string is split like the server does.
      const list = typeof ruleValue === 'string' ? ruleValue.split(',').map((s) => s.trim()) : ruleValue;
      return Array.isArray(list) && list.some((item) => looseEquals(userValue, item));
    }
    case 'contains':
      return typeof userValue === 'string' && ruleValue != null && userValue.includes(String(ruleValue));
    case 'starts_with':
      return typeof userValue === 'string' && ruleValue != null && userValue.startsWith(String(ruleValue));
    case 'ends_with':
      return typeof userValue === 'string' && ruleValue != null && userValue.endsWith(String(ruleValue));
    case 'greater_than':
    case 'greater_than_or_equal':
    case 'less_than':
    case 'less_than_or_equal': {
      const a = numeric(userValue);
      const b = numeric(ruleValue);
      if (a === null || b === null) return false;
      if (op === 'greater_than') return a > b;
      if (op === 'greater_than_or_equal') return a >= b;
      if (op === 'less_than') return a < b;
      return a <= b;
    }
    case 'regex':
      return typeof userValue === 'string' && typeof ruleValue === 'string' && regexFinds(ruleValue, userValue);
    default:
      return false;
  }
}

// Patterns are validated on save (≤ 512 chars, no catastrophic shapes), so they run natively.
const REGEX_CACHE_MAX = 500;
const regexCache = new Map<string, RegExp | null>();

function regexFinds(pattern: string, value: string): boolean {
  let re = regexCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(pattern);
    } catch {
      re = null; // invalid pattern → no match
    }
    if (regexCache.size >= REGEX_CACHE_MAX) regexCache.delete(regexCache.keys().next().value as string);
    regexCache.set(pattern, re);
  }
  return re !== null && re.test(value);
}
