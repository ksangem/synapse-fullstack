import * as sql from 'mssql';
import type { IDbWriter } from './IDbWriter';
import type {
  DbConnectionConfig,
  UpsertRow,
  UpsertResult,
  IntrospectResult,
  DbColumnSpec,
} from '../types';

export class SqlServerWriter implements IDbWriter {
  readonly engine = 'sqlserver';
  private pool: sql.ConnectionPool | null = null;

  async connect(config: DbConnectionConfig): Promise<void> {
    const sqlConfig: sql.config = {
      server: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      options: {
        encrypt: config.ssl ?? false,
        trustServerCertificate: true,
      },
      pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

    // Use a dedicated ConnectionPool (NOT the global sql.connect()) so that
    // multiple writers / a concurrent testConnection() don't share or close
    // each other's connection.
    this.pool = new sql.ConnectionPool(sqlConfig);
    await this.pool.connect();
  }

  async upsert(
    schema: string,
    table: string,
    naturalKeyColumn: string,
    row: UpsertRow,
  ): Promise<UpsertResult> {
    this.ensureConnected();

    const columns = Object.keys(row);
    if (columns.length === 0) {
      throw new Error('Cannot upsert an empty row');
    }

    const naturalKeyValue = String(row[naturalKeyColumn] ?? '');
    if (!naturalKeyValue) {
      throw new Error(`Natural key column "${naturalKeyColumn}" is missing or empty in row`);
    }

    const qualifiedTable = `[${schema}].[${table}]`;

    // Build MERGE statement
    const sourceColumns = columns.map((c) => `@${c} AS [${c}]`).join(', ');
    const onClause = `target.[${naturalKeyColumn}] = source.[${naturalKeyColumn}]`;

    const updateColumns = columns.filter((c) => c !== naturalKeyColumn);
    const updateSet = updateColumns.map((c) => `target.[${c}] = source.[${c}]`).join(', ');

    const insertCols = columns.map((c) => `[${c}]`).join(', ');
    const insertVals = columns.map((c) => `source.[${c}]`).join(', ');

    let mergeSql: string;
    if (updateColumns.length > 0) {
      mergeSql = `
        MERGE ${qualifiedTable} AS target
        USING (SELECT ${sourceColumns}) AS source
        ON ${onClause}
        WHEN MATCHED THEN
          UPDATE SET ${updateSet}
        WHEN NOT MATCHED THEN
          INSERT (${insertCols})
          VALUES (${insertVals})
        OUTPUT $action AS merge_action;
      `;
    } else {
      // Only natural key — insert if not exists
      mergeSql = `
        MERGE ${qualifiedTable} AS target
        USING (SELECT ${sourceColumns}) AS source
        ON ${onClause}
        WHEN NOT MATCHED THEN
          INSERT (${insertCols})
          VALUES (${insertVals})
        OUTPUT $action AS merge_action;
      `;
    }

    const request = this.pool!.request();
    for (const col of columns) {
      request.input(col, row[col]);
    }

    const result = await request.query(mergeSql);
    const action = result.recordset?.[0]?.merge_action;

    if (!action) {
      return { action: 'skipped', naturalKey: naturalKeyValue };
    }

    return {
      action: action === 'INSERT' ? 'inserted' : 'updated',
      naturalKey: naturalKeyValue,
    };
  }

  /**
   * Smart UPSERT: SELECT the existing row, diff column-by-column, and only
   * UPDATE the columns that changed (SQL Server has no RETURNING/xmax, so we
   * read-then-write like the MySQL path).
   */
  async smartUpsert(
    schema: string,
    table: string,
    naturalKeyColumn: string,
    row: UpsertRow,
  ): Promise<UpsertResult> {
    this.ensureConnected();

    const columns = Object.keys(row);
    if (columns.length === 0) throw new Error('Cannot upsert an empty row');

    const naturalKeyValue = String(row[naturalKeyColumn] ?? '');
    if (!naturalKeyValue) throw new Error(`Natural key column "${naturalKeyColumn}" is missing or empty in row`);

    const qualifiedTable = `[${schema}].[${table}]`;

    // 1. Check if the row exists
    const selectReq = this.pool!.request();
    selectReq.input('nk', naturalKeyValue);
    const existing = await selectReq.query(
      `SELECT TOP 1 * FROM ${qualifiedTable} WHERE [${naturalKeyColumn}] = @nk`,
    );

    if (existing.recordset.length === 0) {
      // INSERT — new row. Use positional param names to avoid collisions with column names.
      const insertReq = this.pool!.request();
      columns.forEach((col, i) => insertReq.input(`c${i}`, row[col]));
      const columnList = columns.map((c) => `[${c}]`).join(', ');
      const valueList = columns.map((_, i) => `@c${i}`).join(', ');
      await insertReq.query(`INSERT INTO ${qualifiedTable} (${columnList}) VALUES (${valueList})`);
      return { action: 'inserted', naturalKey: naturalKeyValue, changedColumns: columns };
    }

    // 2. Compare column-by-column
    const existingRow = existing.recordset[0] as Record<string, unknown>;
    const changedColumns: string[] = [];
    const changedValues: unknown[] = [];

    // Normalize for comparison: mssql returns Date objects for datetime columns and
    // numeric strings for DECIMAL — coerce both sides to a comparable form.
    const normalize = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      if (v instanceof Date) return v.toISOString();
      if (typeof v === 'object') return JSON.stringify(v);
      const n = Number(v);
      if (!isNaN(n) && String(v).trim() !== '') return String(n);
      return String(v);
    };

    for (const col of columns) {
      if (col === naturalKeyColumn) continue;
      if (normalize(row[col]) !== normalize(existingRow[col])) {
        changedColumns.push(col);
        changedValues.push(row[col]);
      }
    }

    if (changedColumns.length === 0) {
      return { action: 'skipped', naturalKey: naturalKeyValue, changedColumns: [] };
    }

    // 3. UPDATE only the changed columns
    const updateReq = this.pool!.request();
    changedColumns.forEach((_, i) => updateReq.input(`u${i}`, changedValues[i]));
    updateReq.input('nk', naturalKeyValue);
    const setClauses = changedColumns.map((col, i) => `[${col}] = @u${i}`);
    await updateReq.query(
      `UPDATE ${qualifiedTable} SET ${setClauses.join(', ')} WHERE [${naturalKeyColumn}] = @nk`,
    );

    return { action: 'updated', naturalKey: naturalKeyValue, changedColumns };
  }

  async introspect(schema: string, table: string): Promise<IntrospectResult> {
    this.ensureConnected();

    const request = this.pool!.request();
    request.input('schema', sql.NVarChar, schema);
    request.input('table', sql.NVarChar, table);

    // Introspect via the sys.columns catalog views (T-06): exposes identity,
    // computed and MAX-length metadata that INFORMATION_SCHEMA flattens away.
    const result = await request.query(`
      SELECT
        c.name              AS column_name,
        t.name              AS data_type,
        c.is_nullable       AS is_nullable,
        c.max_length        AS max_length,
        c.precision         AS numeric_precision,
        c.scale             AS numeric_scale,
        dc.definition       AS column_default,
        c.column_id         AS ordinal_position
      FROM sys.columns c
        INNER JOIN sys.objects o ON o.object_id = c.object_id
        INNER JOIN sys.schemas s ON s.schema_id = o.schema_id
        INNER JOIN sys.types   t ON t.user_type_id = c.user_type_id
        LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
      WHERE s.name = @schema
        AND o.name = @table
        AND o.type IN ('U', 'V')
      ORDER BY c.column_id
    `);

    const columns: DbColumnSpec[] = result.recordset.map((r: Record<string, unknown>) => {
      const rawMax = r.max_length as number | null;
      return {
        columnName: r.column_name as string,
        dataType: r.data_type as string,
        // sys.columns.is_nullable is a BIT (true/false / 1/0)
        isNullable: r.is_nullable === true || r.is_nullable === 1,
        // -1 == MAX (e.g. NVARCHAR(MAX)); expose as null like the other engines
        maxLength: rawMax === -1 || rawMax === null || rawMax === undefined ? null : rawMax,
        numericPrecision: (r.numeric_precision as number | null) ?? null,
        numericScale: (r.numeric_scale as number | null) ?? null,
        columnDefault: (r.column_default as string | null) ?? null,
        ordinalPosition: r.ordinal_position as number,
      };
    });

    return {
      schema,
      table,
      columns,
      exists: columns.length > 0,
    };
  }

  async applyDdl(statements: string[]): Promise<void> {
    this.ensureConnected();

    const transaction = new sql.Transaction(this.pool!);
    await transaction.begin();

    try {
      for (const stmt of statements) {
        const request = new sql.Request(transaction);
        await request.query(stmt);
      }
      await transaction.commit();
    } catch (err: unknown) {
      await transaction.rollback();
      throw err;
    }
  }

  async softDelete(
    schema: string,
    table: string,
    naturalKeyColumn: string,
    naturalKeyValue: string,
  ): Promise<void> {
    this.ensureConnected();

    const qualifiedTable = `[${schema}].[${table}]`;
    const request = this.pool!.request();
    request.input('keyValue', sql.NVarChar, naturalKeyValue);

    await request.query(`
      UPDATE ${qualifiedTable}
      SET [is_deleted] = 1
      WHERE [${naturalKeyColumn}] = @keyValue
    `);
  }

  async testConnection(config: DbConnectionConfig): Promise<boolean> {
    // Dedicated pool so closing it never affects an active connect() pool.
    const testPool = new sql.ConnectionPool({
      server: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      options: {
        encrypt: config.ssl ?? false,
        trustServerCertificate: true,
      },
      connectionTimeout: 5000,
    });

    try {
      await testPool.connect();
      await testPool.request().query('SELECT 1 AS ok');
      return true;
    } catch {
      return false;
    } finally {
      try {
        await testPool.close();
      } catch {
        // ignore close errors
      }
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }

  private ensureConnected(): void {
    if (!this.pool) {
      throw new Error('SqlServerWriter is not connected. Call connect() first.');
    }
  }
}
