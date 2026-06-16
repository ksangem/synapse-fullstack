/**
 * DatabaseDestinationConnector — a generic relational-DB destination.
 *
 * It is connector-agnostic about the SOURCE: it just writes the (already-mapped)
 * row in the envelope payload to a table, upserting by the natural-key column and
 * soft-deleting on a `deleted` event. The table + natural key arrive on the
 * envelope headers (stamped by the mapping transform) or fall back to the
 * adapter's configured defaults — so one DB-connection instance serves many
 * adapters/tables without baking either in.
 *
 * Reuses writeRecordsToDb (auto-create/alter + smart upsert) so a target table
 * provisions itself on first write.
 */

import type { IDestinationConnector, MessageEnvelope, JsonValue } from './interfaces';
import { H, eventOf } from './envelope-meta';
import { writeRecordsToDb, type DbConn, type DbEngine, type GenericMapping } from '../integrations/database/genericDbWrite';

export interface DatabaseDestinationOptions {
  connectorId: string;
  orgId: string;
  engine: DbEngine;
  conn: DbConn;
  /** Default table when the envelope doesn't carry one. */
  defaultTable?: string;
  /** Default natural-key column when the envelope doesn't carry one. */
  defaultNaturalKey?: string;
}

export class DatabaseDestinationConnector implements IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;

  constructor(private readonly opts: DatabaseDestinationOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  async dispatch(envelope: MessageEnvelope, _signal: AbortSignal): Promise<void> {
    const headers = envelope.headers ?? {};
    const table = headers[H.DEST_TABLE] || this.opts.defaultTable;
    if (!table) throw new Error(`DatabaseDestination[${this.connectorId}]: no target table (header or default)`);

    const naturalKey = headers[H.NATURAL_KEY_COLUMN] || this.opts.defaultNaturalKey;
    const deleted = eventOf(headers) === 'deleted';

    const record = { ...(envelope.payload as Record<string, JsonValue>), is_deleted: deleted };
    const mappings: GenericMapping[] = Object.keys(record).map((k) => ({ from: k, to: k }));

    const result = await writeRecordsToDb({
      engine: this.opts.engine,
      conn: this.opts.conn,
      table,
      records: [record],
      mappings,
      naturalKey,
    });

    if (result.failed > 0) {
      throw new Error(`DatabaseDestination[${this.connectorId}]: ${result.failed} row(s) failed — ${result.errors.join('; ')}`);
    }
  }
}
