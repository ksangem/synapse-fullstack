/**
 * RestDestinationConnector — writes the envelope payload to a REST/SaaS API by
 * delegating to the authored connector's runtime (genericRestRuntime.push). The
 * payload is the already-mapped record; this connector knows nothing about the
 * source. Lets any REST-kind connector be a bus destination (write-back).
 */

import type { IDestinationConnector, MessageEnvelope } from './interfaces';
import { genericRestRuntime } from '../services/GenericRestRuntime';

export interface RestDestinationOptions {
  connectorId: string;
  orgId: string;
  versionId?: string;
  creds: Record<string, string>;
  entity: string;
}

export class RestDestinationConnector implements IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;

  constructor(private readonly opts: RestDestinationOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  async dispatch(envelope: MessageEnvelope, _signal: AbortSignal): Promise<void> {
    const record = envelope.payload as Record<string, unknown>;
    const result = await genericRestRuntime.push(
      this.opts.connectorId,
      this.opts.versionId,
      this.opts.creds,
      this.opts.entity,
      [record],
    );
    if (result.failed > 0) {
      throw new Error(`RestDestination[${this.connectorId}]: ${result.failed} failed — ${result.errors.join('; ')}`);
    }
  }
}
