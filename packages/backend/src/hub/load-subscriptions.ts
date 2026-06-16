/**
 * loadSubscriptionsFromIntegrations — the operator path (Day 8).
 *
 * An "adapter" the Operator builds in the Wizard is just a row in
 * `app.integrations` (Source + Destination + mapping). At boot (and on demand via
 * POST /api/hub/reload-subscriptions) we turn each ACTIVE integration with a
 * relational-DB destination into live bus wiring:
 *
 *   - register a DbDestinationConnector UNDER the integration's `dest_connector_id`
 *     (decision #6: a destination's connectorId === the integration's
 *     dest_connector_id), built from the saved destination config + vault creds;
 *   - register a Subscription `<sourceKey>.*` → that destination, so envelopes a
 *     matching source publishes get delivered to it.
 *
 * Idempotent: registry.register / registerDestination overwrite by id, so
 * re-running just refreshes. DB-write creds resolve from the vault (destCredId);
 * when absent we fall back to the local connectors-postgres (the demo target).
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { integrations, connectors, credentials } from '../db/schema';
import { config } from '../config';
import { CredentialService } from '../services/CredentialService';
import { DbDestinationConnector } from './db-destination';
import { hubService } from './hub-service';
import type { DbEngine, DbConn } from '../integrations/database/genericDbWrite';

const credService = new CredentialService();

export interface LoadResult {
  loaded: number;
  skipped: number;
  subscriptions: string[];
}

function engineFromDestType(destType: unknown): DbEngine | null {
  const t = String(destType ?? '').toLowerCase();
  if (t.includes('postgres')) return 'postgres';
  if (t.includes('mysql')) return 'mysql';
  if (t.includes('sql server') || t.includes('sqlserver') || t.includes('mssql')) return 'sqlserver';
  return null;
}

/** Topic segments must be lowercase a-z/0-9/hyphen; connector keys can have underscores. */
function sanitizeSegment(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Resolve DB username/password from the vault (best-effort). Null if unavailable. */
async function resolveVaultCreds(
  destCredId: unknown,
): Promise<{ username: string; password: string } | null> {
  if (typeof destCredId !== 'string' || !destCredId) return null;
  try {
    const [row] = await db.select().from(credentials).where(eq(credentials.credId, destCredId)).limit(1);
    if (!row) return null;
    const obj = JSON.parse(credService.decrypt(row.encryptedPayload)) as Record<string, string>;
    const username = obj.username ?? obj.user ?? obj.pgUser ?? '';
    const password = obj.password ?? obj.pass ?? obj.pgPassword ?? '';
    return username || password ? { username, password } : null;
  } catch {
    return null;
  }
}

export async function loadSubscriptionsFromIntegrations(): Promise<LoadResult> {
  const rows = await db.select().from(integrations).where(eq(integrations.status, 'active'));
  const result: LoadResult = { loaded: 0, skipped: 0, subscriptions: [] };

  for (const intg of rows) {
    try {
      const fm = (intg.fieldMappings ?? {}) as Record<string, unknown>;
      const engine = engineFromDestType(fm.destType);
      const table = (fm.pgTable || fm.destTable || fm.table) as string | undefined;
      if (!engine || !table || !intg.destConnectorId) {
        result.skipped++;
        continue;
      }

      const vault = await resolveVaultCreds(fm.destCredId);
      const conn: DbConn = {
        host: (fm.pgHost as string) || config.CONNECTORS_PG_HOST,
        port: Number(fm.pgPort) || config.CONNECTORS_PG_PORT,
        database: (fm.pgDatabase as string) || config.CONNECTORS_PG_DB,
        username: vault?.username || config.CONNECTORS_PG_USER,
        password: vault?.password || config.CONNECTORS_PG_PASSWORD,
        schema: (fm.pgSchema as string) || 'public',
      };

      hubService.registerDestination(
        new DbDestinationConnector({
          connectorId: intg.destConnectorId,
          orgId: intg.orgId,
          engine,
          conn,
          table,
          naturalKey: fm.naturalKey as string | undefined,
        }),
      );

      // sourceKey for the topic pattern: explicit override → else the source
      // connector's key. `<sourceKey>.*` matches whatever that source publishes.
      let sourceKey = typeof fm.sourceKey === 'string' ? fm.sourceKey : undefined;
      if (!sourceKey && intg.sourceConnectorId) {
        const [sc] = await db
          .select({ key: connectors.key })
          .from(connectors)
          .where(eq(connectors.connectorId, intg.sourceConnectorId))
          .limit(1);
        sourceKey = sc?.key ?? undefined;
      }
      if (!sourceKey) {
        result.skipped++;
        continue;
      }
      const topic = `${sanitizeSegment(sourceKey)}.*`;

      const subId = `intg-${intg.integrationId}`;
      hubService.registry.register({
        id: subId,
        orgId: intg.orgId,
        integrationId: intg.integrationId,
        topic,
        destinationConnectorId: intg.destConnectorId,
        transformSteps: [],
        processingMode: 'serial',
        workerCount: 1,
        batchSize: 1,
        channelCapacity: 100,
      });

      result.loaded++;
      result.subscriptions.push(`${subId}: ${topic} → ${intg.destConnectorId} (${engine}/${table})`);
    } catch (err) {
      result.skipped++;
      console.error(`[Hub] failed to load integration ${intg.integrationId}:`, (err as Error).message);
    }
  }

  return result;
}
