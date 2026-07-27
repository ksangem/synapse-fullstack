/**
 * DatabaseRuntime — strangles the database destination flow behind the
 * IConnectorRuntime interface, wrapping the EXISTING writer infrastructure
 * (PostgresWriter/MySqlWriter/SqlServerWriter + writeRecordsToDb) rather than
 * reimplementing it. The Wizard's table picker/columns still use the dedicated
 * hub handlers; this makes the generic /runtime/* endpoints work for database
 * connectors too.
 *
 * Destination-oriented: test (SELECT 1), discoverFields (introspect a table),
 * push (auto-create + smart upsert). List-tables remains a handler concern.
 */
import { connectorService } from '../ConnectorService';
import { PostgresWriter } from '../../integrations/database/writers/PostgresWriter';
import { MySqlWriter } from '../../integrations/database/writers/MySqlWriter';
import { SqlServerWriter } from '../../integrations/database/writers/SqlServerWriter';
import { DbSchemaIntrospector } from '../../integrations/database/DbSchemaIntrospector';
import { writeRecordsToDb, type DbEngine, type GenericMapping } from '../../integrations/database/genericDbWrite';
import { CAPABILITIES } from './registry-caps';
import type { IConnectorRuntime, RuntimeCapabilities, RuntimeContext, Creds, TestResult, FetchResult, PushResult, EntitySummary, FieldDef } from './types';

function writerFor(engine: DbEngine) {
  return engine === 'sqlserver' ? new SqlServerWriter() : engine === 'mysql' ? new MySqlWriter() : new PostgresWriter();
}

/**
 * Per-engine identifier/literal quoting for the source read. Identifiers come from schema
 * introspection or the operator's table pick, but they are still interpolated into SQL, so
 * every one is quoted AND its terminator escaped by doubling — a table or column named
 * `foo"bar` can't break out. Literals are single-quoted with '' escaping.
 */
function quoter(engine: DbEngine, schema: string, database: string) {
  if (engine === 'mysql') {
    const id = (s: string) => `\`${String(s).replace(/`/g, '``')}\``;
    return { col: id, table: (t: string) => `${id(database)}.${id(t)}`, lit: sqlLiteral };
  }
  if (engine === 'sqlserver') {
    const id = (s: string) => `[${String(s).replace(/]/g, ']]')}]`;
    return { col: id, table: (t: string) => `${id(schema)}.${id(t)}`, lit: sqlLiteral };
  }
  const id = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  return { col: id, table: (t: string) => `${id(schema)}.${id(t)}`, lit: sqlLiteral };
}

/** Ceiling for a table we can't page (no PK, no cursorColumn) — the historical read cap. */
const NO_KEY_CAP = 5000;

function sqlLiteral(v: string): string {
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Run a SELECT through whichever pool the engine's writer holds. */
async function runSelect(writer: unknown, engine: DbEngine, sql: string): Promise<Record<string, unknown>[]> {
  const pool = (writer as { pool: unknown }).pool;
  if (engine === 'postgres') {
    const r = await (pool as { query: (q: string) => Promise<{ rows: Record<string, unknown>[] }> }).query(sql);
    return r.rows;
  }
  if (engine === 'mysql') {
    const [rows] = await (pool as { query: (q: string) => Promise<[Record<string, unknown>[]]> }).query(sql);
    return rows;
  }
  const result = await (pool as { request: () => { query: (q: string) => Promise<{ recordset: Record<string, unknown>[] }> } }).request().query(sql);
  return result.recordset;
}

function mapDbType(dataType: string): string {
  const t = (dataType || '').toLowerCase();
  if (/int|numeric|decimal|real|double|float|money/.test(t)) return 'number';
  if (/bool|bit/.test(t)) return 'boolean';
  if (/timestamp|date|time/.test(t)) return 'datetime';
  if (/json/.test(t)) return 'object';
  return 'string';
}

export class DatabaseRuntime implements IConnectorRuntime {
  readonly kind = 'database';
  readonly capabilities: RuntimeCapabilities = CAPABILITIES.database;

  private async engine(ctx: RuntimeContext): Promise<DbEngine> {
    const version = await connectorService.getVersion(ctx.connectorId, ctx.versionId);
    const rc = (version?.runtimeConfig as { engine?: DbEngine }) ?? {};
    return rc.engine ?? 'postgres';
  }

  private conn(engine: DbEngine, creds: Creds) {
    return {
      host: creds.host, port: Number(creds.port || (engine === 'mysql' ? 3306 : engine === 'sqlserver' ? 1433 : 5432)),
      database: creds.database, username: creds.username, password: creds.password,
      schema: creds.schema || (engine === 'sqlserver' ? 'dbo' : engine === 'mysql' ? creds.database : 'public'),
    };
  }

  async test(creds: Creds, ctx: RuntimeContext): Promise<TestResult> {
    const engine = await this.engine(ctx);
    const writer = writerFor(engine);
    try {
      const ok = await writer.testConnection({ engine, ...this.conn(engine, creds) });
      return { ok, message: ok ? 'Connection OK' : 'Connection failed' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    } finally {
      try { await writer.disconnect(); } catch { /* ignore */ }
    }
  }

  async discoverEntities(creds: Creds): Promise<EntitySummary[]> {
    return [{ key: creds.table || 'table', name: creds.table || 'Target Table', description: 'Rows in the target table' }];
  }

  async discoverFields(creds: Creds, ctx: RuntimeContext, entityKey: string): Promise<FieldDef[]> {
    const engine = await this.engine(ctx);
    const c = this.conn(engine, creds);
    const table = entityKey || creds.table;
    if (!table) return [];
    const writer = writerFor(engine);
    await writer.connect({ engine, host: c.host, port: c.port, database: c.database, username: c.username, password: c.password });
    try {
      const result = await new DbSchemaIntrospector(writer).getTableSchema(c.schema, table);
      return result.columns.map((col) => ({ name: col.columnName, displayName: col.columnName, type: mapDbType(col.dataType), required: !col.isNullable }));
    } finally {
      try { await writer.disconnect(); } catch { /* ignore */ }
    }
  }

  /**
   * Read rows from a source table (DB-as-source), one PAGE at a time.
   *
   * Ordering + paging key: `creds.cursorColumn` if the operator set one, else the table's
   * real primary key (introspected), else — when neither exists — a single unordered capped
   * page (and we say so via `truncated`, instead of silently returning the first N rows).
   *
   * `opts.cursor` is the last value we emitted for that column, so a re-run resumes with
   * `WHERE col > cursor` rather than re-reading the table. That makes the read incremental
   * for append-only/updated_at-style tables and keeps memory flat for large ones.
   */
  async fetch(creds: Creds, entityKey: string, ctx: RuntimeContext, opts?: Record<string, unknown>): Promise<FetchResult> {
    const engine = await this.engine(ctx);
    const c = this.conn(engine, creds);
    const table = entityKey || creds.table;
    if (!table) throw new Error('No source table — set the table name in the source credentials');

    const pageSize = Math.min(Number(opts?.limit) || Number(creds.pageSize) || 1000, 5000);
    const cursor = opts?.cursor == null ? undefined : String(opts.cursor);

    const writer = writerFor(engine);
    await writer.connect({ engine, host: c.host, port: c.port, database: c.database, username: c.username, password: c.password });
    try {
      // The column we order + resume by. Operator override first, then the real PK.
      let keyCol = creds.cursorColumn || creds.keyColumn || '';
      if (!keyCol) {
        try {
          const schema = await new DbSchemaIntrospector(writer).getTableSchema(c.schema, table);
          keyCol = schema.columns.find((col) => col.isPrimaryKey)?.columnName ?? '';
        } catch { keyCol = ''; } // introspection unavailable — fall through to the capped read
      }

      const q = quoter(engine, c.schema, c.database);
      const target = q.table(table);
      let sql: string;
      if (keyCol) {
        const col = q.col(keyCol);
        const where = cursor === undefined ? '' : ` WHERE ${col} > ${q.lit(cursor)}`;
        sql = engine === 'sqlserver'
          ? `SELECT TOP ${pageSize} * FROM ${target}${where} ORDER BY ${col} ASC`
          : `SELECT * FROM ${target}${where} ORDER BY ${col} ASC LIMIT ${pageSize}`;
      } else {
        // No key column to page by (no PK and no override). We can't resume safely — OFFSET
        // without a stable ORDER BY can repeat or skip rows — so take ONE read capped at the
        // long-standing 5000 ceiling (never smaller than before, so this is not a
        // regression) and report `truncated` if we filled it, instead of silently
        // pretending the table ended there.
        sql = engine === 'sqlserver'
          ? `SELECT TOP ${NO_KEY_CAP} * FROM ${target}`
          : `SELECT * FROM ${target} LIMIT ${NO_KEY_CAP}`;
      }

      const records = await runSelect(writer, engine, sql);

      // A full page means there is probably more. With a key column we hand back a resume
      // token; without one we can only report that the read was capped.
      const limitUsed = keyCol ? pageSize : NO_KEY_CAP;
      const full = records.length >= limitUsed;
      const lastVal = keyCol && records.length ? records[records.length - 1][keyCol] : undefined;
      return {
        records,
        totalCount: records.length,
        keyField: keyCol || undefined,
        nextCursor: full && lastVal != null ? String(lastVal) : undefined,
        truncated: full && !keyCol,
      };
    } finally {
      try { await writer.disconnect(); } catch { /* ignore */ }
    }
  }

  async push(creds: Creds, entityKey: string, records: Record<string, unknown>[], ctx: RuntimeContext, mappings?: unknown): Promise<PushResult> {
    const engine = await this.engine(ctx);
    const c = this.conn(engine, creds);
    const table = entityKey || creds.table;
    if (!table) throw new Error('No target table');
    let maps = mappings as GenericMapping[] | undefined;
    if (!maps?.length) {
      const first = records[0] ?? {};
      maps = Object.keys(first).map((k) => ({ from: k, to: k }));
    }
    const r = await writeRecordsToDb({ engine, conn: { host: c.host, port: c.port, database: c.database, username: c.username, password: c.password, schema: c.schema }, table, records, mappings: maps });
    return { created: r.inserted, updated: r.updated, failed: r.failed, errors: r.errors };
  }
}

export const databaseRuntime = new DatabaseRuntime();
