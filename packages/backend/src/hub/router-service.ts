/**
 * RouterService — topic → subscription fan-out (the "sorting half" of the bus).
 *
 * Drains the `hub-intake` queue (one job per published envelope) and, for every
 * subscription whose topic pattern matches, enqueues a job onto the single
 * constant `hub-dispatch` queue. The dispatch worker (the "delivery half")
 * consumes those jobs.
 *
 * Locked design decisions (SYNAPSE_UPGRADE_PLAN.md):
 *   #2 — ONE shared `hub-dispatch` queue (not per-subscription queues). The job
 *        payload carries subscriptionId/destinationConnectorId/transformSteps.
 *   #3 — matching uses the LIVE `SubscriptionRegistry` (org-scoped
 *        `findForEnvelope`); inbox is marked `done` right after enqueue. Inbox is
 *        the "routed" checkpoint; OUTBOX is delivery truth, dead_letter is failure
 *        truth.
 *   #5 — retry is BullMQ-native: each dispatch job carries `attempts: 4` +
 *        exponential backoff (the dispatch worker dead-letters on exhaustion only).
 */

import type { MessageEnvelope } from './interfaces';
import type { SubscriptionRegistry } from './subscription-registry';
import type { InboxRepository } from './inbox-repository';
import type { OutboxRepository } from './outbox-repository';
import { hubDispatchQueue } from '../queues';
import { recordOut } from './run-recorder';

/** Payload of a `hub-dispatch` job — everything the dispatch worker needs. */
export interface DispatchJobData {
  envelope: MessageEnvelope;
  subscriptionId: string;
  destinationConnectorId: string;
  transformSteps: readonly string[];
}

export class RouterService {
  // The shared `hub-dispatch` producer queue (declared in queues/index.ts).
  private readonly dispatchQueue = hubDispatchQueue;

  constructor(
    private readonly registry: SubscriptionRegistry,
    private readonly inboxRepo: InboxRepository,
    private readonly outboxRepo: OutboxRepository,
  ) {}

  /**
   * Route one envelope to every matching subscription. Returns the number of
   * dispatch jobs enqueued (0 when no subscription matched, or all were already
   * dispatched to their destination).
   */
  async route(envelope: MessageEnvelope): Promise<number> {
    const { orgId, messageId } = envelope;

    await this.inboxRepo.markProcessing(orgId, messageId);

    const subs = this.registry.findForEnvelope(envelope);
    let dispatched = 0;

    for (const sub of subs) {
      // Record dispatch intent per destination BEFORE enqueuing (transactional
      // outbox). A duplicate (same msg → same dest) is suppressed here.
      const outboxId = await this.outboxRepo.insert(envelope, sub.destinationConnectorId);
      if (outboxId === null) continue;

      const data: DispatchJobData = {
        envelope,
        subscriptionId: sub.id,
        destinationConnectorId: sub.destinationConnectorId,
        transformSteps: sub.transformSteps,
      };

      await this.dispatchQueue.add('dispatch', data, {
        // BullMQ disallows ':' in custom job ids (it's the Redis key separator).
        jobId: `${orgId}__${messageId}__${sub.id}`,
        attempts: 4,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });

      dispatched++;
    }

    // If this envelope produced NO dispatch job — no subscription matched, or every
    // match was an already-dispatched duplicate (outbox-suppressed) — settle it as
    // 'skipped' on the run ledger. Without this a run whose records have no live
    // destination sits at 'pending' forever (the "queued" hang); 'skipped' is a
    // terminal outcome that lets getRunStatus report the run finished.
    if (dispatched === 0) {
      const runId = envelope.headers?.runId;
      if (runId) await recordOut(runId, 'skipped', envelope.checksum);
    }

    // Inbox = "routed" checkpoint: once fan-out is enqueued the envelope's intake
    // is complete. Delivery success/failure lives in outbox + dead_letter.
    await this.inboxRepo.markDone(orgId, messageId);

    return dispatched;
  }

  async close(): Promise<void> {
    // The dispatch queue is shared (owned by queues/index.ts) — nothing to close here.
  }
}
