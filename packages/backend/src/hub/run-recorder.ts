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

/** Close a run with final counts/status. */
export async function finishRun(runId: string | null, recordsIn: number, status: 'success' | 'error' = 'success'): Promise<void> {
  if (!runId) return;
  try {
    await db
      .update(runs)
      .set({ status, finishedAt: new Date(), recordsIn, updatedAt: new Date() })
      .where(sql`${runs.runId} = ${runId}`);
  } catch (err) {
    console.error('[Hub] finishRun failed:', (err as Error).message);
  }
}

/** Record an inbound message (intake). */
export async function recordIn(runId: string, payloadHash: string): Promise<void> {
  await record(runId, 'in', 'received', payloadHash);
}

/** Record an outbound delivery (dispatch). */
export async function recordOut(runId: string, status: 'delivered' | 'failed', payloadHash: string): Promise<void> {
  await record(runId, 'out', status, payloadHash);
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
