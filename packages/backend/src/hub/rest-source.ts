/**
 * RestSourceConnector — a real SOURCE that reads a JSON list from an HTTP
 * endpoint (WireMock locally) and yields one MessageEnvelope per record.
 *
 * It's the source-side mirror of DbDestinationConnector: the first thing that
 * actually *feeds* the bus from outside. Each record becomes a
 * `rest.<entity>.created` envelope; when an `idField` is configured, that field's
 * value is used as the stable idempotency key so re-reading the same list dedups
 * through the inbox/idempotency layer (re-runs are no-ops).
 *
 * Phase-2 scaffolding — the operator path (Day 8) drives this from a saved
 * integration instead of a hardcoded source.
 */

import { createEnvelope } from './envelope';
import { extractRecords } from '../services/GenericRestRuntime';
import type { ISourceConnector, MessageEnvelope, JsonValue } from './interfaces';

export interface RestSourceOptions {
  connectorId: string;
  orgId: string;
  /** Full URL to GET (e.g. http://localhost:8089/api/products). */
  url: string;
  /** Topic source segment → `<sourceKey>.<entity>.created`. Defaults to "rest". */
  sourceKey?: string;
  /** Topic entity segment → `<sourceKey>.<entity>.created`. */
  entity: string;
  /** Optional dotted path to the array inside the response. */
  recordsPath?: string;
  /** Record field used as the stable idempotency key (e.g. "id"). */
  idField?: string;
  headers?: Record<string, string>;
}

export class RestSourceConnector implements ISourceConnector {
  readonly connectorId: string;
  readonly orgId: string;
  private readonly opts: RestSourceOptions;

  constructor(opts: RestSourceOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
    this.opts = opts;
  }

  async *read(signal: AbortSignal): AsyncIterable<MessageEnvelope> {
    const res = await fetch(this.opts.url, { headers: this.opts.headers, signal });
    if (!res.ok) throw new Error(`REST source fetch failed (${res.status}) for ${this.opts.url}`);
    const json: unknown = await res.json();
    const records = extractRecords(json, this.opts.recordsPath);

    const topic = `${this.opts.sourceKey ?? 'rest'}.${this.opts.entity}.created`;
    let seq = 0;
    for (const rec of records) {
      if (signal.aborted) break;
      const idVal = this.opts.idField ? rec[this.opts.idField] : undefined;
      yield createEnvelope({
        topic,
        sourceConnectorId: this.connectorId,
        orgId: this.orgId,
        sequenceNo: ++seq,
        payload: rec as JsonValue,
        idempotencyKey: idVal != null ? String(idVal) : undefined,
      });
    }
  }
}
