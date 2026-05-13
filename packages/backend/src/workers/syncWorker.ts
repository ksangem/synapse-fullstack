import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { runSync } from '../services/SyncService';
import type { SyncTriggerPayload } from '../types/sync.types';

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const syncQueue = new Queue('jira-sp-sync', { connection });

/** Default options for scheduled syncs — safest automatic mode */
export const DEFAULT_SYNC_OPTIONS: SyncTriggerPayload = {
  mode: 'EXTEND_TO_TODAY',
  skipCompleted: true,
  deltaOnly: true,
};

export const syncWorker = new Worker('jira-sp-sync', async (job) => {
  const { integrationId, options, triggeredBy } = job.data as {
    integrationId: string;
    options?: SyncTriggerPayload;
    triggeredBy: string;
  };

  const syncOptions = options ?? DEFAULT_SYNC_OPTIONS;

  console.log(`[SyncWorker] Processing job ${job.id} for integration ${integrationId} (mode=${syncOptions.mode})`);
  await runSync(integrationId, syncOptions, triggeredBy);
}, {
  connection,
  concurrency: 3,
});

syncWorker.on('completed', (job) => {
  console.log(`[SyncWorker] Job ${job.id} completed`);
});

syncWorker.on('failed', (job, err) => {
  console.error(`[SyncWorker] Job ${job?.id} failed:`, err.message);
});
