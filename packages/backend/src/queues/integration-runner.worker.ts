import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { JiraIntegration, type JiraIntegrationConfig } from '../integrations/jira';
import { db } from '../db/client';
import { runs } from '../db/schema';
import { eq } from 'drizzle-orm';

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

interface IntegrationRunnerJob {
  integrationId: string;
  runId: string;
  config: JiraIntegrationConfig;
}

const worker = new Worker<IntegrationRunnerJob>(
  'integration-runner',
  async (job) => {
    const { integrationId, runId, config: integrationConfig } = job.data;

    console.log(`Processing integration run: ${runId} for integration: ${integrationId}`);

    // Update run status to running
    await db.update(runs)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(runs.runId, runId));

    const integration = new JiraIntegration();
    const result = await integration.run(integrationId, integrationConfig, runId);

    if (result.errors.length > 0) {
      await db.update(runs)
        .set({
          status: 'error',
          errorLog: result.errors,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(runs.runId, runId));
    }

    return result;
  },
  { connection }
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`Job ${job?.id} failed:`, err.message);
});

export { worker };
