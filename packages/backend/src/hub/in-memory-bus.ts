/**
 * InMemoryBus — the hub's in-memory IntegrationBus + Router (T-02, direction A).
 *
 * Source connectors publish() envelopes onto a BoundedQueue (backpressure).
 * A single consumer loop pulls each envelope, asks the SubscriptionRegistry
 * which subscriptions match (org-scoped topic match), and FANS OUT a copy to
 * each matching subscription's destination connector — optionally running that
 * subscription's transform steps first.
 *
 * This is the no-Redis core delivery loop the plan calls for:
 *   "IntegrationBus + Router + Subscription registry (in-memory queue + fan-out),
 *    backpressure via bounded queue."
 */

import type { MessageEnvelope, IDestinationConnector, Subscription } from './interfaces';
import { SubscriptionRegistry } from './subscription-registry';
import { BoundedQueue } from './bounded-queue';
import { TransformPipeline } from './transform-pipeline';
import { validateChecksum } from './envelope';

export interface DeliveryError {
  envelope: MessageEnvelope;
  subscription: Subscription;
  error: Error;
}

export interface InMemoryBusOptions {
  /** Bounded queue capacity (backpressure threshold). Default 1000. */
  capacity?: number;
  /** Verify the SHA-256 checksum on publish to catch corrupted payloads. Default true. */
  validateChecksums?: boolean;
  /** Optional pipeline used when a subscription declares transformSteps. */
  pipeline?: TransformPipeline;
  /** Called when a single fan-out delivery fails (the loop continues). */
  onDeliveryError?: (err: DeliveryError) => void;
}

export interface RouteResult {
  matched: number;
  delivered: number;
  failed: number;
}

/** Resolves a destinationConnectorId to a live connector instance. */
export type DestinationResolver = (connectorId: string) => IDestinationConnector | undefined;

export class InMemoryBus {
  private readonly queue: BoundedQueue<MessageEnvelope>;
  private readonly validateChecksums: boolean;
  private readonly pipeline?: TransformPipeline;
  private readonly onDeliveryError?: (err: DeliveryError) => void;

  private controller = new AbortController();
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly registry: SubscriptionRegistry,
    private readonly resolveDestination: DestinationResolver,
    options: InMemoryBusOptions = {},
  ) {
    this.queue = new BoundedQueue<MessageEnvelope>(options.capacity ?? 1000);
    this.validateChecksums = options.validateChecksums ?? true;
    this.pipeline = options.pipeline;
    this.onDeliveryError = options.onDeliveryError;
  }

  /** Items currently buffered in the bounded queue. */
  get queueSize(): number {
    return this.queue.size;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Publish an envelope into the hub. Applies backpressure: the returned
   * promise does not resolve until the bounded queue has room. Throws on a
   * checksum mismatch (corrupted payload) when validation is enabled.
   */
  async publish(envelope: MessageEnvelope): Promise<void> {
    if (this.validateChecksums && !validateChecksum(envelope)) {
      throw new Error(
        `Checksum mismatch for message ${envelope.messageId}: payload does not match envelope checksum`,
      );
    }
    await this.queue.enqueue(envelope);
  }

  /** Start the consumer loop. Idempotent. */
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
   * Route a single envelope to every matching subscription (fan-out).
   * Exposed directly so it can be unit-tested without the loop.
   */
  async route(envelope: MessageEnvelope): Promise<RouteResult> {
    const subs = this.registry.findForEnvelope(envelope);
    let delivered = 0;
    let failed = 0;

    for (const sub of subs) {
      try {
        await this.deliver(envelope, sub);
        delivered++;
      } catch (error) {
        failed++;
        this.onDeliveryError?.({ envelope, subscription: sub, error: error as Error });
      }
    }

    return { matched: subs.length, delivered, failed };
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

    await destination.dispatch(outbound, this.controller.signal);
  }

  /**
   * Stop the consumer loop and release the queue. Aborts in-flight dispatch
   * via the shared AbortSignal, then waits for the loop to finish.
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.queue.close();
    this.controller.abort();
    if (this.loop) await this.loop;
  }
}
