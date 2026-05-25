/**
 * Idempotency repository — hub-level short-circuit for duplicate messages.
 * A message is considered processed if an idempotency entry exists for
 * (orgId, messageId, destConnectorId).
 */

import { eq, and } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { idempotencyEntries } from '../db/schema';

export class IdempotencyRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  /**
   * Check if a message has already been processed for a given destination.
   */
  async exists(
    orgId: string,
    messageId: string,
    destConnectorId: string,
  ): Promise<boolean> {
    const rows = await this.db
      .select({ id: idempotencyEntries.id })
      .from(idempotencyEntries)
      .where(
        and(
          eq(idempotencyEntries.orgId, orgId),
          eq(idempotencyEntries.messageId, messageId),
          eq(idempotencyEntries.destConnectorId, destConnectorId),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  /**
   * Record that a message has been processed for a destination.
   * Returns false if the record already existed (duplicate).
   */
  async record(
    orgId: string,
    messageId: string,
    destConnectorId: string,
  ): Promise<boolean> {
    const result = await this.db
      .insert(idempotencyEntries)
      .values({ orgId, messageId, destConnectorId })
      .onConflictDoNothing()
      .returning({ id: idempotencyEntries.id });

    return result.length > 0;
  }
}
