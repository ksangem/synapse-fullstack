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

    this.pool = await sql.connect(sqlConfig);
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

  async introspect(schema: string, table: string): Promise<IntrospectResult> {
    this.ensureConnected();

    const request = this.pool!.request();
    request.input('schema', sql.NVarChar, schema);
    request.input('table', sql.NVarChar, table);

    const result = await request.query(`
      SELECT
        COLUMN_NAME AS column_name,
        DATA_TYPE AS data_type,
        IS_NULLABLE AS is_nullable,
        CHARACTER_MAXIMUM_LENGTH AS character_maximum_length,
        NUMERIC_PRECISION AS numeric_precision,
        NUMERIC_SCALE AS numeric_scale,
        COLUMN_DEFAULT AS column_default,
        ORDINAL_POSITION AS ordinal_position
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @schema
        AND TABLE_NAME = @table
      ORDER BY ORDINAL_POSITION
    `);

    const columns: DbColumnSpec[] = result.recordset.map((r: Record<string, unknown>) => ({
      columnName: r.column_name as string,
      dataType: r.data_type as string,
      isNullable: r.is_nullable === 'YES',
      maxLength: r.character_maximum_length as number | null,
      numericPrecision: r.numeric_precision as number | null,
      numericScale: r.numeric_scale as number | null,
      columnDefault: r.column_default as string | null,
      ordinalPosition: r.ordinal_position as number,
    }));

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
    try {
      const testPool = await sql.connect({
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

      await testPool.request().query('SELECT 1 AS ok');
      await testPool.close();
      return true;
    } catch {
      return false;
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
