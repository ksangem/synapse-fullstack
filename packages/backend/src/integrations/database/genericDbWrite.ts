/**
 * Generic "write arbitrary records to a database" — auto-creates the target
 * table from the mapping, then smart-upserts rows. Lets ANY source (e.g. an
 * authored REST connector) land data in Postgres/MySQL/SQL Server, reusing the
 * same writer infrastructure as the SharePoint→DB Hub path.
 */
import { PostgresWriter } from './writers/PostgresWriter';
import { MySqlWriter } from './writers/MySqlWriter';
import { SqlServerWriter } from './writers/SqlServerWriter';
import type { IDbWriter } from './writers/IDbWriter';
import { DbSchemaIntrospector } from './DbSchemaIntrospector';

export type DbEngine = 'postgres' | 'mysql' | 'sqlserver';
export interface DbConn { host: string; port: number; database: string; username: string; password: string; schema?: string }
export interface GenericMapping { from: string; to: string; type?: string }

const SQL_TYPE: Record<DbEngine, Record<string, string>> = {
  postgres: { string: 'text', number: 'numeric', datetime: 'timestamptz', boolean: 'boolean', json: 'jsonb', object: 'jsonb', array: 'jsonb' },
  mysql: { string: 'text', number: 'double', datetime: 'datetime', boolean: 'tinyint(1)', json: 'json', object: 'json', array: 'json' },
  sqlserver: { string: 'nvarchar(max)', number: 'float', datetime: 'datetime2', boolean: 'bit', json: 'nvarchar(max)', object: 'nvarchar(max)', array: 'nvarchar(max)' },
};

function sqlType(engine: DbEngine, t?: string): string {
  return SQL_TYPE[engine][(t || 'string').toLowerCase()] || SQL_TYPE[engine].string;
}

function quoteCol(engine: DbEngine, schema: string, table: string, col: string): string {
  if (engine === 'mysql') return `\`${col}\``;
  return engine === 'sqlserver' ? `[${col}]` : `"${col}"`;
}

function createTableDdl(engine: DbEngine, schema: string, table: string, cols: GenericMapping[]): string {
  const defs = cols.map((c) => `${quoteCol(engine, schema, table, c.to)} ${sqlType(engine, c.type)}`);
  if (engine === 'mysql') return `CREATE TABLE \`${schema}\`.\`${table}\` (\n  ${defs.join(',\n  ')}\n) ENGINE=InnoDB`;
  if (engine === 'sqlserver') return `CREATE TABLE [${schema}].[${table}] (\n  ${defs.join(',\n  ')}\n)`;
  return `CREATE TABLE "${schema}"."${table}" (\n  ${defs.join(',\n  ')}\n)`;
}

export async function writeRecordsToDb(opts: {
  engine: DbEngine;
  conn: DbConn;
  table: string;
  records: Record<string, unknown>[];
  mappings: GenericMapping[];
}): Promise<{ inserted: number; updated: number; failed: number; tableCreated: boolean; errors: string[] }> {
  const { engine, conn, table, records, mappings } = opts;
  const schema = engine === 'mysql' ? conn.database : (conn.schema || (engine === 'sqlserver' ? 'dbo' : 'public'));
  const writer: IDbWriter = engine === 'sqlserver' ? new SqlServerWriter() : engine === 'mysql' ? new MySqlWriter() : new PostgresWriter();
  const naturalKey = mappings[0]?.to;
  if (!naturalKey) throw new Error('At least one mapping is required');

  let inserted = 0; let updated = 0; let failed = 0; let tableCreated = false; const errors: string[] = [];
  await writer.connect({ engine, host: conn.host, port: conn.port, database: conn.database, username: conn.username, password: conn.password });
  try {
    const introspector = new DbSchemaIntrospector(writer);
    if (!(await introspector.tableExists(schema, table))) {
      await writer.applyDdl([createTableDdl(engine, schema, table, mappings)]);
      tableCreated = true;
    }
    for (const rec of records) {
      try {
        const row: Record<string, unknown> = {};
        for (const m of mappings) row[m.to] = (rec as Record<string, unknown>)[m.from];
        const result = await writer.smartUpsert(schema, table, naturalKey, row);
        if (result.action === 'inserted') inserted++;
        else if (result.action === 'updated') updated++;
      } catch (e) { failed++; if (errors.length < 5) errors.push((e as Error).message); }
    }
  } finally {
    await writer.disconnect();
  }
  return { inserted, updated, failed, tableCreated, errors };
}
