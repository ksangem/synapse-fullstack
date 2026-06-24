/**
 * Hub dispatch worker — drains the `hub-dispatch` queue (the "delivery half").
 *
 * This is the per-subscription DISPATCH WORKER that the architecture doc calls the
 * single biggest missing piece. It performs the per-destination delivery step
 * (RouterService already wrote the PENDING outbox row), with retry delegated to
 * BullMQ instead of an in-process loop:
 *
 *   idempotency.exists? ── yes ─► skip (exactly-once per destination)
 *     │ no
 *     ▼
 *   run TransformPipeline (if the subscription has steps)
 *     ▼
 *   destination.dispatch(envelope)
 *       success ─► outbox.markDone + idempotency.record
 *       failure ─► throw → BullMQ retries (attempts:4, exp backoff)
 *                  on the FINAL exhausted attempt only ─► outbox.markFailed +
 *                  dead_letter.insert
 *
 * Design decisions honoured: #4 (dispatch logic), #5 (BullMQ-native retry, NO
 * nested withRetry, dead-letter on exhaustion only). Terminal failure is recorded
 * in the Worker `failed` event — that's where BullMQ reports the fully-incremented
 * `attemptsMade`, so "is this the last attempt?" is unambiguous across versions.
 *
 * Factory, not module-level construction (see hubIntakeWorker.ts for why).
 */

import { Worker, type ConnectionOptions, type Job } from 'bullmq';
import type { IDestinationConnector } from '../hub/interfaces';
import type { TransformPipeline } from '../hub/transform-pipeline';
import type { OutboxRepository } from '../hub/outbox-repository';
import type { IdempotencyRepository } from '../hub/idempotency-repository';
import type { DeadLetterRepository } from '../hub/dead-letter-repository';
import type { DispatchJobData } from '../hub/router-service';
import { HUB_DISPATCH_QUEUE } from '../hub/queue-names';
import { recordOut } from '../hub/run-recorder';
import { isRunCancelled } from '../hub/run-cancellation';

export interface HubDispatchDeps {
  /** Resolve a destination connector by id (e.g. hubService.getDestination). */
  resolveDestination: (connectorId: string) => IDestinationConnector | undefined;
  pipeline: TransformPipeline;
  outbox: OutboxRepository;
  idempotency: IdempotencyRepository;
  deadLetter: DeadLetterRepository;
}

export function startHubDispatchWorker(
  deps: HubDispatchDeps,
  connection: ConnectionOptions,
): Worker {
  const { resolveDestination, pipeline, outbox, idempotency, deadLetter } = deps;

  const worker = new Worker<DispatchJobData>(
    HUB_DISPATCH_QUEUE,
    async (job: Job<DispatchJobData>) => {
      const { envelope, destinationConnectorId, transformSteps } = job.data;
      const { orgId, messageId } = envelope;
      const signal = new AbortController().signal;

      // Cooperative stop — if the run was cancelled, don't deliver this queued
      // envelope. Settle BOTH the outbox row (so the Monitor doesn't show it stuck
      // at 'pending' forever) and the run ledger (so the run's pending count reaches
      // zero and run-status can report finished).
      const runId = envelope.headers?.runId;
      if (isRunCancelled(runId)) {
        await outbox.markDone(orgId, messageId, destinationConnectorId);
        if (runId) await recordOut(runId, 'skipped', envelope.checksum);
        return;
      }

      // Exactly-once per destination — a retry/crash-recovery duplicate is skipped.
      // Settle the outbox row (already delivered on a prior pass) and the run ledger.
      if (await idempotency.exists(orgId, messageId, destinationConnectorId)) {
        await outbox.markDone(orgId, messageId, destinationConnectorId);
        const skipRunId = envelope.headers?.runId;
        if (skipRunId) await recordOut(skipRunId, 'skipped', envelope.checksum);
        return;
      }

      const destination = resolveDestination(destinationConnectorId);
      if (!destination) {
        throw new Error(`No destination connector "${destinationConnectorId}" registered`);
      }

      let outbound = envelope;
      if (transformSteps && transformSteps.length > 0) {
        outbound = await pipeline.execute(envelope, transformSteps, signal);
      }

      await destination.dispatch(outbound, signal);
      await outbox.markDone(orgId, messageId, destinationConnectorId);
      await idempotency.record(orgId, messageId, destinationConnectorId);

      if (runId) await recordOut(runId, 'delivered', envelope.checksum);
    },
    { connection, concurrency: 5 },
  );

  // Dead-letter only when BullMQ has exhausted all attempts for this job.
  worker.on('failed', (job, err) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) return; // more retries pending — wait

    const { envelope, destinationConnectorId } = job.data;
    const message = err?.message ?? String(err);
    void (async () => {
      try {
        await outbox.markFailed(envelope.orgId, envelope.messageId, destinationConnectorId, message);
        await deadLetter.insert(envelope, destinationConnectorId, message);
        const runId = envelope.headers?.runId;
        if (runId) await recordOut(runId, 'failed', envelope.checksum);
        console.error(`[HubDispatch] dead-lettered ${envelope.messageId} → ${destinationConnectorId}: ${message}`);
      } catch (e) {
        console.error('[HubDispatch] failed to record dead-letter:', e);
      }
    })();
  });

  return worker;
}
