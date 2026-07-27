/**
 * Dead-letter repository — stores failed messages for retry.
 * Includes auto-replay BackgroundService logic (5-min scan).
 */

import { eq, and, lt, desc, sql } from 'drizzle-orm';
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
   * Shelve a message that matched NO live subscription (unroutable). Distinct from a
   * delivery failure: there is no destination to retry against, so it is stored as
   * `poisoned` (terminal — the 5-min auto-replay scanner only picks `failed`, so this
   * is never futilely re-dispatched) under a sentinel destConnectorId. It surfaces in
   * the Monitor DLQ list so inbound data (e.g. a webhook with no subscription yet) is
   * visible and accounted for instead of being silently dropped.
   */
  async insertUnrouted(envelope: MessageEnvelope, reason: string): Promise<string> {
    const [row] = await this.db
      .insert(deadLetterEntries)
      .values({
        orgId: envelope.orgId,
        messageId: envelope.messageId,
        correlationId: envelope.correlationId,
        topic: envelope.topic,
        destConnectorId: '(unrouted)',
        envelopeJson: envelope,
        error: reason,
        retryCount: 0,
        status: 'poisoned',
      })
      .returning({ id: deadLetterEntries.id });

    return row.id;
  }

  /**
   * List recent dead-letter entries for display (newest first), all statuses.
   */
  async list(limit = 50): Promise<Array<{
    id: string;
    messageId: string;
    topic: string;
    destConnectorId: string;
    error: string;
    retryCount: number;
    status: string;
    createdAt: Date;
    lastReplayedAt: Date | null;
  }>> {
    return this.db
      .select({
        id: deadLetterEntries.id,
        messageId: deadLetterEntries.messageId,
        topic: deadLetterEntries.topic,
        destConnectorId: deadLetterEntries.destConnectorId,
        error: deadLetterEntries.error,
        retryCount: deadLetterEntries.retryCount,
        status: deadLetterEntries.status,
        createdAt: deadLetterEntries.createdAt,
        lastReplayedAt: deadLetterEntries.lastReplayedAt,
      })
      .from(deadLetterEntries)
      .orderBy(desc(deadLetterEntries.createdAt))
      .limit(limit);
  }

  /**
   * True totals for the whole queue, independent of any list() page size.
   * Callers that show a count (dashboard KPI, DLQ header) must use this rather
   * than `list(n).length`, which silently caps at n.
   */
  async counts(): Promise<{ total: number; unresolved: number }> {
    const [row] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        unresolved: sql<number>`count(*) filter (where ${deadLetterEntries.status} <> 'done')::int`,
      })
      .from(deadLetterEntries);
    return { total: Number(row?.total ?? 0), unresolved: Number(row?.unresolved ?? 0) };
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
