import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { HUB_INTAKE_QUEUE, HUB_DISPATCH_QUEUE } from '../hub/queue-names';

const connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });

export const playwrightSessionsQueue = new Queue('playwright-sessions', { connection });
export const alertDispatcherQueue = new Queue('alert-dispatcher', { connection });
export const credentialRotatorQueue = new Queue('credential-rotator', { connection });

// Distributed Integration Bus — the two fixed queues (decision #2). These are
// producer handles; the consuming Workers are started only by initHub (gated by
// HUB_ENABLED), so declaring the queues here doesn't start the bus.
export const hubIntakeQueue = new Queue(HUB_INTAKE_QUEUE, { connection });
export const hubDispatchQueue = new Queue(HUB_DISPATCH_QUEUE, { connection });

export { connection as redisConnection };
