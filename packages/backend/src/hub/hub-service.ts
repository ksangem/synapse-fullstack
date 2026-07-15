/**
 * HubService — the live, app-wide hub wiring (T-04 UI vertical slice).
 *
 * Stands up a single instance of the hub's runtime pieces against the real
 * database so HTTP routes (and, later, the live ingest flow) can use them:
 *   - SubscriptionRegistry           (T-02)
 *   - destination connector registry (id → IDestinationConnector)
 *   - DeadLetterRepository           (T-03, persistence)
 *   - DlqReplayService               (T-04, manual + auto replay)
 *
 * Replay re-dispatches a dead-lettered envelope to its *registered* destination
 * connector. Real connectors (SharePoint→DB, etc.) register themselves here; an
 * unregistered destination causes replay to fail (correct — no demo target).
 */

import { db } from '../db/client';
import { SubscriptionRegistry } from './subscription-registry';
import { DeadLetterRepository } from './dead-letter-repository';
import { DlqReplayService } from './dlq-replay-service';
import type { TransformPipeline } from './transform-pipeline';
import type { IDestinationConnector, MessageEnvelope } from './interfaces';

import { DEFAULT_ORG_ID } from '../constants';

export const DEFAULT_ORG = DEFAULT_ORG_ID;

class HubService {
  readonly registry = new SubscriptionRegistry();
  readonly deadLetterRepo = new DeadLetterRepository(db);
  readonly replayService: DlqReplayService;

  private readonly destinations = new Map<string, IDestinationConnector>();
  private pipeline: TransformPipeline | null = null;

  constructor() {
    const redeliver = async (envelope: MessageEnvelope, destConnectorId: string): Promise<void> => {
      const dest = this.destinations.get(destConnectorId);
      if (!dest) {
        throw new Error(`No destination connector registered for "${destConnectorId}"`);
      }
      // A dead-lettered envelope is stored RAW (pre-transform). The live dispatch worker
      // runs the subscription's transform pipeline before dispatching; replay MUST do the
      // same, or the destination receives an unmapped payload (no Title/natural key) and
      // fails the dedup check immediately. Mirror hubDispatchWorker's transform step.
      let outbound = envelope;
      const sub = this.registry
        .findForEnvelope(envelope)
        .find((s) => s.destinationConnectorId === destConnectorId);
      if (sub && sub.transformSteps?.length && this.pipeline) {
        outbound = await this.pipeline.execute(envelope, sub.transformSteps, new AbortController().signal);
      }
      await dest.dispatch(outbound, new AbortController().signal);
    };

    // DeadLetterRepository satisfies DlqPort structurally.
    this.replayService = new DlqReplayService(this.deadLetterRepo, redeliver);
  }

  /** Wire the transform pipeline (called by initHub) so replay can re-map raw envelopes. */
  setPipeline(pipeline: TransformPipeline): void {
    this.pipeline = pipeline;
  }

  registerDestination(connector: IDestinationConnector): void {
    this.destinations.set(connector.connectorId, connector);
  }

  /** Resolve a registered destination connector by id (used by the dispatch worker). */
  getDestination(connectorId: string): IDestinationConnector | undefined {
    return this.destinations.get(connectorId);
  }

  listDestinations(): string[] {
    return Array.from(this.destinations.keys());
  }
}

/** App-wide singleton. */
export const hubService = new HubService();
