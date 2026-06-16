/**
 * AuthoredConnectorSource — runs ANY Studio-authored connector through the bus.
 *
 * Resolves the connector's runtime from the registry (keyed by runtimeKind),
 * calls its `fetch(creds, entity)`, and publishes each record as a
 * `<sourceKey>.<entity>.created` envelope. So every authored connector (all 12
 * categories) inherits the bus's durability / idempotency / observability for
 * free — one path instead of the direct per-call push.
 */

import { connectorService } from '../services/ConnectorService';
import { getRuntime } from '../services/runtime/registry';
import { createEnvelope } from './envelope';
import type { ISourceConnector, MessageEnvelope, JsonValue } from './interfaces';

export interface AuthoredSourceOptions {
  connectorId: string;
  versionId?: string;
  orgId: string;
  entity: string;
  creds?: Record<string, string>;
  /** Topic source segment; defaults to the connector's key. */
  sourceKey?: string;
}

function seg(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

export class AuthoredConnectorSource implements ISourceConnector {
  readonly connectorId: string;
  readonly orgId: string;

  constructor(private readonly opts: AuthoredSourceOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
    const head = await connectorService.getConnector(this.opts.connectorId);
    if (!head) throw new Error(`Connector ${this.opts.connectorId} not found`);

    const runtime = getRuntime(head.runtimeKind);
    if (!runtime?.fetch) throw new Error(`Runtime "${head.runtimeKind}" cannot fetch`);

    const result = await runtime.fetch(this.opts.creds ?? {}, this.opts.entity, {
      connectorId: this.opts.connectorId,
      versionId: this.opts.versionId,
      orgId: this.orgId,
    });
    const records = result.records ?? [];

    const sourceKey = this.opts.sourceKey ?? head.key ?? 'authored';
    const topic = `${seg(sourceKey)}.${seg(this.opts.entity)}.created`;

    let n = 0;
    for (const rec of records) {
      if (signal.aborted) break;
      const idVal = (rec.id ?? rec.Id ?? rec.key) as unknown;
      yield createEnvelope({
        topic,
        sourceConnectorId: this.connectorId,
        orgId: this.orgId,
        sequenceNo: n++,
        payload: rec as JsonValue,
        idempotencyKey: idVal != null ? String(idVal) : undefined,
      });
    }
  }
}
