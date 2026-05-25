/**
 * IntegrationBus — BullMQ-backed publish + intake.
 *
 * Source connectors publish MessageEnvelopes to the "intake" queue.
 * The RouterService consumes intake and re-enqueues to per-subscription queues.
 */

import { Queue, type ConnectionOptions } from 'bullmq';
import type { MessageEnvelope } from './interfaces';
import type { InboxRepository } from './inbox-repository';

const INTAKE_QUEUE_NAME = 'hub-intake';

export class IntegrationBus {
  private intakeQueue: Queue;

  constructor(
    private readonly inboxRepo: InboxRepository,
    connection: ConnectionOptions,
  ) {
    this.intakeQueue = new Queue(INTAKE_QUEUE_NAME, { connection });
  }

  /**
   * Publish a message to the hub.
   * 1. Write PENDING row in inbox (durability checkpoint).
   * 2. Enqueue to the intake queue.
   * Returns the inbox entry id, or null if it was a duplicate.
   */
  async publish(envelope: MessageEnvelope): Promise<string | null> {
    // Durability checkpoint — survives crash
    const inboxId = await this.inboxRepo.insert(envelope);
    if (inboxId === null) {
      // Duplicate message — already in inbox
      return null;
    }

    // Enqueue for routing
    await this.intakeQueue.add('intake', {
      envelope,
      inboxId,
    }, {
      jobId: `${envelope.orgId}:${envelope.messageId}`,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });

    return inboxId;
  }

  /**
   * Get the name of the intake queue (for worker binding).
   */
  get intakeQueueName(): string {
    return INTAKE_QUEUE_NAME;
  }

  /**
   * Get subscription queue name for a given subscription id.
   */
  static subscriptionQueueName(subscriptionId: string): string {
    return `subscription:${subscriptionId}`;
  }

  async close(): Promise<void> {
    await this.intakeQueue.close();
  }
}
