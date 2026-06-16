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
import type { IDestinationConnector, MessageEnvelope } from './interfaces';

export const DEFAULT_ORG = '00000000-0000-0000-0000-000000000001';

class HubService {
  readonly registry = new SubscriptionRegistry();
  readonly deadLetterRepo = new DeadLetterRepository(db);
  readonly replayService: DlqReplayService;

  private readonly destinations = new Map<string, IDestinationConnector>();

  constructor() {
    const redeliver = async (envelope: MessageEnvelope, destConnectorId: string): Promise<void> => {
      const dest = this.destinations.get(destConnectorId);
      if (!dest) {
        throw new Error(`No destination connector registered for "${destConnectorId}"`);
      }
      await dest.dispatch(envelope, new AbortController().signal);
    };

    // DeadLetterRepository satisfies DlqPort structurally.
    this.replayService = new DlqReplayService(this.deadLetterRepo, redeliver);
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
