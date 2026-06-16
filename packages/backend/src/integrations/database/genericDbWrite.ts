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

// Auto-increment surrogate primary-key column definition, per engine.
function autoPkColDdl(engine: DbEngine, name: string): string {
  if (engine === 'mysql') return `\`${name}\` BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY`;
  if (engine === 'sqlserver') return `[${name}] BIGINT IDENTITY(1,1) PRIMARY KEY`;
  return `"${name}" BIGSERIAL PRIMARY KEY`;
}

function createTableDdl(engine: DbEngine, schema: string, table: string, cols: GenericMapping[], autoPkName?: string): string {
  const defs = cols.map((c) => `${quoteCol(engine, schema, table, c.to)} ${sqlType(engine, c.type)}`);
  // Surrogate PK goes first (only on table creation — never altered into existing tables).
  if (autoPkName) defs.unshift(autoPkColDdl(engine, autoPkName));
  if (engine === 'mysql') return `CREATE TABLE \`${schema}\`.\`${table}\` (\n  ${defs.join(',\n  ')}\n) ENGINE=InnoDB`;
  if (engine === 'sqlserver') return `CREATE TABLE [${schema}].[${table}] (\n  ${defs.join(',\n  ')}\n)`;
  return `CREATE TABLE "${schema}"."${table}" (\n  ${defs.join(',\n  ')}\n)`;
}

// ALTER TABLE ADD for a single mapped column (schema evolution on existing tables).
function alterAddColumnDdl(engine: DbEngine, schema: string, table: string, col: GenericMapping): string {
  const c = quoteCol(engine, schema, table, col.to);
  const t = sqlType(engine, col.type);
  if (engine === 'mysql') return `ALTER TABLE \`${schema}\`.\`${table}\` ADD COLUMN ${c} ${t}`;
  if (engine === 'sqlserver') return `ALTER TABLE [${schema}].[${table}] ADD ${c} ${t}`;
  return `ALTER TABLE "${schema}"."${table}" ADD COLUMN IF NOT EXISTS ${c} ${t}`;
}

/**
 * Normalize an ISO / Jira datetime string to "YYYY-MM-DD HH:MM:SS" for engines whose
 * datetime types reject the "T", fractional seconds, and timezone offset (MySQL datetime,
 * SQL Server datetime2). The wall-clock time is preserved; the offset is dropped.
 * Date-only or unrecognized values pass through unchanged.
 */
export function toSqlDateTime(v: string): string {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : v;
}

/**
 * True only when the ENTIRE string is an ISO-8601 datetime (optionally with
 * fractional seconds and a `Z`/±hh[:]mm offset) — e.g. "2025-10-17T12:09:57.091+0530"
 * or "2025-10-17T12:09:57Z". Used to catch Jira/REST timestamps and normalize them
 * for MySQL/SQL Server even when the mapping wasn't explicitly typed `datetime`.
 * Anchored at both ends so it never truncates ordinary text that merely begins with
 * a date.
 */
export function looksLikeIsoDateTime(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?$/.test(v);
}

/** Pick a surrogate-PK column name that doesn't collide with a mapped column. */
function resolveAutoPkName(mappings: GenericMapping[]): string {
  const taken = new Set(mappings.map((m) => (m.to || '').toLowerCase()));
  let name = 'id';
  let n = 1;
  while (taken.has(name.toLowerCase())) { name = `pk_id${n > 1 ? n : ''}`; n++; }
  return name;
}

export async function writeRecordsToDb(opts: {
  engine: DbEngine;
  conn: DbConn;
  table: string;
  records: Record<string, unknown>[];
  mappings: GenericMapping[];
  /** Column to dedup/upsert by. '' (or unset → first mapping) ; pass '' explicitly to APPEND every row. */
  naturalKey?: string;
}): Promise<{ inserted: number; updated: number; failed: number; tableCreated: boolean; errors: string[]; autoPrimaryKey?: string }> {
  const { engine, conn, table, records, mappings } = opts;
  if (!mappings.length) throw new Error('At least one mapping is required');
  const schema = engine === 'mysql' ? conn.database : (conn.schema || (engine === 'sqlserver' ? 'dbo' : 'public'));
  const writer: IDbWriter = engine === 'sqlserver' ? new SqlServerWriter() : engine === 'mysql' ? new MySqlWriter() : new PostgresWriter();
  // Explicit key wins; default to the first mapping. '' = match nothing = append every row.
  const naturalKey = opts.naturalKey !== undefined ? opts.naturalKey : (mappings[0]?.to ?? '');

  let inserted = 0; let updated = 0; let failed = 0; let tableCreated = false; let pkAdded: string | undefined; const errors: string[] = [];
  await writer.connect({ engine, host: conn.host, port: conn.port, database: conn.database, username: conn.username, password: conn.password });
  try {
    const introspector = new DbSchemaIntrospector(writer);
    if (!(await introspector.tableExists(schema, table))) {
      // New tables always get an auto-increment surrogate PK (existing tables untouched),
      // so rows are uniquely identifiable even when the business key is empty.
      const pkName = resolveAutoPkName(mappings);
      await writer.applyDdl([createTableDdl(engine, schema, table, mappings, pkName)]);
      tableCreated = true;
      pkAdded = pkName;
    } else {
      // Schema evolution: add any mapped columns the existing table is missing, so
      // re-pushing after changing the mapping doesn't fail on "Invalid column name".
      const existing = new Set((await introspector.getColumnNames(schema, table)).map((c) => c.toLowerCase()));
      const missing = mappings.filter((m) => m.to && !existing.has(m.to.toLowerCase()));
      if (missing.length) await writer.applyDdl(missing.map((m) => alterAddColumnDdl(engine, schema, table, m)));
    }
    for (const rec of records) {
      try {
        const row: Record<string, unknown> = {};
        for (const m of mappings) {
          let v = (rec as Record<string, unknown>)[m.from];
          const t = (m.type || '').toLowerCase();
          const isJson = t === 'json' || t === 'object' || t === 'array';
          // Nested objects/arrays (common in REST/Jira payloads) can't bind to a
          // text/varchar column — serialize them to JSON so they land as strings.
          if (v !== null && typeof v === 'object') v = JSON.stringify(v);
          // An empty string can't cast to number/datetime/boolean/json — store NULL.
          else if (v === '' && t && t !== 'string') v = null;
          // A scalar string bound to a json/jsonb column must itself be valid JSON
          // (e.g. a mapping that extracts status.name -> "In Progress"). Wrap it if it
          // isn't already valid JSON, so the json cast succeeds instead of erroring.
          else if (isJson && typeof v === 'string') {
            try { JSON.parse(v); } catch { v = JSON.stringify(v); }
          }
          // Jira/ISO datetimes ("2025-10-17T12:09:57.091+0530") are accepted by Postgres
          // timestamptz but rejected by MySQL datetime / SQL Server datetime2. Normalize
          // to "YYYY-MM-DD HH:MM:SS" (wall-clock, offset dropped) for those engines — for
          // fields declared `datetime` AND for any value that is itself a full ISO-8601
          // datetime, so Jira timestamps land correctly even when the mapping wasn't typed.
          else if (engine !== 'postgres' && typeof v === 'string' && v
                   && (t === 'datetime' || looksLikeIsoDateTime(v))) {
            v = toSqlDateTime(v);
          }
          row[m.to] = v;
        }
        const result = await writer.smartUpsert(schema, table, naturalKey, row);
        if (result.action === 'inserted') inserted++;
        else if (result.action === 'updated') updated++;
      } catch (e) { failed++; if (errors.length < 5) errors.push((e as Error).message); }
    }
  } finally {
    await writer.disconnect();
  }
  return { inserted, updated, failed, tableCreated, errors, autoPrimaryKey: pkAdded };
}
