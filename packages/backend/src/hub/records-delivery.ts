/**
 * records-delivery — publish already-mapped rows onto the bus for delivery.
 *
 * The Wizard fetches a source and applies its mappings CLIENT-side (presets,
 * expressions, multi-source aggregations), then hands the finished destination
 * rows here. Rather than write them in-request, we publish each row as a bus
 * envelope so the one real delivery path (inbox → router → dispatch worker →
 * destination, with idempotency + retry + DLQ + run audit) carries every write.
 *
 * No transform step is attached — the rows are already in destination shape; this
 * module only stamps the generic headers (event / natural key / dest table) the
 * generic destinations read. A destination + subscription are registered on the
 * fly, keyed deterministically by the target so repeated pushes to the same table
 * or list reuse one registration (Map.set upserts; bounded by distinct targets).
 *
 * Idempotency: with a natural key, messageId is derived from (key + content hash)
 * — an unchanged re-push dedups at the inbox, a CHANGED row re-flows and upserts,
 * and key-less "append" pushes get random ids (every row inserts). Mirrors how the
 * real source connectors key their envelopes.
 */

import { createHash } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { runs, runMessages } from '../db/schema';
import { getHub } from './init-hub';
import { hubService, DEFAULT_ORG } from './hub-service';
import { buildDestination, hasDestinationFactory, type ConnectorBuildSpec } from './connector-registry';
import { createEnvelope, computeChecksum, serializePayload } from './envelope';
import { H, type ChangeEvent } from './envelope-meta';
import { HUB_DEMO_INTEGRATION_ID, startRun, finishRun } from './run-recorder';
import type { JsonValue, Subscription } from './interfaces';

export interface PublishRecordsInput {
  /** Destination connector kind — 'database' | 'sharepoint' | 'rest' (registry key). */
  kind: string;
  /** Destination config, in the registry factory's own keys (pgHost/table/siteUrl/...). */
  config: Record<string, unknown>;
  /** Decrypted credentials for the destination (db user/pass, Azure app, ...). */
  creds?: Record<string, string>;
  /** Already-mapped destination rows. */
  records: Record<string, JsonValue>[];
  /** Upsert/dedup column at the destination; omit (or '') for append-only. */
  naturalKeyColumn?: string;
  /** Destination table (DB destinations); stamped on each envelope header. */
  destTable?: string;
  /** Change kind for these rows. Default 'created'. */
  event?: ChangeEvent;
  /** Integration to attribute the run to (defaults to the synthetic Hub integration). */
  integrationId?: string;
}

export interface PublishRecordsResult {
  runId: string | null;
  records: number;
  published: number;
  duplicate: number;
  destinationConnectorId: string;
}

/** Short, stable id fragment from an input string. */
function shortHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Publish a batch of pre-mapped rows for delivery to one destination.
 * Requires the hub to be running (getHub throws otherwise).
 */
export async function publishRecords(input: PublishRecordsInput): Promise<PublishRecordsResult> {
  if (!hasDestinationFactory(input.kind)) {
    throw new Error(`No destination connector registered for kind "${input.kind}"`);
  }
  const records = Array.isArray(input.records) ? input.records : [];
  const event: ChangeEvent = input.event ?? 'created';
  const nkColumn = input.naturalKeyColumn ?? '';
  const integrationId = input.integrationId || HUB_DEMO_INTEGRATION_ID;

  // A target identity stable across pushes to the same table/list, so the
  // destination + subscription registration is reused rather than leaked.
  const targetKey =
    `${input.kind}:${input.destTable ?? input.config.pgTable ?? input.config.destTable ?? ''}` +
    `:${input.config.listName ?? input.config.siteUrl ?? ''}` +
    `:${input.config.pgHost ?? input.config.host ?? ''}:${input.config.pgDatabase ?? input.config.database ?? ''}`;
  const id8 = shortHash(targetKey);
  const destinationConnectorId = `wiz-${id8}`;
  const topicBase = `wiz-${id8}`;

  // Build + register the destination, then a no-transform subscription that routes
  // this push's topic to it. Both upsert by id, so re-pushes don't duplicate wiring.
  const spec: ConnectorBuildSpec = {
    connectorId: destinationConnectorId,
    orgId: DEFAULT_ORG,
    kind: input.kind,
    config: input.config,
    creds: input.creds ?? {},
    integrationId,
  };
  hubService.registerDestination(await buildDestination(spec));

  const subscription: Subscription = {
    id: `wiz-sub-${id8}`,
    orgId: DEFAULT_ORG,
    integrationId,
    topic: `${topicBase}.records.*`,
    destinationConnectorId,
    transformSteps: [],
    processingMode: 'serial',
    workerCount: 1,
    batchSize: 1,
    channelCapacity: 100,
  };
  hubService.registry.register(subscription);

  const hub = getHub();
  const runId = await startRun(integrationId);

  let published = 0;
  let duplicate = 0;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] ?? {};
    const nkValue = nkColumn ? String(rec[nkColumn] ?? '') : '';

    const headers: Record<string, string> = {
      [H.EVENT]: event,
      [H.NATURAL_KEY_COLUMN]: nkColumn,
      [H.NATURAL_KEY]: nkValue,
    };
    if (input.destTable) headers[H.DEST_TABLE] = input.destTable;
    if (runId) headers[H.RUN_ID] = runId;

    // Key on (natural key + content hash): unchanged re-push dedups, a changed row
    // re-flows and upserts. Append mode (no natural key) → random id → always inserts.
    const idempotencyKey = nkColumn
      ? `${nkValue}:${computeChecksum(serializePayload(rec as JsonValue))}`
      : undefined;

    const envelope = createEnvelope({
      topic: `${topicBase}.records.${event}`,
      sourceConnectorId: destinationConnectorId,
      orgId: DEFAULT_ORG,
      sequenceNo: i,
      payload: rec as JsonValue,
      headers,
      idempotencyKey,
    });

    const inboxId = await hub.bus.publish(envelope);
    if (inboxId === null) duplicate++;
    else published++;
  }

  await finishRun(runId, published);

  return { runId, records: records.length, published, duplicate, destinationConnectorId };
}

export interface RunStatus {
  runId: string;
  status: string;
  recordsIn: number;
  delivered: number;
  failed: number;
  pending: number;
  finished: boolean;
}

/** Aggregate a run's delivery progress from runs + run_messages(direction='out'). */
export async function getRunStatus(runId: string): Promise<RunStatus | null> {
  const [run] = await db.select().from(runs).where(eq(runs.runId, runId)).limit(1);
  if (!run) return null;

  const outRows = await db
    .select({ status: runMessages.status })
    .from(runMessages)
    .where(and(eq(runMessages.runId, runId), eq(runMessages.direction, 'out')));

  let delivered = 0;
  let failed = 0;
  for (const r of outRows) {
    if (r.status === 'failed') failed++;
    else delivered++;
  }

  const recordsIn = run.recordsIn ?? 0;
  const pending = Math.max(0, recordsIn - delivered - failed);
  // The run is settled once the source closed (status no longer 'running') AND every
  // published record has reached a terminal delivery state.
  const finished = run.status !== 'running' && run.status !== 'pending' && pending === 0;

  return { runId, status: run.status, recordsIn, delivered, failed, pending, finished };
}
