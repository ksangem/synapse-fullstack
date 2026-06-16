/**
 * DbDestinationConnector — a REAL destination that lands envelopes in a relational
 * DB (Postgres/MySQL/SQL Server) by reusing the proven `writeRecordsToDb` writer
 * infrastructure (the same path the SharePoint→DB Hub flow uses).
 *
 * This is the first non-trivial `IDestinationConnector`: it wraps existing push
 * logic so the bus inherits it as a plug-in (the strangler pattern in miniature).
 * The same class is reused in later phases for operator-defined DB adapters.
 *
 * `dispatch` unpacks the envelope payload into one or more records, then upserts
 * them. A record set can arrive three ways: payload is a single object → one row;
 * payload is an array → many rows; payload is `{ records: [...] }` → those rows.
 */

import type { IDestinationConnector, MessageEnvelope, JsonValue } from './interfaces';
import {
  writeRecordsToDb,
  type DbConn,
  type DbEngine,
  type GenericMapping,
} from '../integrations/database/genericDbWrite';

export interface DbDestinationOptions {
  connectorId: string;
  orgId: string;
  engine: DbEngine;
  conn: DbConn;
  table: string;
  /**
   * Explicit field→column mappings. When omitted, an identity mapping is derived
   * from each record's own keys (every field → a same-named text column), which
   * is what the generic local-DB destination uses.
   */
  mappings?: GenericMapping[];
  /** Upsert/dedup column. Defaults to writeRecordsToDb's default (first mapping). */
  naturalKey?: string;
}

export class DbDestinationConnector implements IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;
  private readonly opts: DbDestinationOptions;

  constructor(opts: DbDestinationOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
    this.opts = opts;
  }

  async dispatch(envelope: MessageEnvelope, _signal: AbortSignal): Promise<void> {
    const records = extractRecords(envelope.payload);
    if (records.length === 0) return;

    const mappings = this.opts.mappings ?? identityMappings(records);
    if (mappings.length === 0) return;

    const result = await writeRecordsToDb({
      engine: this.opts.engine,
      conn: this.opts.conn,
      table: this.opts.table,
      records,
      mappings,
      naturalKey: this.opts.naturalKey,
    });

    // A row-level failure must reject so the bus retries / dead-letters it rather
    // than silently dropping data.
    if (result.failed > 0) {
      throw new Error(
        `DbDestination[${this.connectorId}]: ${result.failed} row(s) failed — ${result.errors.join('; ')}`,
      );
    }
  }
}

function isRecord(v: JsonValue): v is { [k: string]: JsonValue } {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function extractRecords(payload: JsonValue): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const add = (v: JsonValue) => { if (isRecord(v)) out.push(v); };

  if (Array.isArray(payload)) {
    payload.forEach(add);
    return out;
  }
  if (isRecord(payload)) {
    const nested = payload.records;
    if (Array.isArray(nested)) {
      nested.forEach(add);
      return out;
    }
    out.push(payload);
  }
  return out;
}

/** Build a same-name mapping for every field seen across the records. */
function identityMappings(records: Record<string, unknown>[]): GenericMapping[] {
  const keys = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) keys.add(k);
  return Array.from(keys).map((k) => ({ from: k, to: k }));
}
