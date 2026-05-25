/**
 * RouterService — topic → subscription fan-out.
 *
 * Consumes the intake queue and re-enqueues to per-subscription queues.
 * Each subscription has its own BullMQ queue: "subscription:{id}".
 */

import { Queue, type ConnectionOptions } from 'bullmq';
import type { MessageEnvelope, Subscription } from './interfaces';
import { IntegrationBus } from './integration-bus';
import type { InboxRepository } from './inbox-repository';
import type { OutboxRepository } from './outbox-repository';

export class RouterService {
  private subscriptionQueues = new Map<string, Queue>();

  constructor(
    private readonly inboxRepo: InboxRepository,
    private readonly outboxRepo: OutboxRepository,
    private readonly subscriptions: Subscription[],
    private readonly connection: ConnectionOptions,
  ) {}

  /**
   * Route an envelope to all matching subscriptions.
   * A subscription matches if its topic equals the envelope's topic
   * (exact match or glob with wildcard support).
   */
  async route(envelope: MessageEnvelope): Promise<number> {
    // Mark inbox as processing
    await this.inboxRepo.markProcessing(envelope.orgId, envelope.messageId);

    const matchingSubs = this.subscriptions.filter((sub) =>
      this.topicMatches(sub.topic, envelope.topic),
    );

    let dispatched = 0;

    for (const sub of matchingSubs) {
      // Write PENDING outbox entry for each destination
      const outboxId = await this.outboxRepo.insert(
        envelope,
        sub.destinationConnectorId,
      );

      if (outboxId === null) {
        // Duplicate — already dispatched to this destination
        continue;
      }

      // Enqueue to subscription-specific queue
      const queue = this.getOrCreateQueue(sub.id);
      await queue.add('dispatch', {
        envelope,
        subscriptionId: sub.id,
        destinationConnectorId: sub.destinationConnectorId,
        transformSteps: sub.transformSteps,
      }, {
        jobId: `${envelope.orgId}:${envelope.messageId}:${sub.id}`,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });

      dispatched++;
    }

    // If no subscriptions matched, still mark inbox as done
    if (dispatched === 0) {
      await this.inboxRepo.markDone(envelope.orgId, envelope.messageId);
    }

    return dispatched;
  }

  /**
   * Simple topic matching with wildcard support.
   * Supports: exact match, trailing wildcard (e.g., "sharepoint.*").
   */
  private topicMatches(pattern: string, topic: string): boolean {
    if (pattern === topic) return true;
    if (pattern === '*') return true;

    // Support trailing wildcard: "sharepoint.projects.*"
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return topic.startsWith(prefix + '.') || topic === prefix;
    }

    // Support segment wildcard: "sharepoint.*.created"
    const patternParts = pattern.split('.');
    const topicParts = topic.split('.');
    if (patternParts.length !== topicParts.length) return false;

    return patternParts.every(
      (part, i) => part === '*' || part === topicParts[i],
    );
  }

  private getOrCreateQueue(subscriptionId: string): Queue {
    const name = IntegrationBus.subscriptionQueueName(subscriptionId);
    let queue = this.subscriptionQueues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection });
      this.subscriptionQueues.set(name, queue);
    }
    return queue;
  }

  async close(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const queue of this.subscriptionQueues.values()) {
      closePromises.push(queue.close());
    }
    await Promise.all(closePromises);
    this.subscriptionQueues.clear();
  }
}
