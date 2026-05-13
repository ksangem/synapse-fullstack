import { db } from '../client';
import { jiraItemCache } from '../schema';
import { eq, and, inArray } from 'drizzle-orm';

export interface CacheRow {
  id: string;
  integrationId: string;
  jiraKey: string;
  spItemId: string;
  jiraStatus: string | null;
  spStatus: string | null;
  isTerminal: boolean;
  pushedAt: Date;
  updatedAt: Date;
}

export class JiraItemCacheRepository {
  async get(integrationId: string, jiraKey: string): Promise<CacheRow | null> {
    const [row] = await db.select().from(jiraItemCache)
      .where(and(
        eq(jiraItemCache.integrationId, integrationId),
        eq(jiraItemCache.jiraKey, jiraKey)
      ));
    return (row as CacheRow) ?? null;
  }

  async upsert(integrationId: string, jiraKey: string, data: {
    spItemId: string;
    jiraStatus?: string | null;
    spStatus?: string | null;
    isTerminal?: boolean;
  }): Promise<void> {
    const existing = await this.get(integrationId, jiraKey);

    if (existing) {
      await db.update(jiraItemCache)
        .set({
          spItemId: data.spItemId,
          ...(data.jiraStatus !== undefined && { jiraStatus: data.jiraStatus }),
          ...(data.spStatus !== undefined && { spStatus: data.spStatus }),
          ...(data.isTerminal !== undefined && { isTerminal: data.isTerminal }),
          updatedAt: new Date(),
        })
        .where(and(
          eq(jiraItemCache.integrationId, integrationId),
          eq(jiraItemCache.jiraKey, jiraKey)
        ));
    } else {
      await db.insert(jiraItemCache).values({
        integrationId,
        jiraKey,
        spItemId: data.spItemId,
        jiraStatus: data.jiraStatus ?? null,
        spStatus: data.spStatus ?? null,
        isTerminal: data.isTerminal ?? false,
      });
    }
  }

  /**
   * Batch-load cache rows for a list of Jira keys.
   * Returns a Map keyed by jiraKey for O(1) lookups.
   */
  async bulkGet(integrationId: string, jiraKeys: string[]): Promise<Map<string, CacheRow>> {
    if (jiraKeys.length === 0) return new Map();

    const rows = await db.select().from(jiraItemCache)
      .where(and(
        eq(jiraItemCache.integrationId, integrationId),
        inArray(jiraItemCache.jiraKey, jiraKeys)
      ));

    const map = new Map<string, CacheRow>();
    for (const row of rows) {
      map.set(row.jiraKey, row as CacheRow);
    }
    return map;
  }

  async markTerminal(integrationId: string, jiraKey: string): Promise<void> {
    await db.update(jiraItemCache)
      .set({ isTerminal: true, updatedAt: new Date() })
      .where(and(
        eq(jiraItemCache.integrationId, integrationId),
        eq(jiraItemCache.jiraKey, jiraKey)
      ));
  }
}
