import { Pool, type PoolClient } from 'pg';
import type { IDbWriter } from './IDbWriter';
import type {
  DbConnectionConfig,
  UpsertRow,
  UpsertResult,
  IntrospectResult,
  DbColumnSpec,
} from '../types';

export class PostgresWriter implements IDbWriter {
  readonly engine = 'postgres';
  private pool: Pool | null = null;

  async connect(config: DbConnectionConfig): Promise<void> {
    this.pool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    // Validate the connection immediately
    const client = await this.pool.connect();
    client.release();
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

    const placeholders = columns.map((_, i) => `$${i + 1}`);
    const values = columns.map((col) => row[col]);

    // Build SET clause for all columns except the natural key
    const updateColumns = columns.filter((c) => c !== naturalKeyColumn);
    const setClauses = updateColumns.map(
      (col) => `"${col}" = EXCLUDED."${col}"`,
    );

    const qualifiedTable = `"${schema}"."${table}"`;
    const columnList = columns.map((c) => `"${c}"`).join(', ');
    const placeholderList = placeholders.join(', ');

    let sql: string;
    if (setClauses.length > 0) {
      sql = `
        INSERT INTO ${qualifiedTable} (${columnList})
        VALUES (${placeholderList})
        ON CONFLICT ("${naturalKeyColumn}") DO UPDATE
        SET ${setClauses.join(', ')}
        RETURNING (xmax = 0) AS is_insert
      `;
    } else {
      // Only the natural key column — nothing to update
      sql = `
        INSERT INTO ${qualifiedTable} (${columnList})
        VALUES (${placeholderList})
        ON CONFLICT ("${naturalKeyColumn}") DO NOTHING
        RETURNING (xmax = 0) AS is_insert
      `;
    }

    const result = await this.pool!.query(sql, values);

    if (result.rowCount === 0) {
      return { action: 'skipped', naturalKey: naturalKeyValue };
    }

    const isInsert = result.rows[0]?.is_insert === true;
    return {
      action: isInsert ? 'inserted' : 'updated',
      naturalKey: naturalKeyValue,
    };
  }

  /**
   * Smart UPSERT: fetches the existing row first, compares column-by-column,
   * and only UPDATEs the columns that actually changed.
   * Returns which columns were changed (empty = no changes = skipped).
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

    const qualifiedTable = `"${schema}"."${table}"`;

    // 1. Check if row exists
    const existing = await this.pool!.query(
      `SELECT * FROM ${qualifiedTable} WHERE "${naturalKeyColumn}" = $1 LIMIT 1`,
      [naturalKeyValue],
    );

    if (existing.rowCount === 0) {
      // INSERT — new row
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      const values = columns.map((col) => row[col]);
      const columnList = columns.map((c) => `"${c}"`).join(', ');
      await this.pool!.query(
        `INSERT INTO ${qualifiedTable} (${columnList}) VALUES (${placeholders.join(', ')})`,
        values,
      );
      return { action: 'inserted', naturalKey: naturalKeyValue, changedColumns: columns };
    }

    // 2. Compare column-by-column — only update what changed
    const existingRow = existing.rows[0];
    const changedColumns: string[] = [];
    const changedValues: unknown[] = [];

    for (const col of columns) {
      if (col === naturalKeyColumn) continue;
      const newVal = row[col];
      const oldVal = existingRow[col];

      // Normalize for comparison (JSON stringify for objects, string coerce for others)
      const newStr = newVal === null || newVal === undefined ? null : typeof newVal === 'object' ? JSON.stringify(newVal) : String(newVal);
      const oldStr = oldVal === null || oldVal === undefined ? null : typeof oldVal === 'object' ? JSON.stringify(oldVal) : String(oldVal);

      if (newStr !== oldStr) {
        changedColumns.push(col);
        changedValues.push(newVal);
      }
    }

    if (changedColumns.length === 0) {
      return { action: 'skipped', naturalKey: naturalKeyValue, changedColumns: [] };
    }

    // 3. UPDATE only the changed columns
    const setClauses = changedColumns.map((col, i) => `"${col}" = $${i + 1}`);
    changedValues.push(naturalKeyValue); // for WHERE clause
    await this.pool!.query(
      `UPDATE ${qualifiedTable} SET ${setClauses.join(', ')} WHERE "${naturalKeyColumn}" = $${changedValues.length}`,
      changedValues,
    );

    return { action: 'updated', naturalKey: naturalKeyValue, changedColumns };
  }

  async introspect(schema: string, table: string): Promise<IntrospectResult> {
    this.ensureConnected();

    const sql = `
      SELECT
        column_name,
        data_type,
        is_nullable,
        character_maximum_length,
        numeric_precision,
        numeric_scale,
        column_default,
        ordinal_position
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `;

    const result = await this.pool!.query(sql, [schema, table]);

    const columns: DbColumnSpec[] = result.rows.map((r) => ({
      columnName: r.column_name,
      dataType: r.data_type,
      isNullable: r.is_nullable === 'YES',
      maxLength: r.character_maximum_length,
      numericPrecision: r.numeric_precision,
      numericScale: r.numeric_scale,
      columnDefault: r.column_default,
      ordinalPosition: r.ordinal_position,
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

    const client: PoolClient = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      for (const stmt of statements) {
        await client.query(stmt);
      }
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async softDelete(
    schema: string,
    table: string,
    naturalKeyColumn: string,
    naturalKeyValue: string,
  ): Promise<void> {
    this.ensureConnected();

    const qualifiedTable = `"${schema}"."${table}"`;
    const sql = `
      UPDATE ${qualifiedTable}
      SET "is_deleted" = true
      WHERE "${naturalKeyColumn}" = $1
    `;
    await this.pool!.query(sql, [naturalKeyValue]);
  }

  async testConnection(config: DbConnectionConfig): Promise<boolean> {
    const testPool = new Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: 1,
      connectionTimeoutMillis: 5000,
    });

    try {
      const result = await testPool.query('SELECT 1 AS ok');
      return result.rows[0]?.ok === 1;
    } catch {
      return false;
    } finally {
      await testPool.end();
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  private ensureConnected(): void {
    if (!this.pool) {
      throw new Error('PostgresWriter is not connected. Call connect() first.');
    }
  }
}
