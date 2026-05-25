/**
 * Outbox repository — tracks dispatch intent per destination connector.
 */

import { eq, and } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { outboxEntries } from '../db/schema';
import type { MessageEnvelope, EnvelopeStatus } from './interfaces';

export class OutboxRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  /**
   * Insert a PENDING outbox entry for a specific destination.
   * Returns the row id, or null if duplicate.
   */
  async insert(
    envelope: MessageEnvelope,
    destConnectorId: string,
  ): Promise<string | null> {
    try {
      const [row] = await this.db
        .insert(outboxEntries)
        .values({
          orgId: envelope.orgId,
          messageId: envelope.messageId,
          destConnectorId,
          envelopeJson: envelope,
          status: 'pending',
        })
        .onConflictDoNothing()
        .returning({ id: outboxEntries.id });

      return row?.id ?? null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`OutboxRepository.insert failed: ${message}`);
    }
  }

  /**
   * Transition outbox entry to DONE after successful dispatch.
   */
  async markDone(
    orgId: string,
    messageId: string,
    destConnectorId: string,
  ): Promise<boolean> {
    const result = await this.db
      .update(outboxEntries)
      .set({
        status: 'done',
        dispatchedAt: new Date(),
      })
      .where(
        and(
          eq(outboxEntries.orgId, orgId),
          eq(outboxEntries.messageId, messageId),
          eq(outboxEntries.destConnectorId, destConnectorId),
        ),
      )
      .returning({ id: outboxEntries.id });

    return result.length > 0;
  }

  /**
   * Transition outbox entry to FAILED with error.
   */
  async markFailed(
    orgId: string,
    messageId: string,
    destConnectorId: string,
    error: string,
  ): Promise<boolean> {
    const result = await this.db
      .update(outboxEntries)
      .set({ status: 'failed', error })
      .where(
        and(
          eq(outboxEntries.orgId, orgId),
          eq(outboxEntries.messageId, messageId),
          eq(outboxEntries.destConnectorId, destConnectorId),
        ),
      )
      .returning({ id: outboxEntries.id });

    return result.length > 0;
  }

  /**
   * Get outbox entry status.
   */
  async getStatus(
    orgId: string,
    messageId: string,
    destConnectorId: string,
  ): Promise<EnvelopeStatus | null> {
    const rows = await this.db
      .select({ status: outboxEntries.status })
      .from(outboxEntries)
      .where(
        and(
          eq(outboxEntries.orgId, orgId),
          eq(outboxEntries.messageId, messageId),
          eq(outboxEntries.destConnectorId, destConnectorId),
        ),
      )
      .limit(1);

    return (rows[0]?.status as EnvelopeStatus) ?? null;
  }
}
