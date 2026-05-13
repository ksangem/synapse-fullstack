import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const integrationRunnerQueue = new Queue('integration-runner', { connection });
export const playwrightSessionsQueue = new Queue('playwright-sessions', { connection });
export const alertDispatcherQueue = new Queue('alert-dispatcher', { connection });
export const credentialRotatorQueue = new Queue('credential-rotator', { connection });

export { connection as redisConnection };
