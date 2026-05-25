/**
 * Dead-letter repository — stores failed messages for retry.
 * Includes auto-replay BackgroundService logic (5-min scan).
 */

import { eq, and, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { deadLetterEntries } from '../db/schema';
import type { MessageEnvelope } from './interfaces';

const MAX_RETRIES = 5;
const REPLAY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class DeadLetterRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  /**
   * Insert a failed message into the dead letter queue.
   */
  async insert(
    envelope: MessageEnvelope,
    destConnectorId: string,
    error: string,
  ): Promise<string> {
    const [row] = await this.db
      .insert(deadLetterEntries)
      .values({
        orgId: envelope.orgId,
        messageId: envelope.messageId,
        correlationId: envelope.correlationId,
        topic: envelope.topic,
        destConnectorId,
        envelopeJson: envelope,
        error,
        retryCount: 0,
        status: 'failed',
      })
      .returning({ id: deadLetterEntries.id });

    return row.id;
  }

  /**
   * Get all entries eligible for replay (status=failed, retryCount < MAX_RETRIES).
   */
  async getReplayable(): Promise<Array<{
    id: string;
    envelope: MessageEnvelope;
    destConnectorId: string;
    retryCount: number;
  }>> {
    const rows = await this.db
      .select({
        id: deadLetterEntries.id,
        envelopeJson: deadLetterEntries.envelopeJson,
        destConnectorId: deadLetterEntries.destConnectorId,
        retryCount: deadLetterEntries.retryCount,
      })
      .from(deadLetterEntries)
      .where(
        and(
          eq(deadLetterEntries.status, 'failed'),
          lt(deadLetterEntries.retryCount, MAX_RETRIES),
        ),
      );

    return rows.map((r) => ({
      id: r.id,
      envelope: r.envelopeJson as unknown as MessageEnvelope,
      destConnectorId: r.destConnectorId,
      retryCount: r.retryCount,
    }));
  }

  /**
   * Increment retry count and update last replayed timestamp.
   */
  async markRetried(id: string): Promise<void> {
    await this.db
      .update(deadLetterEntries)
      .set({
        retryCount: sql`${deadLetterEntries.retryCount} + 1`,
        lastReplayedAt: new Date(),
      })
      .where(eq(deadLetterEntries.id, id));
  }

  /**
   * Mark an entry as resolved (successfully replayed).
   */
  async markResolved(id: string): Promise<void> {
    await this.db
      .update(deadLetterEntries)
      .set({ status: 'done' })
      .where(eq(deadLetterEntries.id, id));
  }

  /**
   * Mark an entry as poisoned (exceeded max retries).
   */
  async markPoisoned(id: string): Promise<void> {
    await this.db
      .update(deadLetterEntries)
      .set({ status: 'poisoned' })
      .where(eq(deadLetterEntries.id, id));
  }

  /**
   * Get the replay interval in milliseconds.
   */
  get replayIntervalMs(): number {
    return REPLAY_INTERVAL_MS;
  }

  /**
   * Get the maximum number of retries before poisoning.
   */
  get maxRetries(): number {
    return MAX_RETRIES;
  }
}
