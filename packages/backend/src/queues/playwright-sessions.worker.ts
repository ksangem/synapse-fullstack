import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

interface PlaywrightSessionJob {
  integrationId: string;
  runId: string;
  approach: 'flatiron';
}

// Playwright sessions MUST run serially — concurrency: 1
const worker = new Worker<PlaywrightSessionJob>(
  'playwright-sessions',
  async (job) => {
    const { integrationId, runId } = job.data;
    console.log(`Processing Playwright session for run: ${runId}, integration: ${integrationId}`);
    // Actual Flatiron scraping is handled by the JiraIntegration class
    // This worker is specifically for managing browser session serialization
  },
  {
    connection,
    concurrency: 1,
  }
);

worker.on('completed', (job) => {
  console.log(`Playwright session ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Playwright session ${job?.id} failed:`, err.message);
});

export { worker };
