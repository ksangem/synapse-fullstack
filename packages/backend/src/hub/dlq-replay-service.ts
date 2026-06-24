/**
 * Dead-letter replay service (T-04).
 *
 * Drains the dead-letter queue: it scans replayable entries and re-attempts
 * delivery. A success resolves the entry; a failure bumps its retry count;
 * an entry past maxRetries is poisoned (parked permanently for a human).
 *
 *   - replayOnce()  → manual / single pass (e.g. after fixing a destination)
 *   - start()/stop() → automatic periodic replay on a timer
 *
 * The DeadLetterRepository satisfies DlqPort structurally; redelivery is a
 * caller-supplied function so this service stays decoupled from the bus.
 */

import type { MessageEnvelope } from './interfaces';

export interface ReplayableEntry {
  id: string;
  envelope: MessageEnvelope;
  destConnectorId: string;
  retryCount: number;
}

export interface DlqPort {
  getReplayable(): Promise<ReplayableEntry[]>;
  markRetried(id: string): Promise<void>;
  markResolved(id: string): Promise<void>;
  markPoisoned(id: string): Promise<void>;
  readonly maxRetries: number;
}

/** Re-attempt delivery of one dead-lettered envelope to its destination. */
export type Redeliver = (envelope: MessageEnvelope, destConnectorId: string) => Promise<void>;

export interface ReplaySummary {
  scanned: number;
  resolved: number;
  retried: number;
  poisoned: number;
}

export interface DlqReplayOptions {
  /** Auto-replay interval in ms. Default 5 minutes. */
  intervalMs?: number;
  /** Injectable timer setter (returns an opaque handle). Default setInterval. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Injectable timer clearer. Default clearInterval. */
  clearTimer?: (handle: unknown) => void;
  /** Called when a periodic pass throws (so the loop never dies silently). */
  onError?: (error: Error) => void;
}

export class DlqReplayService {
  private timer: unknown = null;
  private running = false;

  constructor(
    private readonly dlq: DlqPort,
    private readonly redeliver: Redeliver,
    private readonly options: DlqReplayOptions = {},
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * One replay pass over all currently-replayable entries.
   * Safe to call manually at any time.
   */
  async replayOnce(): Promise<ReplaySummary> {
    const entries = await this.dlq.getReplayable();
    const summary: ReplaySummary = { scanned: entries.length, resolved: 0, retried: 0, poisoned: 0 };

    for (const entry of entries) {
      // Exhausted its budget — park it permanently.
      if (entry.retryCount >= this.dlq.maxRetries) {
        await this.dlq.markPoisoned(entry.id);
        summary.poisoned++;
        continue;
      }

      try {
        await this.redeliver(entry.envelope, entry.destConnectorId);
        await this.dlq.markResolved(entry.id);
        summary.resolved++;
      } catch (err) {
        // Surface why a replay attempt failed — a silent catch here is exactly what made
        // "retried: 394, resolved: 0" impossible to diagnose.
        console.error(`[DLQ replay] ${entry.id} → ${entry.destConnectorId} failed:`,
          err instanceof Error ? err.message : err);
        await this.dlq.markRetried(entry.id);
        summary.retried++;
      }
    }

    return summary;
  }

  /**
   * Replay a single dead-letter entry by id (manual operator action).
   * Returns the outcome, or 'not-found' if it isn't currently replayable.
   */
  async replayOne(id: string): Promise<'resolved' | 'retried' | 'poisoned' | 'not-found'> {
    const entry = (await this.dlq.getReplayable()).find((e) => e.id === id);
    if (!entry) return 'not-found';

    if (entry.retryCount >= this.dlq.maxRetries) {
      await this.dlq.markPoisoned(entry.id);
      return 'poisoned';
    }
    try {
      await this.redeliver(entry.envelope, entry.destConnectorId);
      await this.dlq.markResolved(entry.id);
      return 'resolved';
    } catch (err) {
      console.error(`[DLQ replay] ${entry.id} → ${entry.destConnectorId} failed:`,
        err instanceof Error ? err.message : err);
      await this.dlq.markRetried(entry.id);
      return 'retried';
    }
  }

  /** Begin automatic periodic replay. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const intervalMs = this.options.intervalMs ?? 5 * 60 * 1000;
    const setTimer = this.options.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = setTimer(() => {
      void this.replayOnce().catch((err) => this.options.onError?.(err as Error));
    }, intervalMs);
  }

  /** Stop automatic replay. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    const clearTimer = this.options.clearTimer ?? ((h) => clearInterval(h as NodeJS.Timeout));
    if (this.timer !== null) clearTimer(this.timer);
    this.timer = null;
  }
}
