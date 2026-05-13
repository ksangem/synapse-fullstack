import { db } from '../client';
import { pushLog } from '../schema';
import { eq, desc, and, lte, gte, inArray } from 'drizzle-orm';
import type { PushLogInsert, PushStatus } from '../../types/sync.types';

export class PushLogRepository {
  async insert(entry: PushLogInsert) {
    const [row] = await db.insert(pushLog).values({
      integrationId: entry.integrationId,
      clientId: entry.clientId,
      projectKey: entry.projectKey,
      dateRangeStart: entry.dateRangeStart,
      dateRangeEnd: entry.dateRangeEnd,
      sharepointListId: entry.sharepointListId,
      sharepointSiteId: entry.sharepointSiteId,
      pushedBy: entry.pushedBy,
      recordCount: entry.recordCount,
      pushType: entry.pushType,
      jqlUsed: entry.jqlUsed ?? null,
      errorMessage: entry.errorMessage ?? null,
      status: entry.status ?? 'SUCCESS',
    }).returning();
    return row;
  }

  /**
   * Layer 1 duplicate check: exact match on integration + project + date range.
   * Returns the most recent successful/partial push for this exact window.
   */
  async getLastSuccessful(
    integrationId: string,
    projectKey?: string,
    start?: string,
    end?: string
  ) {
    const conditions = [
      eq(pushLog.integrationId, integrationId),
      inArray(pushLog.status, ['SUCCESS', 'PARTIAL']),
    ];

    if (projectKey) conditions.push(eq(pushLog.projectKey, projectKey));
    if (start) conditions.push(eq(pushLog.dateRangeStart, start));
    if (end) conditions.push(eq(pushLog.dateRangeEnd, end));

    const [row] = await db.select().from(pushLog)
      .where(and(...conditions))
      .orderBy(desc(pushLog.pushedAt))
      .limit(1);
    return row ?? null;
  }

  async checkOverlap(integrationId: string, start: string, end: string) {
    const [row] = await db.select().from(pushLog)
      .where(and(
        eq(pushLog.integrationId, integrationId),
        inArray(pushLog.status, ['SUCCESS', 'PARTIAL']),
        lte(pushLog.dateRangeStart, end),
        gte(pushLog.dateRangeEnd, start)
      ))
      .orderBy(desc(pushLog.pushedAt))
      .limit(1);
    return row ?? null;
  }

  async listByIntegration(integrationId: string, limit = 10) {
    return db.select().from(pushLog)
      .where(eq(pushLog.integrationId, integrationId))
      .orderBy(desc(pushLog.pushedAt))
      .limit(limit);
  }

  async updateStatus(id: string, status: PushStatus, errorMessage?: string) {
    await db.update(pushLog)
      .set({ status, errorMessage: errorMessage ?? null })
      .where(eq(pushLog.id, id));
  }
}
