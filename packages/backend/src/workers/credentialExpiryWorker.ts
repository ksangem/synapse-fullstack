/**
 * Credential expiry scanner — the worker behind the (previously empty)
 * `credential-rotator` queue. BRD §7.9: warn at 7 / 3 / 1 days before a credential
 * expires (and once expired). Each crossing raises an `alerts` row; a daily
 * repeatable job drives the scan. (Alert *delivery* via `alert-dispatcher` is
 * separate/out-of-scope — this only raises the alert + feeds the compliance report.)
 */
import { Worker } from 'bullmq';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { credentials, alerts } from '../db/schema';
import { credentialRotatorQueue, redisConnection } from '../queues';

const QUEUE = 'credential-rotator';
const SCAN_JOB = 'scan-expiry';

function daysUntil(expiry: Date): number {
  return (expiry.getTime() - Date.now()) / 86_400_000;
}

/** Which 7/3/1-day (or expired) threshold this expiry crosses; null if >7 days out. */
function thresholdFor(days: number): { label: string; severity: 'critical' | 'warning' } | null {
  if (days < 0) return { label: 'expired', severity: 'critical' };
  if (days <= 1) return { label: '1 day', severity: 'critical' };
  if (days <= 3) return { label: '3 days', severity: 'warning' };
  if (days <= 7) return { label: '7 days', severity: 'warning' };
  return null;
}

/** Scan active credentials and raise a (deduped) alert for each near/past expiry. */
export async function scanExpiringCredentials(): Promise<number> {
  const rows = await db.select().from(credentials).where(eq(credentials.status, 'active'));
  let raised = 0;

  for (const c of rows) {
    if (!c.expiry) continue;
    const t = thresholdFor(daysUntil(c.expiry));
    if (!t) continue;

    const title = `Credential expiring (${t.label}): ${c.systemName}`;
    // Dedup: skip if an unresolved alert with this exact title already exists.
    const [existing] = await db.select({ alertId: alerts.alertId }).from(alerts)
      .where(and(eq(alerts.orgId, c.orgId), eq(alerts.title, title), isNull(alerts.resolvedAt)))
      .limit(1);
    if (existing) continue;

    await db.insert(alerts).values({
      orgId: c.orgId,
      severity: t.severity,
      title,
      message: `Credential "${c.systemName}" (${c.authType}) expires ${c.expiry.toISOString()}. Rotate it in the Vault.`,
    });
    raised++;
  }
  return raised;
}

/** Start the BullMQ worker that runs the scan. */
export function startCredentialExpiryWorker(): Worker {
  const worker = new Worker(QUEUE, async () => {
    const raised = await scanExpiringCredentials();
    console.log(`[CredentialExpiry] scan complete — ${raised} new alert(s)`);
    return { raised };
  }, { connection: redisConnection });
  worker.on('failed', (_job, err) => console.error('[CredentialExpiry] job failed:', err?.message));
  return worker;
}

/** Register the daily repeatable scan (08:00). Idempotent. */
export async function registerCredentialExpiryScan(): Promise<void> {
  await credentialRotatorQueue.upsertJobScheduler(
    'credential-expiry-scan',
    { pattern: '0 8 * * *' },
    { name: SCAN_JOB, data: {} },
  );
}
