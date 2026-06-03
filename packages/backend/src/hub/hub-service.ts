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
 * connector. Production registers real connectors (SharePoint→DB, etc.) here; a
 * built-in "echo" connector is registered so the replay loop is demonstrable
 * end-to-end before the full ingest path is wired.
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

    // Built-in echo destination: acknowledges any message so a replay can
    // succeed. Replace/extend by registering real connectors in production.
    this.registerDestination({
      connectorId: 'echo',
      orgId: DEFAULT_ORG,
      async dispatch() { /* success — message accepted */ },
    });
  }

  registerDestination(connector: IDestinationConnector): void {
    this.destinations.set(connector.connectorId, connector);
  }

  listDestinations(): string[] {
    return Array.from(this.destinations.keys());
  }
}

/** App-wide singleton. */
export const hubService = new HubService();
