/**
 * EchoDestinationConnector — a trivial in-memory destination used to prove the
 * engineered wiring end-to-end locally, with NO external system or credentials.
 *
 * `dispatch` just appends the (post-transform) envelope to an in-memory sink that
 * `GET /api/hub/test-sink` reads back. Registered by initHub under connectorId
 * `test-dest`, paired with a `synthetic.echo.*` test subscription.
 *
 * Day 5 extends `dispatch` to throw when the payload carries `forceFail:true`, so
 * we can prove retry → dead-letter → replay. This whole file is Phase-1 scaffolding
 * and gets deleted at cut-over (Day 16).
 */

import type { IDestinationConnector, MessageEnvelope, JsonValue } from './interfaces';

export const ECHO_DEST_ID = 'test-dest';

export class EchoDestinationConnector implements IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;
  private readonly sink: MessageEnvelope[] = [];
  /** When true, ignore the `forceFail` switch (simulates "destination fixed",
   *  so a dead-lettered message replays successfully). Day-5 demo aid. */
  private suppressFailures = false;

  constructor(orgId: string, connectorId: string = ECHO_DEST_ID) {
    this.orgId = orgId;
    this.connectorId = connectorId;
  }

  async dispatch(envelope: MessageEnvelope, _signal: AbortSignal): Promise<void> {
    // Day 5: honour an explicit failure switch so we can exercise the DLQ path.
    const payload = envelope.payload as { forceFail?: JsonValue } | null;
    const wantsFail =
      payload && typeof payload === 'object' && !Array.isArray(payload) && payload.forceFail === true;
    if (wantsFail && !this.suppressFailures) {
      throw new Error(`EchoDestination: forced failure for message ${envelope.messageId}`);
    }
    this.sink.push(envelope);
  }

  /** Toggle whether `forceFail` payloads actually fail (Day-5 replay demo). */
  setSuppressFailures(on: boolean): void {
    this.suppressFailures = on;
  }

  /** Envelopes delivered so far (oldest first). */
  list(): MessageEnvelope[] {
    return [...this.sink];
  }

  get size(): number {
    return this.sink.length;
  }

  clear(): void {
    this.sink.length = 0;
  }
}
