/**
 * Hub API routes — powers the SharePoint→Database wizard flow + DDL preview.
 */

import { Router, type Request, type Response } from 'express';
import { DbSchemaDiffCalculator } from '../integrations/database/DbSchemaDiffCalculator';
import { PostgresWriter } from '../integrations/database/writers/PostgresWriter';
import { SqlServerWriter } from '../integrations/database/writers/SqlServerWriter';
import { MySqlWriter } from '../integrations/database/writers/MySqlWriter';
import { DbSchemaIntrospector } from '../integrations/database/DbSchemaIntrospector';
import { SharePointGraphReader } from '../integrations/sharepoint-source/SharePointGraphReader';
import { SharePointFieldTypeMapper } from '../integrations/sharepoint-source/SharePointFieldTypeMapper';
import type { IDbWriter } from '../integrations/database/writers/IDbWriter';
import type { DbConnectionConfig, DbColumnMapping, DbEngine } from '../integrations/database/types';
import type { SharePointListConfig, SpFieldType, RawSpItem } from '../integrations/sharepoint-source/types';
import { config } from '../config';

const router = Router();

/** Get Azure SP credentials — always from env, never from request body */
function getSpCreds(body?: Record<string, string>) {
  return {
    tenantId: config.AZURE_TENANT_ID || body?.tenantId || '',
    clientId: config.AZURE_CLIENT_ID || body?.clientId || '',
    clientSecret: config.AZURE_CLIENT_SECRET || body?.clientSecret || '',
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

/**
 * POST /api/hub/pg-tables
 * List all user tables in a Postgres schema.
 */
router.post('/pg-tables', async (req: Request, res: Response) => {
  try {
    const { host, port, database, username, password, schema } = req.body;
    const writer = new PostgresWriter();
    await writer.connect({ engine: 'postgres', host, port: Number(port), database, username, password });
    try {
      const result = await (writer as any).pool!.query(`
        SELECT table_name,
               (SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS column_count
        FROM information_schema.tables t
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `, [schema || 'public']);
      res.json({
        success: true,
        data: {
          tables: result.rows.map((r: Record<string, unknown>) => ({
            name: r.table_name as string,
            columnCount: Number(r.column_count),
          })),
        },
      });
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/hub/pg-table-columns
 * Introspect a Postgres table schema (for mapping destination fields).
 */
router.post('/pg-table-columns', async (req: Request, res: Response) => {
  try {
    const { host, port, database, username, password, schema, table } = req.body;
    const writer = new PostgresWriter();
    await writer.connect({ engine: 'postgres', host, port: Number(port), database, username, password });

    try {
      const introspector = new DbSchemaIntrospector(writer);
      const result = await introspector.getTableSchema(schema || 'public', table);

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
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/hub/push-to-pg
 * Execute the full SP→PG sync: auto-create table if needed, upsert all items.
 */
router.post('/push-to-pg', async (req: Request, res: Response) => {
  try {
    const {
      spConfig,        // { siteId, listId }
      pgConfig,        // { host, port, database, username, password }
      targetSchema,    // "public"
      targetTable,     // "sp_invoice"
      mappings,        // [{ from, to, type }]
    } = req.body;

    if (!spConfig || !pgConfig || !targetTable || !mappings) {
      res.status(400).json({ success: false, error: 'Missing required fields' });
      return;
    }

    // Inject Azure creds from env
    const spCreds = getSpCreds(spConfig);

    const schema = targetSchema || 'public';
    const naturalKey = 'sp_item_id';

    // 1. Connect to Postgres
    const writer = new PostgresWriter();
    await writer.connect({
      engine: 'postgres',
      host: pgConfig.host,
      port: Number(pgConfig.port),
      database: pgConfig.database,
      username: pgConfig.username,
      password: pgConfig.password,
    });

    try {
      const introspector = new DbSchemaIntrospector(writer);
      const exists = await introspector.tableExists(schema, targetTable);

      // 2. Auto-create table if it doesn't exist
      if (!exists) {
        const colDefs = [
          `"${naturalKey}" VARCHAR(128) PRIMARY KEY`,
          ...mappings.map((m: DbColumnMapping) => `"${m.to}" ${mapTypeToPg(m.type)}`),
          '"sp_created_at" TIMESTAMPTZ',
          '"sp_modified_at" TIMESTAMPTZ',
          '"is_deleted" BOOLEAN DEFAULT false',
          '"synced_at" TIMESTAMPTZ DEFAULT now()',
        ];
        const ddl = `CREATE TABLE "${schema}"."${targetTable}" (\n  ${colDefs.join(',\n  ')}\n)`;
        await writer.applyDdl([ddl]);
      }

      // 3. Fetch SP items
      const token = await getSpToken(spCreds.tenantId, spCreds.clientId, spCreds.clientSecret);
      const allItems: RawSpItem[] = [];
      let nextUrl: string | undefined =
        `https://graph.microsoft.com/v1.0/sites/${spConfig.siteId}/lists/${spConfig.listId}/items?$expand=fields&$top=200`;

      while (nextUrl) {
        const r = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (!r.ok) throw new Error(`SP fetch failed (${r.status})`);
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

      // 4. Discover column types
      const reader = new SharePointGraphReader({
        siteId: spConfig.siteId, listId: spConfig.listId,
        triggerMode: 'delta', pollIntervalSec: 60,
        tenantId: spCreds.tenantId, clientId: spCreds.clientId, clientSecret: spCreds.clientSecret,
      });
      const columns = await reader.discoverColumns();
      const columnTypes = new Map<string, SpFieldType>();
      for (const col of columns) columnTypes.set(col.name, col.fieldType);

      // 5. Smart Map + UPSERT (column-level diff)
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let errors = 0;
      const errorDetails: Array<{ id: string; error: string }> = [];
      const columnChangeCounts: Record<string, number> = {};
      let totalColumnsChanged = 0;

      for (const item of allItems) {
        try {
          const mapped = SharePointFieldTypeMapper.mapItem(item, columnTypes);
          const row: Record<string, unknown> = { [naturalKey]: mapped.spItemId };

          for (const m of mappings as DbColumnMapping[]) {
            const val = mapped.fields[m.from];
            row[m.to] = (val !== null && val !== undefined && typeof val === 'object')
              ? JSON.stringify(val) : val ?? null;
          }
          row['sp_created_at'] = item.createdDateTime || null;
          row['sp_modified_at'] = item.lastModifiedDateTime || null;

          // Use smartUpsert — only updates columns that actually changed
          const result = await writer.smartUpsert(schema, targetTable, naturalKey, row);
          if (result.action === 'inserted') {
            inserted++;
          } else if (result.action === 'updated') {
            updated++;
            for (const col of result.changedColumns || []) {
              columnChangeCounts[col] = (columnChangeCounts[col] || 0) + 1;
              totalColumnsChanged++;
            }
          } else {
            skipped++;
          }
        } catch (err: unknown) {
          errors++;
          errorDetails.push({ id: item.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Sort column changes by count descending
      const columnChanges = Object.entries(columnChangeCounts)
        .map(([column, count]) => ({ column, count }))
        .sort((a, b) => b.count - a.count);

      res.json({
        success: true,
        data: {
          total: allItems.length,
          inserted,
          updated,
          skipped,
          errors,
          totalColumnsChanged,
          columnChanges,
          errorDetails: errorDetails.slice(0, 10),
          tableCreated: !exists,
        },
      });
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

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
      res.json({ success: true, data: { applied: ddlStatements.length } });
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/hub/pg-quick-view
 * Run SELECT * FROM table LIMIT N and return rows + column names.
 * Used for the "Quick View" lookup after a push.
 */
router.post('/pg-quick-view', async (req: Request, res: Response) => {
  try {
    const { host, port, database, username, password, schema, table, limit } = req.body;
    if (!host || !database || !table) {
      res.status(400).json({ success: false, error: 'Missing required fields: host, database, table' });
      return;
    }
    const rowLimit = Math.min(Number(limit) || 50, 200); // cap at 200 rows
    const targetSchema = schema || 'public';

    const writer = new PostgresWriter();
    await writer.connect({ engine: 'postgres', host, port: Number(port), database, username, password });
    try {
      // Try ordering by synced_at (push tables), fallback to no order
      let result;
      try {
        result = await (writer as any).pool!.query(
          `SELECT * FROM "${targetSchema}"."${table}" ORDER BY synced_at DESC NULLS LAST LIMIT $1`,
          [rowLimit],
        );
      } catch {
        result = await (writer as any).pool!.query(
          `SELECT * FROM "${targetSchema}"."${table}" LIMIT $1`,
          [rowLimit],
        );
      }

      // Also get total row count
      const countResult = await (writer as any).pool!.query(
        `SELECT count(*)::int AS total FROM "${targetSchema}"."${table}"`,
      );

      const columns = result.fields.map((f: any) => f.name);
      res.json({
        success: true,
        data: {
          columns,
          rows: result.rows,
          rowCount: result.rows.length,
          totalCount: countResult.rows[0]?.total || 0,
          table: `${targetSchema}.${table}`,
        },
      });
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// ═══════════════════════════════════════════════════════
// MySQL Destination endpoints
// ═══════════════════════════════════════════════════════

/**
 * POST /api/hub/test-mysql-dest
 * Test a MySQL connection.
 */
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

/**
 * POST /api/hub/mysql-tables
 * List all user tables in a MySQL database.
 */
router.post('/mysql-tables', async (req: Request, res: Response) => {
  try {
    const { host, port, database, username, password } = req.body;
    const writer = new MySqlWriter();
    await writer.connect({ engine: 'mysql', host, port: Number(port) || 3306, database, username, password });
    try {
      const [rows] = await (writer as any).pool!.execute(`
        SELECT t.TABLE_NAME AS table_name,
               (SELECT COUNT(*) FROM information_schema.columns c
                WHERE c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME) AS column_count
        FROM information_schema.tables t
        WHERE t.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY t.TABLE_NAME
      `, [database]) as any;
      res.json({
        success: true,
        data: {
          tables: rows.map((r: any) => ({
            name: r.table_name,
            columnCount: Number(r.column_count),
          })),
        },
      });
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/hub/mysql-table-columns
 * Introspect a MySQL table schema.
 */
router.post('/mysql-table-columns', async (req: Request, res: Response) => {
  try {
    const { host, port, database, username, password, table } = req.body;
    const writer = new MySqlWriter();
    await writer.connect({ engine: 'mysql', host, port: Number(port) || 3306, database, username, password });
    try {
      const introspector = new DbSchemaIntrospector(writer);
      const result = await introspector.getTableSchema(database, table);
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
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/hub/push-to-mysql
 * Execute the full SP→MySQL sync: auto-create table if needed, upsert all items.
 */
router.post('/push-to-mysql', async (req: Request, res: Response) => {
  try {
    const { spConfig, mysqlConfig, targetTable, mappings } = req.body;

    if (!spConfig || !mysqlConfig || !targetTable || !mappings) {
      res.status(400).json({ success: false, error: 'Missing required fields' });
      return;
    }

    const spCreds = getSpCreds(spConfig);
    const dbName = mysqlConfig.database;
    const naturalKey = 'sp_item_id';

    const writer = new MySqlWriter();
    await writer.connect({
      engine: 'mysql',
      host: mysqlConfig.host,
      port: Number(mysqlConfig.port) || 3306,
      database: dbName,
      username: mysqlConfig.username,
      password: mysqlConfig.password,
    });

    try {
      const introspector = new DbSchemaIntrospector(writer);
      const exists = await introspector.tableExists(dbName, targetTable);

      if (!exists) {
        const colDefs = [
          `\`${naturalKey}\` VARCHAR(128) PRIMARY KEY`,
          ...mappings.map((m: DbColumnMapping) => `\`${m.to}\` ${mapTypeToMysql(m.type)}`),
          '`sp_created_at` DATETIME',
          '`sp_modified_at` DATETIME',
          '`is_deleted` TINYINT(1) DEFAULT 0',
          '`synced_at` DATETIME DEFAULT CURRENT_TIMESTAMP',
        ];
        const ddl = `CREATE TABLE \`${dbName}\`.\`${targetTable}\` (\n  ${colDefs.join(',\n  ')}\n) ENGINE=InnoDB`;
        await writer.applyDdl([ddl]);
      }

      // Fetch SP items
      const token = await getSpToken(spCreds.tenantId, spCreds.clientId, spCreds.clientSecret);
      const allItems: RawSpItem[] = [];
      let nextUrl: string | undefined =
        `https://graph.microsoft.com/v1.0/sites/${spConfig.siteId}/lists/${spConfig.listId}/items?$expand=fields&$top=200`;

      while (nextUrl) {
        const r = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (!r.ok) throw new Error(`SP fetch failed (${r.status})`);
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

      // Discover column types
      const reader = new SharePointGraphReader({
        siteId: spConfig.siteId, listId: spConfig.listId,
        triggerMode: 'delta', pollIntervalSec: 60,
        tenantId: spCreds.tenantId, clientId: spCreds.clientId, clientSecret: spCreds.clientSecret,
      });
      const columns = await reader.discoverColumns();
      const columnTypes = new Map<string, SpFieldType>();
      for (const col of columns) columnTypes.set(col.name, col.fieldType);

      // Smart Map + UPSERT
      let inserted = 0, updated = 0, skipped = 0, errors = 0;
      const errorDetails: Array<{ id: string; error: string }> = [];
      const columnChangeCounts: Record<string, number> = {};
      let totalColumnsChanged = 0;

      for (const item of allItems) {
        try {
          const mapped = SharePointFieldTypeMapper.mapItem(item, columnTypes);
          const row: Record<string, unknown> = { [naturalKey]: mapped.spItemId };

          for (const m of mappings as DbColumnMapping[]) {
            const val = mapped.fields[m.from];
            row[m.to] = (val !== null && val !== undefined && typeof val === 'object')
              ? JSON.stringify(val) : val ?? null;
          }
          row['sp_created_at'] = item.createdDateTime || null;
          row['sp_modified_at'] = item.lastModifiedDateTime || null;

          const result = await writer.smartUpsert(dbName, targetTable, naturalKey, row);
          if (result.action === 'inserted') inserted++;
          else if (result.action === 'updated') {
            updated++;
            for (const col of result.changedColumns || []) {
              columnChangeCounts[col] = (columnChangeCounts[col] || 0) + 1;
              totalColumnsChanged++;
            }
          } else skipped++;
        } catch (err: unknown) {
          errors++;
          errorDetails.push({ id: item.id, error: err instanceof Error ? err.message : String(err) });
        }
      }

      const columnChanges = Object.entries(columnChangeCounts)
        .map(([column, count]) => ({ column, count }))
        .sort((a, b) => b.count - a.count);

      res.json({
        success: true,
        data: {
          total: allItems.length, inserted, updated, skipped, errors,
          totalColumnsChanged, columnChanges,
          errorDetails: errorDetails.slice(0, 10),
          tableCreated: !exists,
        },
      });
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * POST /api/hub/mysql-quick-view
 * Run SELECT * FROM table LIMIT N for MySQL.
 */
router.post('/mysql-quick-view', async (req: Request, res: Response) => {
  try {
    const { host, port, database, username, password, table, limit } = req.body;
    if (!host || !database || !table) {
      res.status(400).json({ success: false, error: 'Missing required fields: host, database, table' });
      return;
    }
    const rowLimit = Math.min(Number(limit) || 50, 200);

    const writer = new MySqlWriter();
    await writer.connect({ engine: 'mysql', host, port: Number(port) || 3306, database, username, password });
    try {
      let rows: any[], fields: any[];
      try {
        [rows, fields] = await (writer as any).pool!.execute(
          `SELECT * FROM \`${database}\`.\`${table}\` ORDER BY synced_at DESC LIMIT ?`,
          [rowLimit],
        ) as any;
      } catch {
        [rows, fields] = await (writer as any).pool!.execute(
          `SELECT * FROM \`${database}\`.\`${table}\` LIMIT ?`,
          [rowLimit],
        ) as any;
      }

      const [countRows] = await (writer as any).pool!.execute(
        `SELECT COUNT(*) AS total FROM \`${database}\`.\`${table}\``,
      ) as any;

      const columnNames = fields.map((f: any) => f.name);
      res.json({
        success: true,
        data: {
          columns: columnNames,
          rows,
          rowCount: rows.length,
          totalCount: countRows[0]?.total || 0,
          table: `${database}.${table}`,
        },
      });
    } finally {
      await writer.disconnect();
    }
  } catch (err: unknown) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

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

function mapTypeToPg(type: string): string {
  switch (type) {
    case 'string': return 'TEXT';
    case 'number': return 'NUMERIC';
    case 'boolean': return 'BOOLEAN';
    case 'datetime': return 'TIMESTAMPTZ';
    case 'json': return 'JSONB';
    default: return 'TEXT';
  }
}

function mapTypeToMysql(type: string): string {
  switch (type) {
    case 'string': return 'TEXT';
    case 'number': return 'DECIMAL(18,4)';
    case 'boolean': return 'TINYINT(1)';
    case 'datetime': return 'DATETIME';
    case 'json': return 'JSON';
    default: return 'TEXT';
  }
}

export default router;
