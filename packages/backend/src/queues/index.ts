import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config';
import { HUB_INTAKE_QUEUE, HUB_DISPATCH_QUEUE } from '../hub/queue-names';

/**
 * LAZY on purpose. These used to be module-level `new IORedis(...)` / `new Queue(...)`
 * constants, so merely IMPORTING any module that transitively reached this file opened a
 * Redis socket — including unit tests that never enqueue anything. Under a full parallel
 * test run that made the first dynamic import of router-service block long enough to blow
 * a 5s test timeout (the intermittently-failing "shelves a message that matches NO
 * subscription" case), and in production it meant a process that only reads could still
 * hold Redis connections.
 *
 * Each accessor memoises, so callers still share ONE connection and one queue instance —
 * the connection is simply opened on first real use instead of at import time.
 */

let connection: IORedis | undefined;
export function getRedisConnection(): IORedis {
  if (!connection) connection = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

const queues = new Map<string, Queue>();
function queue(name: string): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: getRedisConnection() });
    queues.set(name, q);
  }
  return q;
}

export const getCredentialRotatorQueue = (): Queue => queue('credential-rotator');

// Alert dispatcher — producer handle for the standalone alert-raising scanner
// (run-failure / DLQ-depth / SLA). The consuming Worker is started by initHub, like the
// credential scanner; obtaining the queue here does not start it.
export const getAlertDispatcherQueue = (): Queue => queue('alert-dispatcher');

// Distributed Integration Bus — the two fixed queues (decision #2). These are producer
// handles; the consuming Workers are started only by initHub (gated by HUB_ENABLED), so
// obtaining the queues here doesn't start the bus.
export const getHubIntakeQueue = (): Queue => queue(HUB_INTAKE_QUEUE);
export const getHubDispatchQueue = (): Queue => queue(HUB_DISPATCH_QUEUE);
