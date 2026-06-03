import { describe, it, expect, vi } from 'vitest';
import { withRetry, backoffDelay, NO_RETRY } from '../hub/retry';
import { CircuitBreaker, CircuitOpenError } from '../hub/circuit-breaker';
import { DlqReplayService } from '../hub/dlq-replay-service';
import type { DlqPort, ReplayableEntry } from '../hub/dlq-replay-service';
import type { MessageEnvelope } from '../hub/interfaces';

// ─── retry + backoff ────────────────────────────────────────
describe('retry / backoff', () => {
  const noSleep = vi.fn(async () => {});

  it('backoffDelay grows exponentially and caps at maxDelay', () => {
    const p = { maxAttempts: 9, baseDelayMs: 100, maxDelayMs: 500, factor: 2, jitter: false };
    expect(backoffDelay(1, p)).toBe(100);
    expect(backoffDelay(2, p)).toBe(200);
    expect(backoffDelay(3, p)).toBe(400);
    expect(backoffDelay(4, p)).toBe(500); // capped
  });

  it('jitter shrinks the delay to 50–100% of nominal', () => {
    const p = { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000, factor: 2, jitter: true };
    expect(backoffDelay(1, p, () => 0)).toBe(50);   // 50%
    expect(backoffDelay(1, p, () => 1)).toBe(100);  // 100%
  });

  it('returns immediately on first success', async () => {
    const fn = vi.fn(async () => 'ok');
    const out = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50, factor: 2, jitter: false }, { sleep: noSleep });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries with backoff then succeeds', async () => {
    let n = 0;
    const fn = vi.fn(async () => { if (++n < 3) throw new Error('flaky'); return 'ok'; });
    const sleeps: number[] = [];
    const sleep = vi.fn(async (ms: number) => { sleeps.push(ms); });
    const out = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, factor: 2, jitter: false }, { sleep });
    expect(out).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]); // backoff before attempts 2 and 3
  });

  it('throws the last error after exhausting attempts', async () => {
    const fn = vi.fn(async () => { throw new Error('down'); });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, factor: 2, jitter: false }, { sleep: noSleep }))
      .rejects.toThrow('down');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('shouldRetry=false stops immediately', async () => {
    const fn = vi.fn(async () => { throw new Error('fatal'); });
    await expect(withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, factor: 2, jitter: false }, { sleep: noSleep, shouldRetry: () => false }))
      .rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('NO_RETRY makes a single attempt', async () => {
    const fn = vi.fn(async () => { throw new Error('x'); });
    await expect(withRetry(fn, NO_RETRY, { sleep: noSleep })).rejects.toThrow('x');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ─── circuit breaker ────────────────────────────────────────
describe('circuit breaker', () => {
  const fail = () => Promise.reject(new Error('boom'));
  const ok = () => Promise.resolve('ok');

  it('opens after the failure threshold and fast-fails', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => 1000 });
    await expect(cb.exec(fail)).rejects.toThrow('boom');
    expect(cb.currentState).toBe('closed');
    await expect(cb.exec(fail)).rejects.toThrow('boom'); // 2nd failure trips
    expect(cb.currentState).toBe('open');

    const guarded = vi.fn(ok);
    await expect(cb.exec(guarded)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(guarded).not.toHaveBeenCalled(); // fast-fail, did not call fn
  });

  it('transitions to half-open after cooldown and closes on success', async () => {
    let t = 1000;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 50, successThreshold: 1, now: () => t });
    await expect(cb.exec(fail)).rejects.toThrow(); // trips open
    expect(cb.currentState).toBe('open');

    t += 50; // cooldown elapsed
    expect(cb.currentState).toBe('half-open');
    await expect(cb.exec(ok)).resolves.toBe('ok'); // trial success closes it
    expect(cb.currentState).toBe('closed');
  });

  it('a failed trial in half-open re-opens the breaker', async () => {
    let t = 0;
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10, now: () => t });
    await expect(cb.exec(fail)).rejects.toThrow(); // open
    t += 10;
    expect(cb.currentState).toBe('half-open');
    await expect(cb.exec(fail)).rejects.toThrow('boom'); // trial fails → re-open
    expect(cb.currentState).toBe('open');
  });

  it('a success in closed state resets the failure count', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, now: () => 0 });
    await cb.exec(fail).catch(() => {});
    await cb.exec(fail).catch(() => {});
    await cb.exec(ok); // resets
    await cb.exec(fail).catch(() => {});
    await cb.exec(fail).catch(() => {});
    expect(cb.currentState).toBe('closed'); // only 2 consecutive since reset
  });
});

// ─── DLQ replay service ─────────────────────────────────────
function env(messageId: string): MessageEnvelope {
  return {
    messageId, correlationId: 'c', orgId: 'o', sourceConnectorId: 's',
    topic: 'a.b.c', sequenceNo: 1, timestamp: '2026-01-01T00:00:00Z', checksum: 'x', payload: {},
  };
}

function fakeDlq(entries: ReplayableEntry[], maxRetries = 5) {
  const state = new Map(entries.map((e) => [e.id, { ...e, status: 'failed' as string }]));
  const port: DlqPort & { state: typeof state } = {
    state,
    maxRetries,
    getReplayable: vi.fn(async () =>
      [...state.values()].filter((e) => e.status === 'failed').map((e) => ({
        id: e.id, envelope: e.envelope, destConnectorId: e.destConnectorId, retryCount: e.retryCount,
      })),
    ),
    markResolved: vi.fn(async (id: string) => { state.get(id)!.status = 'done'; }),
    markRetried: vi.fn(async (id: string) => { const e = state.get(id)!; e.retryCount++; }),
    markPoisoned: vi.fn(async (id: string) => { state.get(id)!.status = 'poisoned'; }),
  };
  return port;
}

describe('DlqReplayService', () => {
  it('resolves on success, retries on failure, poisons exhausted entries', async () => {
    const dlq = fakeDlq([
      { id: 'e1', envelope: env('m1'), destConnectorId: 'good', retryCount: 0 },
      { id: 'e2', envelope: env('m2'), destConnectorId: 'bad', retryCount: 1 },
      { id: 'e3', envelope: env('m3'), destConnectorId: 'good', retryCount: 5 }, // == maxRetries → poison
    ]);
    const redeliver = vi.fn(async (_e: MessageEnvelope, dest: string) => {
      if (dest === 'bad') throw new Error('still down');
    });

    const svc = new DlqReplayService(dlq, redeliver);
    const summary = await svc.replayOnce();

    expect(summary).toEqual({ scanned: 3, resolved: 1, retried: 1, poisoned: 1 });
    expect(dlq.markResolved).toHaveBeenCalledWith('e1');
    expect(dlq.markRetried).toHaveBeenCalledWith('e2');
    expect(dlq.markPoisoned).toHaveBeenCalledWith('e3');
    expect(redeliver).toHaveBeenCalledTimes(2); // e3 poisoned without a redelivery attempt
  });

  it('auto-replay timer fires replayOnce', async () => {
    const dlq = fakeDlq([{ id: 'e1', envelope: env('m1'), destConnectorId: 'good', retryCount: 0 }]);
    const redeliver = vi.fn(async () => {});
    let fire: (() => void) | null = null;
    const svc = new DlqReplayService(dlq, redeliver, {
      intervalMs: 1000,
      setTimer: (fn) => { fire = fn; return 1; },
      clearTimer: vi.fn(),
    });

    svc.start();
    expect(svc.isRunning).toBe(true);
    fire!();                                  // simulate the timer tick
    await vi.waitFor(() => expect(dlq.getReplayable).toHaveBeenCalled());
    svc.stop();
    expect(svc.isRunning).toBe(false);
  });
});
