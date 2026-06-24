/**
 * run-watchdog — the backstop that guarantees every run terminates.
 *
 * Completion is normally tracked by counting per-record outcomes, but any unforeseen
 * gap (a destination that never responds, a worker that dies mid-batch, a future bug)
 * could leave a run stuck at 'pending' forever — the UI would poll endlessly. This
 * periodic sweep force-finalizes a run that can no longer make progress, so "stuck
 * forever" is structurally impossible regardless of source/destination.
 *
 * Two stall modes are caught:
 *   (a) publish phase — still 'running'/'pending' long past the publish timeout
 *       (the source read hung, or the process died between start and finish).
 *   (b) delivery phase — 'success' (all records published) but the out-message count
 *       never caught up to records_in within the delivery timeout (no live
 *       destination, wedged dispatch worker, etc.).
 *
 * A finalized run is set to 'error' with finished_at; getRunStatus then reports it
 * finished (see records-delivery: a force-terminated run stops waiting on stragglers).
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client';

const PUBLISH_TIMEOUT_MIN = Number(process.env.RUN_PUBLISH_TIMEOUT_MIN) || 10;
const DELIVERY_TIMEOUT_MIN = Number(process.env.RUN_DELIVERY_TIMEOUT_MIN) || 15;
const SWEEP_INTERVAL_MS = Number(process.env.RUN_WATCHDOG_INTERVAL_MS) || 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Force-finalize stalled runs. Returns how many were finalized. Best-effort. */
export async function sweepStuckRuns(): Promise<number> {
  const res = await db.execute(sql`
    UPDATE app.runs r
       SET status = 'error', finished_at = now(), updated_at = now()
     WHERE (
             r.status IN ('running', 'pending')
             AND r.started_at < now() - make_interval(mins => ${PUBLISH_TIMEOUT_MIN})
           )
        OR (
             r.status = 'success'
             AND COALESCE(r.finished_at, r.started_at) < now() - make_interval(mins => ${DELIVERY_TIMEOUT_MIN})
             AND r.records_in > (
               SELECT count(*) FROM app.run_messages m
                WHERE m.run_id = r.run_id AND m.direction = 'out'
             )
           )
  `);
  const n = (res as { rowCount?: number }).rowCount ?? 0;
  if (n > 0) console.warn(`[RunWatchdog] force-finalized ${n} stalled run(s) → error`);
  return n;
}

/** Start the periodic sweep (idempotent). Unref'd so it never holds the process open. */
export function startRunWatchdog(): void {
  if (timer) return;
  timer = setInterval(() => {
    sweepStuckRuns().catch((e) => console.error('[RunWatchdog] sweep failed:', (e as Error).message));
  }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(
    `[RunWatchdog] started — finalizes runs stuck publishing >${PUBLISH_TIMEOUT_MIN}m ` +
      `or delivering >${DELIVERY_TIMEOUT_MIN}m (sweep every ${Math.round(SWEEP_INTERVAL_MS / 1000)}s)`,
  );
}

export function stopRunWatchdog(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
