/**
 * Data retention sweeper — the one thing standing between the bus ledgers and unbounded
 * growth. Before this existed nothing in the codebase deleted a row by age: the only DELETE
 * on any of these tables was the cascade when an integration is removed. A long-running
 * install would grow `inbox_entries` / `outbox_entries` / `idempotency_entries` forever.
 *
 * Retention is deliberately NOT one number. Each table has different safety semantics:
 *
 * - inbox/outbox   — only TERMINAL rows (`done`) are swept. A `pending`/`processing` row is
 *                    in-flight work and a `failed`/`poisoned` row is evidence; deleting either
 *                    by age would silently drop real state.
 * - idempotency    — the duplicate-suppression ledger. Purging an entry lets that message be
 *                    delivered AGAIN if it is ever replayed, so this window is intentionally
 *                    the longest and should stay >= the longest plausible replay gap.
 * - dead letters   — only entries already REPLAYED (`last_replayed_at` set) are swept.
 *                    Never-replayed failures are kept regardless of age: they are the record
 *                    of what broke, and dropping them would quietly shrink the DLQ backlog.
 * - run messages   — per-run trace rows; large and purely diagnostic.
 * - audit log      — compliance evidence (BRD §7.8). Longest window by far, and sweeping is
 *                    OFF unless AUDIT_RETENTION_DAYS is set explicitly, so no deployment
 *                    loses audit history just by upgrading.
 *
 * Every window is env-overridable; 0 or a negative value disables that table entirely.
 */
import { Worker } from 'bullmq';
import { and, eq, lt, isNotNull, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  inboxEntries, outboxEntries, idempotencyEntries, deadLetterEntries, runMessages, auditLog,
} from '../db/schema';
import { getRetentionQueue, getRedisConnection } from '../queues';

const QUEUE = 'data-retention';
const SWEEP_JOB = 'sweep';

/** Read a retention window from env; `fallback` when unset, <=0 disables the table. */
function days(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface RetentionWindows {
  inboxDays: number;
  outboxDays: number;
  idempotencyDays: number;
  deadLetterDays: number;
  runMessageDays: number;
  auditDays: number;
}

export function retentionWindows(): RetentionWindows {
  return {
    inboxDays: days('INBOX_RETENTION_DAYS', 30),
    outboxDays: days('OUTBOX_RETENTION_DAYS', 30),
    idempotencyDays: days('IDEMPOTENCY_RETENTION_DAYS', 90),
    deadLetterDays: days('DLQ_RETENTION_DAYS', 90),
    runMessageDays: days('RUN_MESSAGE_RETENTION_DAYS', 30),
    // Off by default — see the header note on audit evidence.
    auditDays: days('AUDIT_RETENTION_DAYS', 0),
  };
}

function cutoff(d: number): Date {
  return new Date(Date.now() - d * 86_400_000);
}

export type SweepResult = Record<string, number>;

/**
 * Delete aged rows per the windows above. Returns per-table deleted counts.
 * Safe to run concurrently with live traffic: every predicate excludes in-flight state.
 */
export async function sweepExpiredData(w: RetentionWindows = retentionWindows()): Promise<SweepResult> {
  const out: SweepResult = {};
  const rowsOf = (r: unknown) => (r as { rowCount?: number }).rowCount ?? 0;

  if (w.inboxDays > 0) {
    const r = await db.delete(inboxEntries)
      .where(and(eq(inboxEntries.status, 'done'), lt(inboxEntries.createdAt, cutoff(w.inboxDays))));
    out.inboxEntries = rowsOf(r);
  }

  if (w.outboxDays > 0) {
    const r = await db.delete(outboxEntries)
      .where(and(eq(outboxEntries.status, 'done'), lt(outboxEntries.createdAt, cutoff(w.outboxDays))));
    out.outboxEntries = rowsOf(r);
  }

  if (w.idempotencyDays > 0) {
    // This table stamps `processed_at`, not `created_at`.
    const r = await db.delete(idempotencyEntries)
      .where(lt(idempotencyEntries.processedAt, cutoff(w.idempotencyDays)));
    out.idempotencyEntries = rowsOf(r);
  }

  if (w.deadLetterDays > 0) {
    // Replayed-only: an unreplayed failure is kept no matter how old.
    const r = await db.delete(deadLetterEntries)
      .where(and(
        isNotNull(deadLetterEntries.lastReplayedAt),
        lt(deadLetterEntries.createdAt, cutoff(w.deadLetterDays)),
      ));
    out.deadLetterEntries = rowsOf(r);
  }

  if (w.runMessageDays > 0) {
    const r = await db.delete(runMessages)
      .where(lt(runMessages.createdAt, cutoff(w.runMessageDays)));
    out.runMessages = rowsOf(r);
  }

  if (w.auditDays > 0) {
    const r = await db.delete(auditLog)
      .where(lt(auditLog.createdAt, cutoff(w.auditDays)));
    out.auditLog = rowsOf(r);
  }

  return out;
}

/** Row counts for the retention-managed tables — used to log what the sweep is working against. */
export async function retentionTableSizes(): Promise<Record<string, number>> {
  const [row] = await db.select({
    inbox: sql<number>`(SELECT count(*)::int FROM app.inbox_entries)`,
    outbox: sql<number>`(SELECT count(*)::int FROM app.outbox_entries)`,
    idempotency: sql<number>`(SELECT count(*)::int FROM app.idempotency_entries)`,
    deadLetter: sql<number>`(SELECT count(*)::int FROM app.dead_letter_entries)`,
    runMessages: sql<number>`(SELECT count(*)::int FROM app.run_messages)`,
    auditLog: sql<number>`(SELECT count(*)::int FROM app.audit_log)`,
  }).from(sql`(SELECT 1) AS _`);
  return row as unknown as Record<string, number>;
}

/** Start the BullMQ worker that runs the sweep. */
export function startRetentionWorker(): Worker {
  const worker = new Worker(QUEUE, async () => {
    const deleted = await sweepExpiredData();
    const total = Object.values(deleted).reduce((a, b) => a + b, 0);
    console.log(`[Retention] sweep complete — ${total} row(s) deleted`, deleted);
    return deleted;
  }, { connection: getRedisConnection() });
  worker.on('failed', (_job, err) => console.error('[Retention] job failed:', err?.message));
  return worker;
}

/** Register the nightly sweep (03:30, off-peak). Idempotent. */
export async function registerRetentionSweep(): Promise<void> {
  await getRetentionQueue().upsertJobScheduler(
    'data-retention-sweep',
    { pattern: '30 3 * * *' },
    { name: SWEEP_JOB, data: {} },
  );
}
