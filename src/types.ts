/**
 * Types of the Rivium Flags server SDK.
 */

export type ValueType = 'boolean' | 'string' | 'number' | 'json';

/** A JSON value (what `json` flags serve). */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface Condition {
  attribute: string;
  operator: string;
  value: any;
}

export interface Group {
  operator: 'AND' | 'OR';
  rules: Array<Condition | Group>;
}

export interface Variant {
  key: string;
  value: any;
  weight: number;
}

export interface Prerequisite {
  flagKey: string;
  expectedValue?: any;
}

/** One flag as served by `GET /server/v2/flags` (environment overrides already merged). */
export interface FlagConfig {
  key: string;
  valueType: ValueType;
  enabled: boolean;
  rolloutPercentage: number;
  salt: string;
  rules: Group | null;
  variants: Variant[];
  offValue: any;
  prerequisites: Prerequisite[];
  version: number;
}

export interface SegmentConfig {
  key: string;
  rules: Group | null;
}

/** Body of `GET /server/v2/flags`. */
export interface ServerFlagsPayload {
  schemaVersion: number;
  environment: string | null;
  generatedAt?: string;
  flags: FlagConfig[];
  segments: SegmentConfig[];
}

/** Attribute values: string, finite number, boolean, null, or an array of those. */
export type AttributeValue = string | number | boolean | null | Array<string | number | boolean | null>;

/** Who a flag is evaluated for. At least one of `userId` / `anonymousId` is needed for rollouts and splits. */
export interface EvaluationContext {
  userId?: string | null;
  anonymousId?: string | null;
  attributes?: Record<string, AttributeValue> | null;
}

export type Reason =
  | 'ON'
  | 'VARIANT'
  | 'DISABLED'
  | 'PREREQUISITE_FAILED'
  | 'NOT_TARGETED'
  | 'OUTSIDE_ROLLOUT'
  | 'NO_BUCKETING_ID'
  | 'ERROR'
  | 'FLAG_NOT_FOUND'
  | 'NOT_READY'
  | 'TYPE_MISMATCH';

/** Result of the evaluation engine for one flag. */
export interface EvalResult {
  key: string;
  valueType: ValueType;
  enabled: boolean;
  value: any;
  variant: string | null;
  reason: Reason;
  version: number;
}

/** What `getDetail` returns: the served value (or your default) and why. */
export interface FlagDetail<T = unknown> {
  key: string;
  value: T;
  enabled: boolean;
  variant: string | null;
  reason: Reason;
  /** Flag version, null when the flag was not found or rules are not loaded yet. */
  version: number | null;
  /** The flag's value type, null when the flag was not found or rules are not loaded yet. */
  valueType: ValueType | null;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RiviumFlagsConfig {
  /** Project key (`rv_live_…` / `rv_test_…`). */
  apiKey: string;
  /** Server secret (`rv_srv_…`). Backend only, never ship it to a browser or an app. */
  serverSecret: string;
  /** Environment key (`production`, `staging`, …). Omitted = the Default layer. */
  environment?: string;
  /** Default `https://flags.rivium.co`. */
  baseUrl?: string;
  /** Seconds between rule refreshes. Default 30, minimum 10. 0 turns polling off. */
  pollIntervalSeconds?: number;
  /** `init()` resolves after the first successful fetch or after this many ms. Default 5000. */
  initTimeoutMs?: number;
  /** Send aggregated evaluation counts to `POST /server/v2/usage` (not billed). Default false. */
  sendUsage?: boolean;
  /** Log debug messages. Default false. */
  debug?: boolean;
  /** Custom logger. Default: console with a `[Rivium Flags]` prefix. */
  logger?: Logger;
  /** Custom fetch (tests, proxies). Default: the global fetch. */
  fetch?: typeof fetch;
}

export type RiviumFlagsEvent = 'ready' | 'update' | 'error';

export interface RiviumFlagsEventPayload {
  ready: { flagCount: number };
  update: { flagCount: number };
  error: { status?: number; code?: string; message: string };
}

export type RiviumFlagsListener<E extends RiviumFlagsEvent> = (payload: RiviumFlagsEventPayload[E]) => void;
