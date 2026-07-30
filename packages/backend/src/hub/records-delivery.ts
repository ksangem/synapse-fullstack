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
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { runs, runMessages } from '../db/schema';
import { getHub } from './init-hub';
import { hubService, DEFAULT_ORG } from './hub-service';
import { buildDestination, hasDestinationFactory, destinationTargetKey, type ConnectorBuildSpec } from './connector-registry';
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

  // A target identity stable across pushes to the same table/list, so the destination +
  // subscription registration is reused rather than leaked. The fingerprint is supplied by the
  // destination plug-in (registry) — this generic module must NOT know a connector's config keys.
  const fingerprintSpec: ConnectorBuildSpec = {
    connectorId: '', orgId: DEFAULT_ORG, kind: input.kind, config: input.config, creds: {}, integrationId,
  };
  const targetKey = `${input.kind}:${destinationTargetKey(fingerprintSpec)}`;
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

  await finishRun(runId, published, { recordsRead: records.length });

  return { runId, records: records.length, published, duplicate, destinationConnectorId };
}

/**
 * How a run ended, in the terms an operator actually asks about. Without this the UI
 * could only say "Finished", which reads as success even for a run that errored — and
 * said nothing at all about the common case of a re-run whose records were every one
 * of them unchanged (`no-new-records`).
 */
export type RunOutcome =
  | 'running'
  | 'delivered'          // everything that was published landed
  | 'partial'            // some delivered, some failed
  | 'failed'             // the run errored, or every delivery failed
  | 'stopped'            // operator cancelled
  | 'no-source-records'  // the source returned nothing
  | 'no-new-records';    // source had rows, but all were already delivered unchanged

export interface RunStatus {
  runId: string;
  status: string;
  /** Rows the source produced this run. */
  recordsRead: number;
  /** Deliveries this run should produce (published × live targets) — the progress denominator. */
  expectedOut: number;
  /** Read but suppressed at the inbox as an unchanged duplicate of an earlier run. */
  duplicates: number;
  delivered: number;
  failed: number;
  /** Settled without a fresh delivery: no matching subscription, or duplicate/idempotency-suppressed. */
  skipped: number;
  pending: number;
  finished: boolean;
  outcome: RunOutcome;
  /** Sample of recent failure reasons (from the dead-letter queue) when failed > 0. */
  errors?: string[];
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
  let skipped = 0;
  for (const r of outRows) {
    if (r.status === 'failed') failed++;
    else if (r.status === 'skipped') skipped++;
    else delivered++;
  }

  // recordsIn is the run's EXPECTED delivery count (published × live targets) — the
  // progress denominator. recordsRead is what the SOURCE produced; the two differ by
  // however many records the inbox suppressed as unchanged duplicates.
  const recordsRead = run.recordsRead ?? 0;
  const expectedOut = run.recordsIn ?? 0;
  // 'skipped' is a terminal outcome (matched no subscription / duplicate-suppressed),
  // so it counts toward "settled" just like delivered/failed — otherwise a run whose
  // records had no destination would sit at pending forever (the "164 queued" hang).
  const pending = Math.max(0, expectedOut - delivered - failed - skipped);
  // Finished when EITHER:
  //   • normal completion — source closed (status not 'running'/'pending') and every
  //     published record reached a terminal state (delivered/failed/skipped); OR
  //   • the run was force-terminated — 'cancelled' (operator Stop) or 'error'
  //     (incl. the watchdog finalizing a stalled run). We stop waiting on stragglers
  //     that will never arrive, so the UI can never spin forever.
  const forceTerminated = run.status === 'error' || run.status === 'cancelled';
  const finished = forceTerminated || (run.status !== 'running' && run.status !== 'pending' && pending === 0);

  // Surface why rows failed (from the dead-letter queue, keyed by the runId stamped on
  // each envelope's headers) so the UI can show the real reason — e.g. a SharePoint 500
  // — instead of an opaque "N failed". Only when there are failures, kept to a few.
  let errors: string[] | undefined;
  if (failed > 0) {
    try {
      const res = await db.execute(sql`
        SELECT error FROM app.dead_letter_entries
         WHERE envelope_json -> 'headers' ->> 'runId' = ${runId}
         ORDER BY created_at DESC LIMIT 5`);
      const rows = (res as { rows?: Array<Record<string, unknown>> }).rows ?? [];
      const list = rows.map((r) => String(r.error ?? '')).filter(Boolean);
      if (list.length) errors = list;
    } catch { /* best-effort — never block status on the error sample */ }
  }

  // Duplicates are what the source read but the inbox suppressed as unchanged. Only
  // meaningful once the source is done reading, hence the `finished` guard — mid-run the
  // gap between read and published is just work still in flight.
  const duplicates = finished ? Math.max(0, recordsRead - expectedOut) : 0;

  return {
    runId,
    status: run.status,
    recordsRead,
    expectedOut,
    duplicates,
    delivered,
    failed,
    skipped,
    pending,
    finished,
    outcome: classifyOutcome({ status: run.status, finished, expectedOut, recordsRead, delivered, failed }),
    errors,
  };
}

/**
 * Reduce a run's raw counters to the one thing an operator wants to know. Exported so
 * the classification is testable without a database.
 */
export function classifyOutcome(r: {
  status: string;
  finished: boolean;
  expectedOut: number;
  recordsRead: number;
  delivered: number;
  failed: number;
}): RunOutcome {
  if (!r.finished) return 'running';
  if (r.status === 'cancelled') return 'stopped';
  // A run whose SOURCE threw is 'error' even though no individual record failed —
  // reporting that as a plain "Finished" is how a broken run passed for a clean one.
  if (r.status === 'error') return 'failed';
  if (r.failed > 0) return r.delivered > 0 ? 'partial' : 'failed';
  // Nothing was published. Which of the two reasons applies is the whole point of
  // tracking recordsRead separately: an empty source is a source problem, an unchanged
  // source is a no-op re-run and entirely expected.
  if (r.expectedOut === 0) return r.recordsRead > 0 ? 'no-new-records' : 'no-source-records';
  return 'delivered';
}
