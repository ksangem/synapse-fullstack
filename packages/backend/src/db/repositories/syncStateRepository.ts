import { db } from '../client';
import { syncState } from '../schema';
import { eq, ne, and } from 'drizzle-orm';
import type { SyncStatus } from '../../types/sync.types';

export class SyncStateRepository {
  async getByIntegration(integrationId: string) {
    const [row] = await db.select().from(syncState)
      .where(eq(syncState.integrationId, integrationId));
    return row ?? null;
  }

  async upsert(integrationId: string, data: {
    lastSyncedAt?: Date;
    lastJiraUpdatedAt?: Date;
    lastPushLogId?: string;
    dateRangeStart?: string;
    dateRangeEnd?: string;
    syncStatus?: SyncStatus;
    syncError?: string | null;
  }) {
    const existing = await this.getByIntegration(integrationId);

    if (existing) {
      await db.update(syncState)
        .set({
          ...(data.lastSyncedAt !== undefined && { lastSyncedAt: data.lastSyncedAt }),
          ...(data.lastJiraUpdatedAt !== undefined && { lastJiraUpdatedAt: data.lastJiraUpdatedAt }),
          ...(data.lastPushLogId !== undefined && { lastPushLogId: data.lastPushLogId }),
          ...(data.dateRangeStart !== undefined && { dateRangeStart: data.dateRangeStart }),
          ...(data.dateRangeEnd !== undefined && { dateRangeEnd: data.dateRangeEnd }),
          ...(data.syncStatus !== undefined && { syncStatus: data.syncStatus }),
          ...(data.syncError !== undefined && { syncError: data.syncError }),
          updatedAt: new Date(),
        })
        .where(eq(syncState.integrationId, integrationId));
      return (await this.getByIntegration(integrationId))!;
    }

    const [row] = await db.insert(syncState).values({
      integrationId,
      lastSyncedAt: data.lastSyncedAt ?? null,
      lastJiraUpdatedAt: data.lastJiraUpdatedAt ?? null,
      lastPushLogId: data.lastPushLogId ?? null,
      dateRangeStart: data.dateRangeStart ?? null,
      dateRangeEnd: data.dateRangeEnd ?? null,
      syncStatus: data.syncStatus ?? 'IDLE',
      syncError: data.syncError ?? null,
    }).returning();
    return row;
  }

  /**
   * Attempt to acquire lock by setting status to RUNNING.
   * Returns true if lock acquired, false if already running.
   */
  async acquireLock(integrationId: string): Promise<boolean> {
    const existing = await this.getByIntegration(integrationId);

    if (!existing) {
      await db.insert(syncState).values({
        integrationId,
        syncStatus: 'RUNNING',
      });
      return true;
    }

    if (existing.syncStatus === 'RUNNING') {
      return false;
    }

    await db.update(syncState)
      .set({ syncStatus: 'RUNNING', updatedAt: new Date() })
      .where(and(
        eq(syncState.integrationId, integrationId),
        ne(syncState.syncStatus, 'RUNNING')
      ));

    return true;
  }

  async releaseLock(integrationId: string, status: SyncStatus, error?: string) {
    await db.update(syncState)
      .set({
        syncStatus: status,
        syncError: error ?? null,
        updatedAt: new Date(),
      })
      .where(eq(syncState.integrationId, integrationId));
  }

  /**
   * Convenience: set COMPLETED with all watermark data.
   */
  async setCompleted(integrationId: string, data: {
    lastJiraUpdatedAt?: Date;
    lastPushLogId?: string;
    dateRangeStart?: string;
    dateRangeEnd?: string;
  }) {
    return this.upsert(integrationId, {
      lastSyncedAt: new Date(),
      lastJiraUpdatedAt: data.lastJiraUpdatedAt,
      lastPushLogId: data.lastPushLogId,
      dateRangeStart: data.dateRangeStart,
      dateRangeEnd: data.dateRangeEnd,
      syncStatus: 'COMPLETED',
      syncError: null,
    });
  }

  /**
   * Convenience: set FAILED with error message.
   */
  async setFailed(integrationId: string, error: string) {
    return this.releaseLock(integrationId, 'FAILED', error);
  }
}
