/**
 * DbJoinProvider — the dest-side EntityIndexProvider.
 *
 * Satisfies the EntityJoinStep's `EntityIndexProvider` port by loading a joined
 * table from the DESTINATION database once per TTL, caching the rows, and building
 * an op-aware index keyed by each join's key column. This is where the FK-lookup
 * (name → id) resolves: a `side:"dest"` join pulling `id`.
 *
 * Boundary note: this lives OUTSIDE hub/ on purpose — it is composition, not the
 * channel. The bus never imports it; the wiring layer (integration-flow.ts) builds
 * one and injects it into the step. The only connector-touching code is the thin
 * `WriterTableLoader` adapter; the provider's caching/indexing logic is pure and
 * unit-testable with a fake TableLoader.
 */

import type { EntityIndex, EntityIndexProvider, JoinSpec, JoinOp } from '../../hub/entity-join-step';
import type { DbConn, DbEngine } from '../../integrations/database/genericDbWrite';
import { PostgresWriter } from '../../integrations/database/writers/PostgresWriter';
import { MySqlWriter } from '../../integrations/database/writers/MySqlWriter';
import { SqlServerWriter } from '../../integrations/database/writers/SqlServerWriter';

/** Read-only table loader — the single connector-touching seam (injectable for tests). */
export interface TableLoader {
  load(schema: string, table: string, columns: string[]): Promise<Record<string, unknown>[]>;
}

export interface DbJoinProviderOptions {
  ttlMs?: number;   // how long a loaded table stays cached (default 60s)
  rowWarn?: number; // warn above this many rows (default 50k)
  rowMax?: number;  // refuse above this many rows (default 250k)
}

const DEFAULTS = { ttlMs: 60_000, rowWarn: 50_000, rowMax: 250_000 };

/** Normalize a key value for matching, honoring the join op (trim always; lowercase for ci-eq). */
function normKey(v: unknown, op: JoinOp): string {
  const s = String(v).trim();
  return op === 'ci-eq' ? s.toLowerCase() : s;
}

/** Build an op-aware index over already-loaded rows, grouped by keyColumn (one-to-many → row[]). */
export function buildIndex(rows: Record<string, unknown>[], keyColumn: string, op: JoinOp): EntityIndex {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) {
    const kv = r[keyColumn];
    if (kv === null || kv === undefined || kv === '') continue;
    const k = normKey(kv, op);
    const bucket = map.get(k);
    if (bucket) bucket.push(r);
    else map.set(k, [r]);
  }
  return {
    lookup(key: string) {
      return map.get(normKey(key, op));
    },
  };
}

/** The union of columns any dest join needs from a given table (keyColumn + pulls + agg columns). */
export function columnsForTable(joins: JoinSpec[], ref: string): string[] {
  const cols = new Set<string>();
  for (const j of joins) {
    if (j.entity.side !== 'dest' || j.entity.ref !== ref) continue;
    cols.add(j.entity.keyColumn);
    for (const p of j.pull ?? []) cols.add(p.column);
    for (const a of j.aggregate ?? []) if (a.column) cols.add(a.column);
  }
  return Array.from(cols);
}

export class DbJoinProvider implements EntityIndexProvider {
  private readonly cache = new Map<string, { rows: Record<string, unknown>[]; at: number }>();
  private readonly ttlMs: number;
  private readonly rowWarn: number;
  private readonly rowMax: number;

  constructor(
    private readonly loader: TableLoader,
    private readonly joins: JoinSpec[],
    private readonly schema: string,
    opts: DbJoinProviderOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULTS.ttlMs;
    this.rowWarn = opts.rowWarn ?? DEFAULTS.rowWarn;
    this.rowMax = opts.rowMax ?? DEFAULTS.rowMax;
  }

  async getIndex(join: JoinSpec): Promise<EntityIndex> {
    if (join.entity.side !== 'dest') {
      throw new Error(`DbJoinProvider: join "${join.alias}" has side "${join.entity.side}" — this provider resolves dest-side joins only`);
    }
    const rows = await this.loadTable(join.entity.ref);
    return buildIndex(rows, join.entity.keyColumn, join.on.op ?? 'eq');
  }

  /** Load a table once per TTL, cache the rows, enforce the size guard. */
  private async loadTable(ref: string): Promise<Record<string, unknown>[]> {
    const now = Date.now();
    const hit = this.cache.get(ref);
    if (hit && now - hit.at < this.ttlMs) return hit.rows;

    const cols = columnsForTable(this.joins, ref);
    const rows = await this.loader.load(this.schema, ref, cols);

    if (rows.length > this.rowMax) {
      throw new Error(`DbJoinProvider: joined table "${ref}" has ${rows.length} rows (> ${this.rowMax}); refusing to index in memory. Joins are for reference/dimension tables, not large fact tables.`);
    }
    if (rows.length > this.rowWarn) {
      console.warn(`[DbJoinProvider] joined table "${ref}" has ${rows.length} rows (> ${this.rowWarn}) — indexing in memory; consider a smaller reference table.`);
    }
    this.cache.set(ref, { rows, at: now });
    return rows;
  }
}

/** Production adapter: opens the right engine writer, SELECTs, closes. The only connector-touching code. */
export class WriterTableLoader implements TableLoader {
  constructor(private readonly engine: DbEngine, private readonly conn: DbConn) {}

  async load(schema: string, table: string, columns: string[]): Promise<Record<string, unknown>[]> {
    const writer = this.engine === 'sqlserver' ? new SqlServerWriter()
      : this.engine === 'mysql' ? new MySqlWriter()
        : new PostgresWriter();
    await writer.connect({
      engine: this.engine,
      host: this.conn.host,
      port: this.conn.port,
      database: this.conn.database,
      username: this.conn.username,
      password: this.conn.password,
    });
    try {
      return await writer.loadRows(schema, table, columns);
    } finally {
      await writer.disconnect();
    }
  }
}

/** Resolve the schema the join tables live in, matching genericDbWrite's convention. */
export function joinSchemaOf(engine: DbEngine, conn: DbConn): string {
  return engine === 'mysql' ? conn.database : (conn.schema || (engine === 'sqlserver' ? 'dbo' : 'public'));
}

/** Convenience factory used by the wiring layer: dest-side provider bound to one DB connection. */
export function buildDbJoinProvider(joins: JoinSpec[], engine: DbEngine, conn: DbConn, opts?: DbJoinProviderOptions): DbJoinProvider {
  return new DbJoinProvider(new WriterTableLoader(engine, conn), joins, joinSchemaOf(engine, conn), opts);
}
