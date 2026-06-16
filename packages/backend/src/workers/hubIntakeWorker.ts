/**
 * Hub intake worker — drains the `hub-intake` queue.
 *
 * Each job carries a published MessageEnvelope; the worker hands it to
 * RouterService.route, which fans it out to the `hub-dispatch` queue per matching
 * subscription.
 *
 * Exposed as a FACTORY (not a module-level `new Worker`) on purpose: a BullMQ
 * Worker starts consuming as a side-effect of construction, so importing this file
 * must never start it. `initHub()` calls the factory only when HUB_ENABLED is on.
 */

import { Worker, type ConnectionOptions } from 'bullmq';
import type { RouterService } from '../hub/router-service';
import type { MessageEnvelope } from '../hub/interfaces';
import { HUB_INTAKE_QUEUE } from '../hub/queue-names';
import { recordIn } from '../hub/run-recorder';

export function startHubIntakeWorker(
  router: RouterService,
  connection: ConnectionOptions,
): Worker {
  const worker = new Worker(
    HUB_INTAKE_QUEUE,
    async (job) => {
      const { envelope } = job.data as { envelope: MessageEnvelope };
      const runId = envelope.headers?.runId;
      if (runId) await recordIn(runId, envelope.checksum);
      const dispatched = await router.route(envelope);
      return { dispatched };
    },
    { connection, concurrency: 5 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[HubIntake] job ${job?.id} failed:`, err?.message ?? err);
  });

  return worker;
}
