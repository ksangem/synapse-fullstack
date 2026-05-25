/**
 * Inbox repository — Drizzle-backed PENDING/PROCESSING/DONE state machine.
 * Every inbound message is checkpointed here before fan-out.
 */

import { eq, and } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { inboxEntries } from '../db/schema';
import type { MessageEnvelope, EnvelopeStatus } from './interfaces';

export class InboxRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  /**
   * Insert a PENDING inbox entry. Returns the row id.
   * If a duplicate (orgId + messageId) exists, returns null (idempotent).
   */
  async insert(envelope: MessageEnvelope): Promise<string | null> {
    try {
      const [row] = await this.db
        .insert(inboxEntries)
        .values({
          orgId: envelope.orgId,
          messageId: envelope.messageId,
          correlationId: envelope.correlationId,
          sourceConnectorId: envelope.sourceConnectorId,
          topic: envelope.topic,
          sequenceNo: envelope.sequenceNo,
          checksum: envelope.checksum,
          envelopeJson: envelope,
          status: 'pending',
        })
        .onConflictDoNothing()
        .returning({ id: inboxEntries.id });

      return row?.id ?? null;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`InboxRepository.insert failed: ${message}`);
    }
  }

  /**
   * Transition inbox entry from PENDING → PROCESSING.
   */
  async markProcessing(orgId: string, messageId: string): Promise<boolean> {
    return this.transition(orgId, messageId, 'pending', 'processing');
  }

  /**
   * Transition inbox entry from PROCESSING → DONE.
   */
  async markDone(orgId: string, messageId: string): Promise<boolean> {
    const result = await this.db
      .update(inboxEntries)
      .set({
        status: 'done',
        processedAt: new Date(),
      })
      .where(
        and(
          eq(inboxEntries.orgId, orgId),
          eq(inboxEntries.messageId, messageId),
          eq(inboxEntries.status, 'processing'),
        ),
      )
      .returning({ id: inboxEntries.id });

    return result.length > 0;
  }

  /**
   * Transition inbox entry to FAILED with error detail.
   */
  async markFailed(orgId: string, messageId: string, error: string): Promise<boolean> {
    const result = await this.db
      .update(inboxEntries)
      .set({ status: 'failed', error })
      .where(
        and(
          eq(inboxEntries.orgId, orgId),
          eq(inboxEntries.messageId, messageId),
        ),
      )
      .returning({ id: inboxEntries.id });

    return result.length > 0;
  }

  /**
   * Get inbox entry status by orgId + messageId.
   */
  async getStatus(orgId: string, messageId: string): Promise<EnvelopeStatus | null> {
    const rows = await this.db
      .select({ status: inboxEntries.status })
      .from(inboxEntries)
      .where(
        and(
          eq(inboxEntries.orgId, orgId),
          eq(inboxEntries.messageId, messageId),
        ),
      )
      .limit(1);

    return (rows[0]?.status as EnvelopeStatus) ?? null;
  }

  private async transition(
    orgId: string,
    messageId: string,
    fromStatus: EnvelopeStatus,
    toStatus: EnvelopeStatus,
  ): Promise<boolean> {
    const result = await this.db
      .update(inboxEntries)
      .set({ status: toStatus })
      .where(
        and(
          eq(inboxEntries.orgId, orgId),
          eq(inboxEntries.messageId, messageId),
          eq(inboxEntries.status, fromStatus),
        ),
      )
      .returning({ id: inboxEntries.id });

    return result.length > 0;
  }
}
