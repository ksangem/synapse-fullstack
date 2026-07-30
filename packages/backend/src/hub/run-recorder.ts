/**
 * run-recorder — writes the `runs` + `run_messages` audit trail for bus flows.
 *
 * BRD §7.6 (Trading Network Console) depends on `run_messages`, which was never
 * written. Here a source trigger opens a `run`; the intake worker records a
 * direction='in' message per envelope and the dispatch worker a direction='out'
 * message per delivery. Everything is best-effort (never throws) so audit writes
 * can't break the data flow.
 *
 * Synthetic flows (test-publish / run-source) have no operator integration, so we
 * attribute their runs to a fixed synthetic "Hub (distributed bus)" integration.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { integrations, runs, runMessages } from '../db/schema';
import { DEFAULT_ORG } from './hub-service';

export const HUB_DEMO_INTEGRATION_ID = '00000000-0000-0000-0000-0000000000b5';

let ensured = false;

/** Idempotently create the synthetic integration that bus-trigger runs hang off. */
export async function ensureHubIntegration(): Promise<void> {
  if (ensured) return;
  try {
    await db
      .insert(integrations)
      .values({
        integrationId: HUB_DEMO_INTEGRATION_ID,
        orgId: DEFAULT_ORG,
        name: 'Hub (distributed bus)',
        status: 'active',
      })
      .onConflictDoNothing();
    ensured = true;
  } catch (err) {
    console.error('[Hub] ensureHubIntegration failed:', (err as Error).message);
  }
}

/** Open a run for a trigger; returns the runId (or null on failure). */
export async function startRun(integrationId: string = HUB_DEMO_INTEGRATION_ID): Promise<string | null> {
  try {
    const [row] = await db
      .insert(runs)
      .values({ integrationId, status: 'running' })
      .returning({ id: runs.runId });
    return row?.id ?? null;
  } catch (err) {
    console.error('[Hub] startRun failed:', (err as Error).message);
    return null;
  }
}

/**
 * Close a run with final counts/status. Only settles a run that is still in
 * flight — never clobbers a run an operator already 'cancelled'.
 *
 * THREE quantities, three columns — they are routinely different and conflating any
 * two of them loses information the UI needs:
 *   • `records_read` — rows the source produced.
 *   • `records_in`   — deliveries this run SHOULD produce (published × live targets),
 *                      i.e. the denominator `settleRun` and `getRunStatus` count against.
 *   • `records_out`  — deliveries that actually succeeded (written by `settleRun`).
 *
 * read and in diverge whenever the inbox suppresses records as unchanged duplicates: a
 * re-run over an untouched source reads 27 and publishes 0. Recording only the published
 * count left records_read unknown, so such a run was indistinguishable from one whose
 * source was empty — the card could only say "Finished / 0 delivered" and mean nothing.
 */
export async function finishRun(
  runId: string | null,
  expectedOut: number,
  opts: { recordsRead?: number; status?: 'success' | 'error' } = {},
): Promise<void> {
  if (!runId) return;
  try {
    await db
      .update(runs)
      .set({
        status: opts.status ?? 'success',
        finishedAt: new Date(),
        recordsIn: expectedOut,
        recordsRead: opts.recordsRead ?? expectedOut,
        updatedAt: new Date(),
      })
      .where(sql`${runs.runId} = ${runId} and ${runs.status} in ('running', 'pending')`);
    // Deliveries can all land BEFORE publishing returns (a fast local destination), and
    // settleRun only judges a run once finished_at is set — which happens here. Without
    // this call such a run would keep the publish-time 'success' even if every record
    // failed, because no further out-message would ever arrive to re-trigger the check.
    await settleRun(runId);
  } catch (err) {
    console.error('[Hub] finishRun failed:', (err as Error).message);
  }
}

/**
 * Mark a run 'cancelled' (cooperative stop). Idempotent, and guarded so it won't
 * overwrite a run that already settled success/error. `expectedOut`, when given,
 * records how many deliveries were queued before the stop so run-status reflects it;
 * `recordsRead` records how much of the source we got through. Same split as finishRun.
 */
export async function cancelRun(runId: string | null, expectedOut?: number, recordsRead?: number): Promise<void> {
  if (!runId) return;
  try {
    await db
      .update(runs)
      .set({
        status: 'cancelled',
        finishedAt: new Date(),
        updatedAt: new Date(),
        ...(expectedOut !== undefined ? { recordsIn: expectedOut, recordsRead: recordsRead ?? expectedOut } : {}),
      })
      // Cancel a run that is still in flight. 'running'/'pending' always. Also a
      // 'success' run whose DELIVERY hasn't finished — status flips to 'success' the
      // moment PUBLISHING completes, well before the dispatch worker has delivered, so
      // a stop mid-delivery must still be recordable as 'cancelled'. Never clobber a
      // run that already settled ('error', already 'cancelled', or a fully-delivered
      // 'success' where every published record has an out-message).
      .where(sql`${runs.runId} = ${runId}
        and ${runs.status} not in ('error', 'cancelled')
        and (
          ${runs.status} <> 'success'
          or ${runs.recordsIn} > (
            select count(*) from app.run_messages m
             where m.run_id = ${runId} and m.direction = 'out'
          )
        )`);
  } catch (err) {
    console.error('[Hub] cancelRun failed:', (err as Error).message);
  }
}

/** Record an inbound message (intake). */
export async function recordIn(runId: string, payloadHash: string): Promise<void> {
  await record(runId, 'in', 'received', payloadHash);
}

/**
 * Record an outbound delivery (dispatch). 'skipped' settles a record that reached a
 * terminal state WITHOUT a fresh delivery — it matched no subscription, was a
 * duplicate suppressed at the outbox, or was already delivered (idempotency hit).
 * Counting it keeps a run from hanging at "pending" forever (see getRunStatus).
 */
export async function recordOut(runId: string, status: 'delivered' | 'failed' | 'skipped', payloadHash: string): Promise<void> {
  await record(runId, 'out', status, payloadHash);
  await settleRun(runId);
}

/**
 * Fold the DELIVERY outcome back into the run row's status.
 *
 * `finishRun` settles a run the moment PUBLISHING ends — well before the dispatch
 * worker has delivered anything. So `runs.status` recorded the publish outcome and
 * nothing ever revisited it: a push whose every record dead-lettered ("no natural key
 * for dedup", 27/27 failed) sat in the table as `success`. The Wizard was right about
 * it because it reads the ledger through getRunStatus; everything reading `runs.status`
 * — Monitor, registry, dashboards — called that push a success.
 *
 * Called after every terminal out-message, so the row converges as deliveries land.
 * Rules:
 *   • `records_out` becomes the DELIVERED count, against the `records_in` deliveries
 *     the run expected — which is what makes the runs table read "27 in, 27 out".
 *   • the status is only judged once `finished_at` is set: before that more records are
 *     still being published, so "everything has settled" is false comfort either way.
 *   • a partial failure IS a run that needs attention, so any failure once every
 *     expected delivery has settled flips the run to 'error'; the exact counts live in
 *     run_messages / the DLQ for the UI to show.
 *   • 'cancelled' is the operator's word and is never overwritten, and a run never
 *     flips back from 'error' to 'success'.
 */
export async function settleRun(runId: string): Promise<void> {
  try {
    await db.execute(sql`
      with tally as (
        select count(*) filter (where status = 'delivered') as delivered,
               count(*) filter (where status = 'failed')    as failed,
               count(*)                                     as settled
          from app.run_messages
         where run_id = ${runId}::uuid and direction = 'out'
      )
      update app.runs r
         set records_out = t.delivered,
             status = case
                        when r.finished_at is not null
                             and r.status not in ('error', 'cancelled')
                             and t.failed > 0
                             and t.settled >= r.records_in then 'error'::app.run_status
                        else r.status
                      end,
             updated_at = now()
        from tally t
       where r.run_id = ${runId}::uuid
         and (r.records_out is distinct from t.delivered
              or (r.finished_at is not null
                  and r.status not in ('error', 'cancelled')
                  and t.failed > 0
                  and t.settled >= r.records_in))`);
  } catch (err) {
    console.error('[Hub] settleRun failed:', (err as Error).message);
  }
}

async function record(runId: string, direction: 'in' | 'out', status: string, payloadHash: string): Promise<void> {
  try {
    await db.insert(runMessages).values({
      runId,
      direction,
      status,
      payloadHash: payloadHash.slice(0, 64),
    });
  } catch (err) {
    console.error(`[Hub] run_messages ${direction} write failed:`, (err as Error).message);
  }
}
