/**
 * Alert dispatcher — a standalone scanner that RAISES operational alerts into the
 * `app.alerts` table (surfaced in the Alerts UI). QC-plan gaps #37 (DLQ-depth),
 * #50 (run-failure / SLA). Modelled 1:1 on `credentialExpiryWorker`.
 *
 * SCOPE: this only *raises* alerts (DB rows). Delivery (email/Teams) is a separate
 * follow-up — the backend has no mailer today, so nothing is sent here. This worker
 * is fully standalone: it reads `runs` / `dead_letter_entries` and writes `alerts`.
 * It does NOT touch the message bus (routing / dispatch / DLQ core are untouched).
 *
 * Thresholds are env-driven (no hardcoding): ALERT_DLQ_DEPTH_THRESHOLD, ALERT_SLA_MINUTES.
 */
import { Worker } from 'bullmq';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { alerts, runs, integrations, deadLetterEntries } from '../db/schema';
import { getAlertDispatcherQueue, getRedisConnection } from '../queues';

const QUEUE = 'alert-dispatcher';
const SCAN_JOB = 'scan-alerts';

const DLQ_DEPTH_THRESHOLD = Number(process.env.ALERT_DLQ_DEPTH_THRESHOLD ?? 100);
const SLA_MINUTES = Number(process.env.ALERT_SLA_MINUTES ?? 60);
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // only consider runs from the last 24h

type Severity = 'critical' | 'warning' | 'info';

/** Insert an alert unless an identical unresolved one already exists (dedup by org + title). */
async function raise(orgId: string, severity: Severity, title: string, message: string): Promise<number> {
  const [existing] = await db.select({ alertId: alerts.alertId }).from(alerts)
    .where(and(eq(alerts.orgId, orgId), eq(alerts.title, title), isNull(alerts.resolvedAt)))
    .limit(1);
  if (existing) return 0;
  await db.insert(alerts).values({ orgId, severity, title, message });
  return 1;
}

/** One alert per failed run (status = 'error') in the last 24h. */
async function scanRunFailures(): Promise<number> {
  const cutoff = new Date(Date.now() - LOOKBACK_MS);
  const rows = await db.select({
    runId: runs.runId, orgId: integrations.orgId, name: integrations.name,
    finishedAt: runs.finishedAt,
  }).from(runs)
    .innerJoin(integrations, eq(runs.integrationId, integrations.integrationId))
    .where(and(eq(runs.status, 'error'), gte(runs.startedAt, cutoff)));

  let raised = 0;
  for (const r of rows) {
    const title = `Run failed: ${r.name} (${r.runId.slice(0, 8)})`;
    raised += await raise(r.orgId, 'warning', title,
      `Integration "${r.name}" run ${r.runId} finished with status=error${r.finishedAt ? ` at ${r.finishedAt.toISOString()}` : ''}.`);
  }
  return raised;
}

/** One (deduped) alert per org whose failed-DLQ depth exceeds the threshold. */
async function scanDlqDepth(): Promise<number> {
  const rows = await db.select({
    orgId: deadLetterEntries.orgId, n: sql<number>`count(*)::int`,
  }).from(deadLetterEntries)
    .where(eq(deadLetterEntries.status, 'failed'))
    .groupBy(deadLetterEntries.orgId);

  let raised = 0;
  for (const r of rows) {
    if (r.n <= DLQ_DEPTH_THRESHOLD) continue;
    raised += await raise(r.orgId, 'critical', 'Dead-letter queue above threshold',
      `${r.n} failed messages in the dead-letter queue (threshold ${DLQ_DEPTH_THRESHOLD}). Review and replay in Monitor.`);
  }
  return raised;
}

/** One alert per run whose duration exceeded the SLA, in the last 24h. */
async function scanSlaBreaches(): Promise<number> {
  const cutoff = new Date(Date.now() - LOOKBACK_MS);
  const rows = await db.select({
    runId: runs.runId, orgId: integrations.orgId, name: integrations.name,
    startedAt: runs.startedAt, finishedAt: runs.finishedAt,
  }).from(runs)
    .innerJoin(integrations, eq(runs.integrationId, integrations.integrationId))
    .where(gte(runs.startedAt, cutoff));

  let raised = 0;
  for (const r of rows) {
    if (!r.finishedAt) continue;
    const minutes = (r.finishedAt.getTime() - r.startedAt.getTime()) / 60_000;
    if (minutes <= SLA_MINUTES) continue;
    const title = `Run exceeded SLA: ${r.name} (${r.runId.slice(0, 8)})`;
    raised += await raise(r.orgId, 'warning', title,
      `Integration "${r.name}" run took ${minutes.toFixed(1)} min (SLA ${SLA_MINUTES} min).`);
  }
  return raised;
}

/** Run all three scans; returns the total number of new alerts raised. */
export async function scanForAlerts(): Promise<number> {
  const results = await Promise.all([scanRunFailures(), scanDlqDepth(), scanSlaBreaches()]);
  return results.reduce((a, b) => a + b, 0);
}

/** Start the BullMQ worker that runs the scan. */
export function startAlertDispatcherWorker(): Worker {
  const worker = new Worker(QUEUE, async () => {
    const raised = await scanForAlerts();
    console.log(`[AlertDispatcher] scan complete — ${raised} new alert(s)`);
    return { raised };
  }, { connection: getRedisConnection() });
  worker.on('failed', (_job, err) => console.error('[AlertDispatcher] job failed:', err?.message));
  return worker;
}

/** Register the repeatable scan (every 5 minutes). Idempotent. */
export async function registerAlertDispatcherScan(): Promise<void> {
  await getAlertDispatcherQueue().upsertJobScheduler(
    'alert-dispatcher-scan',
    { pattern: '*/5 * * * *' },
    { name: SCAN_JOB, data: {} },
  );
}
