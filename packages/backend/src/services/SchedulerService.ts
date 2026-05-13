import { db } from '../db/client';
import { integrations } from '../db/schema';
import { isNotNull } from 'drizzle-orm';
import { syncQueue, DEFAULT_SYNC_OPTIONS } from '../workers/syncWorker';

/**
 * On app startup, register BullMQ repeatable jobs for all integrations
 * that have a schedule_cron set.
 */
export async function initScheduler(): Promise<void> {
  const scheduled = await db.select().from(integrations)
    .where(isNotNull(integrations.scheduleCron));

  let count = 0;
  for (const integration of scheduled) {
    if (!integration.scheduleCron) continue;

    try {
      await syncQueue.upsertJobScheduler(
        `sync-${integration.integrationId}`,
        { pattern: integration.scheduleCron },
        {
          data: {
            integrationId: integration.integrationId,
            options: DEFAULT_SYNC_OPTIONS,
            triggeredBy: 'SCHEDULER',
          },
        }
      );
      count++;
      console.log(`[Scheduler] Registered sync for ${integration.integrationId} at "${integration.scheduleCron}"`);
    } catch (err) {
      console.error(`[Scheduler] Failed to register ${integration.integrationId}:`, err);
    }
  }

  console.log(`[Scheduler] Initialized ${count} scheduled sync jobs`);
}

/**
 * Update or create a scheduled sync for a single integration.
 */
export async function upsertSchedule(integrationId: string, cron: string): Promise<void> {
  await syncQueue.upsertJobScheduler(
    `sync-${integrationId}`,
    { pattern: cron },
    {
      data: {
        integrationId,
        options: DEFAULT_SYNC_OPTIONS,
        triggeredBy: 'SCHEDULER',
      },
    }
  );
  console.log(`[Scheduler] Upserted sync for ${integrationId} at "${cron}"`);
}

/**
 * Remove a scheduled sync for an integration.
 */
export async function removeSchedule(integrationId: string): Promise<void> {
  await syncQueue.removeJobScheduler(`sync-${integrationId}`);
  console.log(`[Scheduler] Removed sync schedule for ${integrationId}`);
}
