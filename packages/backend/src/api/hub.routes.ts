/**
 * Hub API routes — powers the SharePoint→Database wizard flow + DDL preview.
 */

import { Router, type Request, type Response } from 'express';
import { DbSchemaDiffCalculator } from '../integrations/database/DbSchemaDiffCalculator';
import { recordAudit } from '../services/AuditService';
import { PostgresWriter } from '../integrations/database/writers/PostgresWriter';
import { SqlServerWriter } from '../integrations/database/writers/SqlServerWriter';
import { MySqlWriter } from '../integrations/database/writers/MySqlWriter';
import { DbSchemaIntrospector } from '../integrations/database/DbSchemaIntrospector';
import { SharePointGraphReader } from '../integrations/sharepoint-source/SharePointGraphReader';
import { SharePointFieldTypeMapper } from '../integrations/sharepoint-source/SharePointFieldTypeMapper';
import type { IDbWriter } from '../integrations/database/writers/IDbWriter';
import type { DbConnectionConfig, DbColumnMapping, DbEngine } from '../integrations/database/types';
import type { SharePointListConfig, SpFieldType, RawSpItem } from '../integrations/sharepoint-source/types';

const router = Router();

/** Get Azure SP credentials strictly from the request/connection — no .env fallback.
 *  Every SP credential must come from the saved connection (or be entered in the UI). */
function getSpCreds(body?: Record<string, string>) {
  return {
    tenantId: body?.tenantId || '',
    clientId: body?.clientId || '',
    clientSecret: body?.clientSecret || '',
  };
}

// ═══════════════════════════════════════════════════════
// SharePoint Source endpoints
// ═══════════════════════════════════════════════════════

/**
 * POST /api/hub/test-sp-source
 * Test SharePoint connection as a source (auth + resolve site).
 */
router.post('/test-sp-source', async (req: Request, res: Response) => {
  try {
    const { siteUrl } = req.body;
    const { tenantId, clientId, clientSecret } = getSpCreds(req.body);
    if (!siteUrl || !tenantId || !clientId || !clientSecret) {
      res.status(400).json({ success: false, error: 'Missing: siteUrl (and Azure creds in .env)' });
      return;
    }

    // Get token
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
    });
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text();
      res.json({ success: false, error: `Auth failed (${tokenRes.status}): ${t.substring(0, 200)}` });
      return;
    }
    const { access_token } = await tokenRes.json() as { access_token: string };

    // Resolve site
    const url = new URL(siteUrl);
    const hostname = url.hostname;
    const sitePath = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
    // Strip /Lists/xxx from the path if present
    const cleanPath = sitePath.replace(/\/Lists\/.*$/i, '');

    const siteRes = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${hostname}:/${cleanPath}`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    if (!siteRes.ok) {
      res.json({ success: false, error: `Site not found: ${siteUrl}` });
      return;
    }
    const site = await siteRes.json() as { id: string; displayName: string };

    res.json({
      success: true,
      data: { siteId: site.id, siteDisplayName: site.displayName, hostname },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/hub/discover-sp-lists
 * List all non-hidden lists on a SharePoint site.
 */
router.post('/discover-sp-lists', async (req: Request, res: Response) => {
  try {
    const { siteId } = req.body;
    const { tenantId, clientId, clientSecret } = getSpCreds(req.body);
    const token = await getSpToken(tenantId, clientId, clientSecret);

    const listsRes = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!listsRes.ok) {
      res.json({ success: false, error: `Failed to list: ${listsRes.status}` });
      return;
    }
    const data = await listsRes.json() as { value: Array<{ id: string; displayName: string; list: { template: string; hidden: boolean } }> };

    const lists = (data.value || [])
      .filter((l) => l.list && !l.list.hidden)
      .map((l) => ({ id: l.id, name: l.displayName, template: l.list.template }));

    res.json({ success: true, data: { lists } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/hub/sp-list-fields
 * Get columns from a SharePoint list (for mapping step).
 */
router.post('/sp-list-fields', async (req: Request, res: Response) => {
  try {
    const { siteId, listId } = req.body;
    const { tenantId, clientId, clientSecret } = getSpCreds(req.body);

    const reader = new SharePointGraphReader({
      siteId, listId, triggerMode: 'delta', pollIntervalSec: 60,
      tenantId, clientId, clientSecret,
    });

    const columns = await reader.discoverColumns();

    // Filter out system columns
    const SYSTEM = new Set(['ContentType', 'Attachments', '_ModernAudienceTargetUserField']);
    const filtered = columns.filter((c) => !SYSTEM.has(c.name) && !c.name.startsWith('_'));

    res.json({
      success: true,
      data: {
        fields: filtered.map((c) => ({
          name: c.name,
          displayName: c.displayName,
          type: c.fieldType,
          required: c.required,
        })),
      },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/hub/fetch-sp-items
 * Fetch all items from a SharePoint list (paginated).
 */
router.post('/fetch-sp-items', async (req: Request, res: Response) => {
  try {
    const { siteId, listId } = req.body;
    const { tenantId, clientId, clientSecret } = getSpCreds(req.body);

    const token = await getSpToken(tenantId, clientId, clientSecret);
    const allItems: RawSpItem[] = [];
    let nextUrl: string | undefined =
      `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?$expand=fields&$top=200`;

    while (nextUrl) {
      const r = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`Items fetch failed (${r.status}): ${t.substring(0, 300)}`);
      }
      const page = await r.json() as { value: Array<Record<string, unknown>>; '@odata.nextLink'?: string };
      for (const item of page.value) {
        allItems.push({
          id: item.id as string,
          createdDateTime: item.createdDateTime as string,
          lastModifiedDateTime: item.lastModifiedDateTime as string,
          fields: (item.fields || {}) as Record<string, unknown>,
        });
      }
      nextUrl = page['@odata.nextLink'];
    }

    // Discover columns for type mapping
    const reader2 = new SharePointGraphReader({
      siteId, listId, triggerMode: 'delta', pollIntervalSec: 60,
      tenantId, clientId, clientSecret,
    });
    const columns = await reader2.discoverColumns();
    const columnTypes = new Map<string, SpFieldType>();
    for (const col of columns) columnTypes.set(col.name, col.fieldType);

    // Map items through field type mapper
    const mapped = allItems.map((item) => {
      const m = SharePointFieldTypeMapper.mapItem(item, columnTypes);
      return {
        spItemId: m.spItemId,
        event: m.event,
        fields: m.fields,
        createdDateTime: item.createdDateTime,
        lastModifiedDateTime: item.lastModifiedDateTime,
      };
    });

    res.json({
      success: true,
      data: { items: mapped, totalCount: mapped.length },
    });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ═══════════════════════════════════════════════════════
// PostgreSQL Destination endpoints
// ═══════════════════════════════════════════════════════

/**
 * POST /api/hub/test-pg-dest
 * Test a PostgreSQL connection.
 */
router.post('/test-pg-dest', async (req: Request, res: Response) => {
  try {
    const { host, port, database, username, password } = req.body;
    const writer = new PostgresWriter();
    const ok = await writer.testConnection({
      engine: 'postgres', host, port: Number(port), database, username, password,
    });
    res.json({ success: true, data: { connectionOk: ok } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ═══════════════════════════════════════════════════════
// DB destination endpoints (Postgres / MySQL / SQL Server)
//
// These nine handlers used to repeat the same shape nine times: destructure the
// flat connection body, new XWriter(), connect, try/finally disconnect, catch →
// 500. Only the query in the middle actually differed per engine. The lifecycle
// now lives in `withWriter` (bottom of file) and the three schema-introspection
// handlers — which were character-for-character identical apart from the schema
// argument — collapse into `introspectTable`.
//
// Reached from the frontend GENERICALLY, via api.call(cfg.handlers.listTables |
// .columns | .quickView), where cfg.handlers comes from the connector registry
// (connectors/seed-data.ts). There are deliberately no named api.js wrappers.
// ═══════════════════════════════════════════════════════

/** POST /api/hub/pg-tables — list user tables in a Postgres schema. */
router.post('/pg-tables', (req: Request, res: Response) => withWriter('postgres', req, res, async (writer) => {
  const result = await pgPool(writer).query(`
    SELECT table_name,
           (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS column_count
    FROM information_schema.tables t
    WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `, [req.body.schema || 'public']);
  res.json({
    success: true,
    data: {
      tables: result.rows.map((r: Record<string, unknown>) => ({
        name: r.table_name as string,
        columnCount: Number(r.column_count),
      })),
    },
  });
}));

/** POST /api/hub/mysql-tables — list user tables in a MySQL database. */
router.post('/mysql-tables', (req: Request, res: Response) => withWriter('mysql', req, res, async (writer) => {
  const [rows] = await mysqlPool(writer).execute(`
    SELECT t.TABLE_NAME AS table_name,
           (SELECT COUNT(*) FROM information_schema.columns c
            WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME) AS column_count
    FROM information_schema.tables t
    WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY t.TABLE_NAME
  `, [req.body.database]);
  res.json({
    success: true,
    data: {
      tables: (rows as Record<string, unknown>[]).map((r) => ({
        name: r.table_name as string,
        columnCount: Number(r.column_count),
      })),
    },
  });
}));

/** POST /api/hub/mssql-tables — list user tables in a SQL Server schema (default dbo). */
router.post('/mssql-tables', (req: Request, res: Response) => withWriter('sqlserver', req, res, async (writer) => {
  const request = mssqlPool(writer).request();
  request.input('schema', req.body.schema || 'dbo');
  const result = await request.query(`
    SELECT t.TABLE_NAME AS table_name,
           (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS c
            WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME) AS column_count
    FROM INFORMATION_SCHEMA.TABLES t
    WHERE t.TABLE_SCHEMA = @schema AND t.TABLE_TYPE = 'BASE TABLE'
    ORDER BY t.TABLE_NAME
  `);
  res.json({
    success: true,
    data: {
      tables: result.recordset.map((r: Record<string, unknown>) => ({
        name: r.table_name as string,
        columnCount: Number(r.column_count),
      })),
    },
  });
}));

// ── Table introspection (for mapping destination fields) ──
// One implementation, three registrations. The only per-engine difference is which
// body field names the schema: MySQL has no schema concept here and passes the
// database, Postgres defaults to `public`, SQL Server to `dbo`.
router.post('/pg-table-columns', introspectTable('postgres', (b) => b.schema || 'public'));
router.post('/mysql-table-columns', introspectTable('mysql', (b) => b.database));
router.post('/mssql-table-columns', introspectTable('sqlserver', (b) => b.schema || 'dbo'));

// ═══════════════════════════════════════════════════════
// DDL Preview (existing)
// ═══════════════════════════════════════════════════════

router.post('/preview-ddl', async (req: Request, res: Response) => {
  try {
    const { connection, schema: targetSchema, table: targetTable, naturalKeyColumn, mappings } = req.body as {
      connection: DbConnectionConfig; schema: string; table: string; naturalKeyColumn: string; mappings: DbColumnMapping[];
    };
    if (!connection || !targetSchema || !targetTable || !naturalKeyColumn || !mappings) {
      res.status(400).json({ success: false, error: 'Missing required fields' });
      return;
    }
    const writer = createWriter(connection.engine);
    await writer.connect(connection);
    try {
      const introspectResult = await writer.introspect(targetSchema, targetTable);
      const diff = DbSchemaDiffCalculator.calculate(
        connection.engine, targetSchema, targetTable, mappings, naturalKeyColumn, introspectResult.columns,
      );
      res.json({ success: true, data: { tableExists: introspectResult.exists, existingColumns: introspectResult.columns.map((c) => c.columnName), ...diff } });
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

router.post('/apply-ddl', async (req: Request, res: Response) => {
  try {
    const { connection, ddlStatements } = req.body as { connection: DbConnectionConfig; ddlStatements: string[] };
    if (!connection || !ddlStatements || ddlStatements.length === 0) {
      res.status(400).json({ success: false, error: 'Missing required fields' });
      return;
    }
    const writer = createWriter(connection.engine);
    await writer.connect(connection);
    try {
      await writer.applyDdl(ddlStatements);
      /* The one write in the product that is deliberately NOT on the bus — it changes
         the SHAPE of a customer's table rather than moving data — and so the one with
         no message ledger behind it. The statements are recorded verbatim: they are
         column names and types, never data or credentials, and after an unexpected
         ALTER this row is the only account of what was run and by whom. */
      await recordAudit({
        orgId: req.actor.orgId,
        userId: req.actor.userId,
        action: 'apply_ddl',
        entityType: 'destination_table',
        diff: {
          engine: connection.engine,
          host: connection.host,
          database: connection.database,
          statements: ddlStatements,
        },
      });
      res.json({ success: true, data: { applied: ddlStatements.length } });
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Connection tests ──

/** POST /api/hub/test-mysql-dest — test a MySQL connection. */
router.post('/test-mysql-dest', async (req: Request, res: Response) => {
  try {
    const { host, port, database, username, password } = req.body;
    const writer = new MySqlWriter();
    const ok = await writer.testConnection({
      engine: 'mysql', host, port: Number(port) || 3306, database, username, password,
    });
    res.json({ success: true, data: { connectionOk: ok } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /api/hub/test-mssql-dest — test a SQL Server connection. */
router.post('/test-mssql-dest', async (req: Request, res: Response) => {
  try {
    const { host, port, database, username, password } = req.body;
    const writer = new SqlServerWriter();
    const ok = await writer.testConnection({
      engine: 'sqlserver', host, port: Number(port) || 1433, database, username, password,
    });
    res.json({ success: true, data: { connectionOk: ok } });
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Quick View: SELECT * ... LIMIT n + total count ──
// Kept per-engine: the row-limit syntax, the identifier quoting and the driver's
// result shape genuinely differ (and mysql2 rejects a bound LIMIT parameter).
// Each tries an ordered read by `synced_at` first — push tables have it, arbitrary
// tables do not — and falls back to an unordered read.

/** POST /api/hub/pg-quick-view */
router.post('/pg-quick-view', (req: Request, res: Response) => withWriter('postgres', req, res, async (writer) => {
  const { schema, table } = req.body;
  const rowLimit = quickViewLimit(req.body.limit);
  const targetSchema = schema || 'public';
  const pool = pgPool(writer);

  let result;
  try {
    result = await pool.query(`SELECT * FROM "${targetSchema}"."${table}" ORDER BY synced_at DESC NULLS LAST LIMIT $1`, [rowLimit]);
  } catch {
    result = await pool.query(`SELECT * FROM "${targetSchema}"."${table}" LIMIT $1`, [rowLimit]);
  }
  const countResult = await pool.query(`SELECT count(*)::int AS total FROM "${targetSchema}"."${table}"`);

  res.json({
    success: true,
    data: {
      columns: result.fields.map((f: { name: string }) => f.name),
      rows: result.rows,
      rowCount: result.rows.length,
      totalCount: countResult.rows[0]?.total || 0,
      table: `${targetSchema}.${table}`,
    },
  });
}, requireQuickViewFields));

/** POST /api/hub/mysql-quick-view */
router.post('/mysql-quick-view', (req: Request, res: Response) => withWriter('mysql', req, res, async (writer) => {
  const { database, table } = req.body;
  // NOTE: mysql2 prepared statements (.execute) reject a bound LIMIT param with
  // "Incorrect arguments to mysqld_stmt_execute". rowLimit is already coerced to a
  // safe integer, so inline it instead of binding.
  const rowLimit = quickViewLimit(req.body.limit);
  const pool = mysqlPool(writer);
  const qualified = `\`${database}\`.\`${table}\``;

  let rows: Record<string, unknown>[], fields: { name: string }[];
  try {
    [rows, fields] = await pool.query(`SELECT * FROM ${qualified} ORDER BY synced_at DESC LIMIT ${rowLimit}`);
  } catch {
    [rows, fields] = await pool.query(`SELECT * FROM ${qualified} LIMIT ${rowLimit}`);
  }
  const [countRows] = await pool.execute(`SELECT COUNT(*) AS total FROM ${qualified}`);

  res.json({
    success: true,
    data: {
      columns: fields.map((f) => f.name),
      rows,
      rowCount: rows.length,
      totalCount: (countRows as Record<string, unknown>[])[0]?.total || 0,
      table: `${database}.${table}`,
    },
  });
}, requireQuickViewFields));

/** POST /api/hub/mssql-quick-view */
router.post('/mssql-quick-view', (req: Request, res: Response) => withWriter('sqlserver', req, res, async (writer) => {
  const { schema, table } = req.body;
  const rowLimit = quickViewLimit(req.body.limit);
  const targetSchema = schema || 'dbo';
  const qualified = `[${targetSchema}].[${table}]`;
  const pool = mssqlPool(writer);

  let result;
  try {
    const r1 = pool.request(); r1.input('limit', rowLimit);
    result = await r1.query(`SELECT TOP (@limit) * FROM ${qualified} ORDER BY synced_at DESC`);
  } catch {
    const r2 = pool.request(); r2.input('limit', rowLimit);
    result = await r2.query(`SELECT TOP (@limit) * FROM ${qualified}`);
  }
  const countResult = await pool.request().query(`SELECT COUNT(*) AS total FROM ${qualified}`);

  const rows = result.recordset as Array<Record<string, unknown>>;
  const columns = Object.keys(result.recordset.columns || {});
  res.json({
    success: true,
    data: {
      columns: columns.length > 0 ? columns : (rows[0] ? Object.keys(rows[0]) : []),
      rows,
      rowCount: rows.length,
      totalCount: countResult.recordset[0]?.total || 0,
      table: `${targetSchema}.${table}`,
    },
  });
}, requireQuickViewFields));

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function createWriter(engine: DbEngine): IDbWriter {
  switch (engine) {
    case 'postgres': return new PostgresWriter();
    case 'sqlserver': return new SqlServerWriter();
    case 'mysql': return new MySqlWriter();
    default: throw new Error(`Unsupported engine: ${engine}`);
  }
}

// ── DB destination endpoint plumbing ────────────────────────────────────────
// The wizard-facing DB endpoints take a FLAT connection body ({host, port, ...})
// rather than the nested {connection:{...}} shape preview-ddl/apply-ddl use.

/**
 * Build a connection config from the flat body shape.
 *
 * Port defaulting is per-engine on purpose and reproduces exactly what the nine
 * handlers did before they were unified: MySQL and SQL Server fall back to their
 * standard ports, Postgres passes `Number(port)` straight through with no default.
 */
function connFromBody(engine: DbEngine, body: Record<string, unknown>): DbConnectionConfig {
  const { host, port, database, username, password } = body as Record<string, string>;
  const fallback = engine === 'mysql' ? 3306 : engine === 'sqlserver' ? 1433 : 0;
  return {
    engine,
    host,
    port: fallback ? (Number(port) || fallback) : Number(port),
    database,
    username,
    password,
  };
}

/**
 * connect → run → ALWAYS disconnect, with any throw reported as a 500.
 *
 * `guard` runs before connecting; return an error string to reject with a 400
 * (and no connection is opened). This replaced nine copies of the same
 * try/connect/try/finally-disconnect/catch scaffold.
 */
async function withWriter(
  engine: DbEngine,
  req: Request,
  res: Response,
  run: (writer: IDbWriter) => Promise<void>,
  guard?: (body: Record<string, unknown>) => string | null,
): Promise<void> {
  try {
    const bad = guard?.(req.body as Record<string, unknown>);
    if (bad) { res.status(400).json({ success: false, error: bad }); return; }

    const writer = createWriter(engine);
    await writer.connect(connFromBody(engine, req.body as Record<string, unknown>));
    try {
      await run(writer);
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Table-schema introspection — identical for all three engines apart from which
 * body field names the schema, so it is written once and registered three times.
 */
function introspectTable(engine: DbEngine, schemaOf: (body: Record<string, string>) => string) {
  return (req: Request, res: Response) => withWriter(engine, req, res, async (writer) => {
    const body = req.body as Record<string, string>;
    const result = await new DbSchemaIntrospector(writer).getTableSchema(schemaOf(body), body.table);
    res.json({
      success: true,
      data: {
        exists: result.exists,
        columns: result.columns.map((c) => ({
          name: c.columnName,
          displayName: c.columnName,
          type: c.dataType,
          required: !c.isNullable,
        })),
      },
    });
  });
}

/** Quick View row cap — caller's limit, defaulting to 50 and capped at 200. */
function quickViewLimit(limit: unknown): number {
  return Math.min(Number(limit) || 50, 200);
}

/** Quick View needs a target table on top of the connection fields. */
function requireQuickViewFields(body: Record<string, unknown>): string | null {
  return (!body.host || !body.database || !body.table)
    ? 'Missing required fields: host, database, table'
    : null;
}

// The writers expose their driver pool as a private field; these endpoints run raw
// engine-specific SQL (information_schema shapes and LIMIT syntax differ per engine),
// so they reach for it directly. Narrow accessors keep that cast in ONE place instead
// of sprinkling `(writer as any).pool!` through every handler.
type PgPool = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; fields: { name: string }[] }> };
type MysqlPool = {
  query: (sql: string) => Promise<[Record<string, unknown>[], { name: string }[]]>;
  execute: (sql: string, params?: unknown[]) => Promise<[Record<string, unknown>[], unknown]>;
};
type MssqlRequest = { input: (k: string, v: unknown) => void; query: (sql: string) => Promise<{ recordset: Record<string, unknown>[] & { columns?: Record<string, unknown> } }> };
type MssqlPool = { request: () => MssqlRequest };

const poolOf = (writer: IDbWriter) => (writer as unknown as { pool: unknown }).pool;
const pgPool = (writer: IDbWriter) => poolOf(writer) as PgPool;
const mysqlPool = (writer: IDbWriter) => poolOf(writer) as MysqlPool;
const mssqlPool = (writer: IDbWriter) => poolOf(writer) as MssqlPool;

async function getSpToken(tenantId: string, clientId: string, clientSecret: string): Promise<string> {
  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret,
    grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
  });
  const r = await fetch(tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  if (!r.ok) throw new Error(`SP token failed: ${r.status}`);
  const data = await r.json() as { access_token: string };
  return data.access_token;
}

export default router;
