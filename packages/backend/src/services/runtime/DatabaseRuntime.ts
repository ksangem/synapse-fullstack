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

  // Read rows from a source table (DB-as-source). Engine-specific SELECT via the
  // writer's underlying pool. Capped for safety.
  async fetch(creds: Creds, entityKey: string, ctx: RuntimeContext): Promise<FetchResult> {
    const engine = await this.engine(ctx);
    const c = this.conn(engine, creds);
    const table = entityKey || creds.table;
    if (!table) throw new Error('No source table — set the table name in the source credentials');
    const LIMIT = 5000;
    const writer = writerFor(engine);
    await writer.connect({ engine, host: c.host, port: c.port, database: c.database, username: c.username, password: c.password });
    try {
      const pool = (writer as unknown as { pool: unknown }).pool;
      let records: Record<string, unknown>[] = [];
      if (engine === 'postgres') {
        const r = await (pool as { query: (q: string) => Promise<{ rows: Record<string, unknown>[] }> }).query(`SELECT * FROM "${c.schema}"."${table}" LIMIT ${LIMIT}`);
        records = r.rows;
      } else if (engine === 'mysql') {
        const [rows] = await (pool as { query: (q: string) => Promise<[Record<string, unknown>[]]> }).query(`SELECT * FROM \`${c.database}\`.\`${table}\` LIMIT ${LIMIT}`);
        records = rows;
      } else {
        const result = await (pool as { request: () => { query: (q: string) => Promise<{ recordset: Record<string, unknown>[] }> } }).request().query(`SELECT TOP ${LIMIT} * FROM [${c.schema}].[${table}]`);
        records = result.recordset;
      }
      return { records, totalCount: records.length };
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
