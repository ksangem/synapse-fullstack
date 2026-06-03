/**
 * Circuit breaker (T-04).
 *
 * Guards calls to one destination. After `failureThreshold` consecutive
 * failures the breaker OPENS and fast-fails every call for `cooldownMs`
 * (protecting the system from hammering a dead endpoint). After the cooldown it
 * goes HALF-OPEN and lets a limited number of trial calls through; enough
 * successes CLOSE it, any failure re-OPENS it. The clock is injectable.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open. Default 5. */
  failureThreshold?: number;
  /** How long to stay open before allowing a trial call, in ms. Default 30000. */
  cooldownMs?: number;
  /** Successful trial calls needed in half-open to close. Default 1. */
  successThreshold?: number;
  /** Injectable clock (ms). Default Date.now. */
  now?: () => number;
}

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Circuit is open; retry after ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private halfOpenSuccesses = 0;
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly successThreshold: number;
  private readonly now: () => number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.successThreshold = options.successThreshold ?? 1;
    this.now = options.now ?? Date.now;
  }

  /** Current state, accounting for an elapsed cooldown (open → half-open). */
  get currentState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
      this.halfOpenSuccesses = 0;
    }
    return this.state;
  }

  /** Whether a call may proceed right now. */
  canAttempt(): boolean {
    return this.currentState !== 'open';
  }

  private msUntilHalfOpen(): number {
    return Math.max(0, this.cooldownMs - (this.now() - this.openedAt));
  }

  recordSuccess(): void {
    if (this.currentState === 'half-open') {
      this.halfOpenSuccesses++;
      if (this.halfOpenSuccesses >= this.successThreshold) this.close();
    } else {
      this.failures = 0;
    }
  }

  recordFailure(): void {
    if (this.currentState === 'half-open') {
      this.trip(); // a trial failure re-opens immediately
      return;
    }
    this.failures++;
    if (this.failures >= this.failureThreshold) this.trip();
  }

  private trip(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.halfOpenSuccesses = 0;
  }

  private close(): void {
    this.state = 'closed';
    this.failures = 0;
    this.halfOpenSuccesses = 0;
  }

  /**
   * Run `fn` under breaker protection. Throws CircuitOpenError without calling
   * `fn` when open. Records the outcome to drive state transitions.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canAttempt()) {
      throw new CircuitOpenError(this.msUntilHalfOpen());
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }
}
