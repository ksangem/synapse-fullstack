/**
 * Retry with exponential backoff (T-04).
 *
 * Wraps a flaky async operation (e.g. a destination dispatch) so transient
 * failures are re-attempted with a growing delay between tries, optionally
 * jittered to avoid a thundering herd. The sleep and RNG are injectable so
 * tests stay fast and deterministic.
 */

export interface RetryPolicy {
  /** Total attempts including the first. 1 = no retry. */
  maxAttempts: number;
  /** Delay before the 2nd attempt, in ms. */
  baseDelayMs: number;
  /** Upper bound on any single delay, in ms. */
  maxDelayMs: number;
  /** Exponential growth factor (e.g. 2 → 1x, 2x, 4x…). */
  factor: number;
  /** Randomize each delay to 50–100% of its value. */
  jitter: boolean;
}

/** Default: a single attempt (no retry) — callers opt in to retrying. */
export const NO_RETRY: RetryPolicy = {
  maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, factor: 2, jitter: false,
};

/** A sensible retrying policy: 4 attempts, 100ms → 800ms, jittered. */
export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 5000, factor: 2, jitter: true,
};

/**
 * Compute the backoff delay (ms) before the attempt after a failed `attempt`
 * (1-based). Capped at maxDelayMs; jitter shrinks it to 50–100% when enabled.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, rnd: () => number = Math.random): number {
  const raw = policy.baseDelayMs * Math.pow(policy.factor, Math.max(0, attempt - 1));
  let delay = Math.min(raw, policy.maxDelayMs);
  if (policy.jitter) delay *= 0.5 + rnd() * 0.5;
  return Math.floor(delay);
}

export interface RetryDeps {
  /** Sleep for ms (default: setTimeout). Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** RNG for jitter (default: Math.random). Injectable for tests. */
  rnd?: () => number;
  /** Called before each backoff wait, with the failed attempt number. */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** When false, stop retrying immediately (e.g. circuit open). Default: always retry. */
  shouldRetry?: (error: Error) => boolean;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` up to policy.maxAttempts times, backing off between failures.
 * Resolves with the first success; rejects with the last error if all fail.
 * `fn` receives the 1-based attempt number.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps = {},
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const err = error as Error;
      const isLast = attempt >= policy.maxAttempts;
      if (isLast || (deps.shouldRetry && !deps.shouldRetry(err))) break;
      const delay = backoffDelay(attempt, policy, deps.rnd);
      deps.onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }

  throw lastError;
}
