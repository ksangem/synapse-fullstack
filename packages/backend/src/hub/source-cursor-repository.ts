/**
 * Source cursor repository — persists Graph @odata.deltaLink per list.
 */

import { eq, and } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sourceCursors } from '../db/schema';

export class SourceCursorRepository {
  constructor(private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  /**
   * Get the cursor value for a given source connector + key.
   * Returns null if no cursor has been saved yet.
   */
  async get(
    integrationId: string,
    sourceConnectorId: string,
    cursorKey: string,
  ): Promise<string | null> {
    const rows = await this.db
      .select({ cursorValue: sourceCursors.cursorValue })
      .from(sourceCursors)
      .where(
        and(
          eq(sourceCursors.integrationId, integrationId),
          eq(sourceCursors.sourceConnectorId, sourceConnectorId),
          eq(sourceCursors.cursorKey, cursorKey),
        ),
      )
      .limit(1);

    return rows[0]?.cursorValue ?? null;
  }

  /**
   * Save or update a cursor value. Uses upsert on the unique constraint.
   */
  async save(
    orgId: string,
    integrationId: string,
    sourceConnectorId: string,
    cursorKey: string,
    cursorValue: string,
  ): Promise<void> {
    await this.db
      .insert(sourceCursors)
      .values({
        orgId,
        integrationId,
        sourceConnectorId,
        cursorKey,
        cursorValue,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          sourceCursors.integrationId,
          sourceCursors.sourceConnectorId,
          sourceCursors.cursorKey,
        ],
        set: {
          cursorValue,
          updatedAt: new Date(),
        },
      });
  }
}
