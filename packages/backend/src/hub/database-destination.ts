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
 *
 * It also resolves FOREIGN KEYS (`preset: 'lookup'` mappings). That happens here
 * rather than in the mapping step because the mapping step has no DB connection
 * and this class does — see resolveForeignKeys below.
 */

import type { IDestinationConnector, MessageEnvelope, JsonValue } from './interfaces';
import { H, eventOf } from './envelope-meta';
import { writeRecordsToDb, type DbConn, type DbEngine, type GenericMapping } from '../integrations/database/genericDbWrite';
import { WriterTableLoader, joinSchemaOf } from '../services/join/DbJoinProvider';
import type { FkLookup } from '../services/MappingEngine';

/* The destination dispatches ONE row per envelope, so an uncached lookup would
   re-scan the parent table for every child row. Parent/reference tables change
   slowly; a short TTL keeps a long run consistent without pinning stale ids.
   Mirrors the resolve cache in sp-destination.ts and DbJoinProvider. */
const FK_CACHE_TTL_MS = Number(process.env.FK_LOOKUP_TTL_MS) || 60_000;
/* A lookup indexes the parent in memory. Same reasoning as the join provider:
   this is for reference/dimension tables, not fact tables. */
const FK_ROW_MAX = Number(process.env.FK_LOOKUP_ROW_MAX) || 100_000;

export interface DatabaseDestinationOptions {
  connectorId: string;
  orgId: string;
  engine: DbEngine;
  conn: DbConn;
  /** Default table when the envelope doesn't carry one. */
  defaultTable?: string;
  /** Default natural-key column when the envelope doesn't carry one. */
  defaultNaturalKey?: string;
  /** Foreign keys to resolve before writing (derived from `preset: 'lookup'` mappings). */
  foreignKeys?: FkLookup[];
}

interface ParentMap { map: Map<string, unknown>; at: number }

export class DatabaseDestinationConnector implements IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;

  /** parentTable → { name → id }, TTL'd. */
  private readonly fkCache = new Map<string, ParentMap>();

  constructor(private readonly opts: DatabaseDestinationOptions) {
    this.connectorId = opts.connectorId;
    this.orgId = opts.orgId;
  }

  /** Trimmed, exact match. Parent names must be unique; the first row wins. */
  private static key(v: unknown): string {
    return String(v ?? '').trim();
  }

  private async parentMap(fk: FkLookup): Promise<Map<string, unknown>> {
    const now = Date.now();
    const hit = this.fkCache.get(fk.parentTable);
    if (hit && now - hit.at < FK_CACHE_TTL_MS) return hit.map;

    const schema = joinSchemaOf(this.opts.engine, this.opts.conn);
    const loader = new WriterTableLoader(this.opts.engine, this.opts.conn);
    const rows = await loader.load(schema, fk.parentTable, [fk.matchColumn, fk.returnColumn]);
    if (rows.length > FK_ROW_MAX) {
      throw new Error(`DatabaseDestination[${this.connectorId}]: parent table "${fk.parentTable}" has ${rows.length} rows (> ${FK_ROW_MAX}); refusing to index it in memory for FK lookup.`);
    }

    const map = new Map<string, unknown>();
    for (const r of rows) {
      const k = DatabaseDestinationConnector.key(r[fk.matchColumn]);
      if (k !== '' && !map.has(k)) map.set(k, r[fk.returnColumn]);
    }
    this.fkCache.set(fk.parentTable, { map, at: now });
    return map;
  }

  /**
   * Swap each FK column's parent NAME for the parent's id, in place.
   *
   * An unresolvable parent THROWS (onMissing: 'error'). That is deliberate: the
   * alternative was writing an invalid id and failing the FK constraint anyway,
   * with an opaque database error instead of the name that could not be found.
   */
  private async resolveForeignKeys(row: Record<string, JsonValue>): Promise<void> {
    for (const fk of this.opts.foreignKeys ?? []) {
      const raw = row[fk.column];
      // Nothing to resolve — leave a null FK to the column's own nullability rules.
      if (raw === null || raw === undefined || raw === '') continue;
      const map = await this.parentMap(fk);
      const hit = map.get(DatabaseDestinationConnector.key(raw));
      if (hit === undefined) {
        throw new Error(`FK lookup failed: no ${fk.parentTable} row where ${fk.matchColumn} = '${String(raw)}' (for column ${fk.column})`);
      }
      row[fk.column] = hit as JsonValue;
    }
  }

  async dispatch(envelope: MessageEnvelope, _signal: AbortSignal): Promise<void> {
    const headers = envelope.headers ?? {};
    const table = headers[H.DEST_TABLE] || this.opts.defaultTable;
    if (!table) throw new Error(`DatabaseDestination[${this.connectorId}]: no target table (header or default)`);

    const naturalKey = headers[H.NATURAL_KEY_COLUMN] || this.opts.defaultNaturalKey;
    const deleted = eventOf(headers) === 'deleted';

    const record = { ...(envelope.payload as Record<string, JsonValue>), is_deleted: deleted };
    await this.resolveForeignKeys(record);
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
