/** Retry delays: Retry-After (default 5 s), then ×2 up to 5 min, ±20 % jitter. */

export const DEFAULT_RETRY_SECONDS = 5;
export const MAX_BACKOFF_SECONDS = 300;

/**
 * Delay in ms before the next attempt.
 * @param failures consecutive failures so far (1 = first failure)
 * @param retryAfterSeconds the server's Retry-After, if any
 * @param random injectable for tests
 */
export function backoffDelayMs(
  failures: number,
  retryAfterSeconds?: number | null,
  random: () => number = Math.random,
): number {
  const base = retryAfterSeconds != null && retryAfterSeconds > 0 ? retryAfterSeconds : DEFAULT_RETRY_SECONDS;
  const exp = Math.min(base * Math.pow(2, Math.max(0, failures - 1)), MAX_BACKOFF_SECONDS);
  const jitter = 1 + (random() * 0.4 - 0.2);
  // Never retry earlier than the server asked for.
  const floor = retryAfterSeconds != null && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 0;
  return Math.max(Math.round(exp * jitter * 1000), floor);
}

/** Retry-After as seconds (delta-seconds or an HTTP date), or null. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}
