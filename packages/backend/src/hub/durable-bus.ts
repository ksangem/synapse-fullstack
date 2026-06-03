/**
 * DurableBus — store-and-forward delivery on top of the in-memory fan-out (T-03).
 *
 * This is the durability layer. Where T-02's InMemoryBus routes messages purely
 * in RAM (fast but lost on crash), DurableBus checkpoints every step to Postgres
 * via the four hub repositories, so nothing is silently lost or double-delivered:
 *
 *   publish  → INBOX(pending)          durable intake checkpoint (dedups re-delivery)
 *   route    → INBOX(processing)
 *     per matching subscription:
 *            → IDEMPOTENCY.exists?      skip if this (msg,dest) was already delivered
 *            → OUTBOX(pending)          record dispatch intent for this destination
 *            → dispatch
 *                 success → OUTBOX(done) + IDEMPOTENCY.record
 *                 failure → OUTBOX(failed) + DEAD-LETTER(insert for retry)
 *            → INBOX(done|failed)
 *
 * The persistence dependencies are expressed as narrow ports so the real Drizzle
 * repositories satisfy them structurally, and tests can inject in-memory fakes.
 */

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { MessageEnvelope, IDestinationConnector, Subscription } from './interfaces';
import { SubscriptionRegistry } from './subscription-registry';
import { BoundedQueue } from './bounded-queue';
import { TransformPipeline } from './transform-pipeline';
import { validateChecksum } from './envelope';
import { InboxRepository } from './inbox-repository';
import { OutboxRepository } from './outbox-repository';
import { IdempotencyRepository } from './idempotency-repository';
import { DeadLetterRepository } from './dead-letter-repository';
import { withRetry, NO_RETRY, type RetryPolicy } from './retry';
import { CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from './circuit-breaker';
import type { DestinationResolver } from './in-memory-bus';

// ── Persistence ports (the Drizzle repos satisfy these structurally) ──
export interface InboxPort {
  insert(envelope: MessageEnvelope): Promise<string | null>;
  markProcessing(orgId: string, messageId: string): Promise<boolean>;
  markDone(orgId: string, messageId: string): Promise<boolean>;
  markFailed(orgId: string, messageId: string, error: string): Promise<boolean>;
}
export interface OutboxPort {
  insert(envelope: MessageEnvelope, destConnectorId: string): Promise<string | null>;
  markDone(orgId: string, messageId: string, destConnectorId: string): Promise<boolean>;
  markFailed(orgId: string, messageId: string, destConnectorId: string, error: string): Promise<boolean>;
}
export interface IdempotencyPort {
  exists(orgId: string, messageId: string, destConnectorId: string): Promise<boolean>;
  record(orgId: string, messageId: string, destConnectorId: string): Promise<boolean>;
}
export interface DeadLetterPort {
  insert(envelope: MessageEnvelope, destConnectorId: string, error: string): Promise<string>;
}

export interface DurablePorts {
  inbox: InboxPort;
  outbox: OutboxPort;
  idempotency: IdempotencyPort;
  deadLetter: DeadLetterPort;
}

export interface DurableBusOptions {
  capacity?: number;
  validateChecksums?: boolean;
  pipeline?: TransformPipeline;
  onDeliveryError?: (err: { envelope: MessageEnvelope; subscription: Subscription; error: Error }) => void;
  /** Retry policy for a single dispatch (T-04). Default NO_RETRY (one attempt). */
  retry?: RetryPolicy;
  /** Enable a per-destination circuit breaker (T-04). Omit to disable. */
  circuitBreaker?: CircuitBreakerOptions;
}

export interface PublishResult {
  accepted: boolean;
  /** True when the message was already in the inbox (re-delivery suppressed). */
  duplicate: boolean;
  inboxId: string | null;
}

export interface DurableRouteResult {
  matched: number;
  delivered: number;
  failed: number;
  /** Destinations skipped because idempotency showed an earlier delivery. */
  skipped: number;
}

export class DurableBus {
  private readonly queue: BoundedQueue<MessageEnvelope>;
  private readonly validateChecksums: boolean;
  private readonly pipeline?: TransformPipeline;
  private readonly onDeliveryError?: DurableBusOptions['onDeliveryError'];
  private readonly retryPolicy: RetryPolicy;
  private readonly breakerOptions?: CircuitBreakerOptions;
  private readonly breakers = new Map<string, CircuitBreaker>();

  private controller = new AbortController();
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly registry: SubscriptionRegistry,
    private readonly resolveDestination: DestinationResolver,
    private readonly ports: DurablePorts,
    options: DurableBusOptions = {},
  ) {
    this.queue = new BoundedQueue<MessageEnvelope>(options.capacity ?? 1000);
    this.validateChecksums = options.validateChecksums ?? true;
    this.pipeline = options.pipeline;
    this.onDeliveryError = options.onDeliveryError;
    this.retryPolicy = options.retry ?? NO_RETRY;
    this.breakerOptions = options.circuitBreaker;
  }

  /** Per-destination circuit-breaker state (for monitoring/tests). */
  circuitState(destConnectorId: string): CircuitState | 'disabled' {
    if (!this.breakerOptions) return 'disabled';
    return this.breakers.get(destConnectorId)?.currentState ?? 'closed';
  }

  private breakerFor(destConnectorId: string): CircuitBreaker | undefined {
    if (!this.breakerOptions) return undefined;
    let breaker = this.breakers.get(destConnectorId);
    if (!breaker) {
      breaker = new CircuitBreaker(this.breakerOptions);
      this.breakers.set(destConnectorId, breaker);
    }
    return breaker;
  }

  get queueSize(): number {
    return this.queue.size;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Durable publish: checkpoint to the inbox first, then enqueue. A message
   * already present in the inbox (same orgId+messageId) is suppressed as a
   * duplicate and never enqueued. Applies backpressure via the bounded queue.
   */
  async publish(envelope: MessageEnvelope): Promise<PublishResult> {
    if (this.validateChecksums && !validateChecksum(envelope)) {
      throw new Error(
        `Checksum mismatch for message ${envelope.messageId}: payload does not match envelope checksum`,
      );
    }

    const inboxId = await this.ports.inbox.insert(envelope);
    if (inboxId === null) {
      return { accepted: false, duplicate: true, inboxId: null };
    }

    await this.queue.enqueue(envelope);
    return { accepted: true, duplicate: false, inboxId };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    this.loop = this.runLoop();
  }

  private async runLoop(): Promise<void> {
    for await (const envelope of this.queue) {
      await this.route(envelope);
    }
  }

  /**
   * Durably route one envelope to all matching subscriptions, persisting each
   * step. Exposed directly for unit testing without the consumer loop.
   */
  async route(envelope: MessageEnvelope): Promise<DurableRouteResult> {
    const { orgId, messageId } = envelope;
    await this.ports.inbox.markProcessing(orgId, messageId);

    const subs = this.registry.findForEnvelope(envelope);
    let delivered = 0;
    let failed = 0;
    let skipped = 0;

    for (const sub of subs) {
      const dest = sub.destinationConnectorId;

      // Idempotency: don't re-deliver to a destination that already got this message.
      if (await this.ports.idempotency.exists(orgId, messageId, dest)) {
        skipped++;
        continue;
      }

      await this.ports.outbox.insert(envelope, dest);

      try {
        await this.deliver(envelope, sub);
        await this.ports.outbox.markDone(orgId, messageId, dest);
        await this.ports.idempotency.record(orgId, messageId, dest);
        delivered++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.ports.outbox.markFailed(orgId, messageId, dest, message);
        await this.ports.deadLetter.insert(envelope, dest, message);
        failed++;
        this.onDeliveryError?.({ envelope, subscription: sub, error: error as Error });
      }
    }

    // Inbox terminal state: failed only if every attempt failed and nothing got through.
    if (failed > 0 && delivered === 0) {
      await this.ports.inbox.markFailed(orgId, messageId, `${failed} destination(s) failed`);
    } else {
      await this.ports.inbox.markDone(orgId, messageId);
    }

    return { matched: subs.length, delivered, failed, skipped };
  }

  private async deliver(envelope: MessageEnvelope, sub: Subscription): Promise<void> {
    const destination = this.resolveDestination(sub.destinationConnectorId);
    if (!destination) {
      throw new Error(
        `No destination connector "${sub.destinationConnectorId}" registered for subscription "${sub.id}"`,
      );
    }

    let outbound = envelope;
    if (this.pipeline && sub.transformSteps.length > 0) {
      outbound = await this.pipeline.execute(envelope, sub.transformSteps, this.controller.signal);
    }

    const dispatch = () => destination.dispatch(outbound, this.controller.signal);
    // Retry transient failures within this delivery (no-op when maxAttempts === 1)…
    const attempt = this.retryPolicy.maxAttempts > 1
      ? () => withRetry(dispatch, this.retryPolicy)
      : dispatch;
    // …and guard the destination with a circuit breaker when enabled.
    const breaker = this.breakerFor(sub.destinationConnectorId);
    if (breaker) {
      await breaker.exec(attempt);
    } else {
      await attempt();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.queue.close();
    this.controller.abort();
    if (this.loop) await this.loop;
  }
}

// Re-export for convenience so callers can type the resolver.
export type { IDestinationConnector };

/**
 * Production wiring: build the four durable ports from the live Drizzle
 * repositories. This also gives the compiler a place to verify that each real
 * repository structurally satisfies its port.
 */
export function createDurablePorts(
  db: NodePgDatabase<Record<string, unknown>>,
): DurablePorts {
  return {
    inbox: new InboxRepository(db),
    outbox: new OutboxRepository(db),
    idempotency: new IdempotencyRepository(db),
    deadLetter: new DeadLetterRepository(db),
  };
}
