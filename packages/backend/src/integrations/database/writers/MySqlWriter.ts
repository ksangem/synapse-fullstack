import mysql from 'mysql2/promise';
import type { Pool, PoolConnection } from 'mysql2/promise';
import type { IDbWriter } from './IDbWriter';
import type {
  DbConnectionConfig,
  UpsertRow,
  UpsertResult,
  IntrospectResult,
  DbColumnSpec,
} from '../types';

export class MySqlWriter implements IDbWriter {
  readonly engine = 'mysql';
  private pool: Pool | null = null;

  async connect(config: DbConnectionConfig): Promise<void> {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      waitForConnections: true,
      connectionLimit: 5,
    });
    // Validate the connection immediately
    const conn = await this.pool.getConnection();
    conn.release();
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

    const placeholders = columns.map(() => '?');
    const values = columns.map((col) => row[col]);

    // Build SET clause for all columns except the natural key
    const updateColumns = columns.filter((c) => c !== naturalKeyColumn);
    const setClauses = updateColumns.map(
      (col) => `\`${col}\` = VALUES(\`${col}\`)`,
    );

    const qualifiedTable = schema ? `\`${schema}\`.\`${table}\`` : `\`${table}\``;
    const columnList = columns.map((c) => `\`${c}\``).join(', ');
    const placeholderList = placeholders.join(', ');

    let sql: string;
    if (setClauses.length > 0) {
      sql = `INSERT INTO ${qualifiedTable} (${columnList}) VALUES (${placeholderList}) ON DUPLICATE KEY UPDATE ${setClauses.join(', ')}`;
    } else {
      sql = `INSERT IGNORE INTO ${qualifiedTable} (${columnList}) VALUES (${placeholderList})`;
    }

    const [result] = await this.pool!.execute(sql, values) as any;

    // MySQL affectedRows: 1 = inserted, 2 = updated, 0 = no change
    if (result.affectedRows === 0) {
      return { action: 'skipped', naturalKey: naturalKeyValue };
    }
    return {
      action: result.affectedRows === 1 ? 'inserted' : 'updated',
      naturalKey: naturalKeyValue,
    };
  }

  /**
   * Smart UPSERT: fetches the existing row first, compares column-by-column,
   * and only UPDATEs the columns that actually changed.
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

    const qualifiedTable = schema ? `\`${schema}\`.\`${table}\`` : `\`${table}\``;

    // 1. Check if row exists
    const [existingRows] = await this.pool!.execute(
      `SELECT * FROM ${qualifiedTable} WHERE \`${naturalKeyColumn}\` = ? LIMIT 1`,
      [naturalKeyValue],
    ) as any;

    if (existingRows.length === 0) {
      // INSERT — new row
      const placeholders = columns.map(() => '?');
      const values = columns.map((col) => row[col]);
      const columnList = columns.map((c) => `\`${c}\``).join(', ');
      await this.pool!.execute(
        `INSERT INTO ${qualifiedTable} (${columnList}) VALUES (${placeholders.join(', ')})`,
        values,
      );
      return { action: 'inserted', naturalKey: naturalKeyValue, changedColumns: columns };
    }

    // 2. Compare column-by-column
    const existingRow = existingRows[0];
    const changedColumns: string[] = [];
    const changedValues: unknown[] = [];

    for (const col of columns) {
      if (col === naturalKeyColumn) continue;
      const newVal = row[col];
      const oldVal = existingRow[col];

      // Normalize for comparison — MySQL returns DECIMAL as string "99.0000", numbers as numbers
      const normalize = (v: unknown): string | null => {
        if (v === null || v === undefined) return null;
        if (typeof v === 'object') return JSON.stringify(v);
        // Normalize numeric: parseFloat to strip trailing zeros (99.0000 → 99)
        const n = Number(v);
        if (!isNaN(n) && String(v).trim() !== '') return String(n);
        return String(v);
      };
      const newStr = normalize(newVal);
      const oldStr = normalize(oldVal);

      if (newStr !== oldStr) {
        changedColumns.push(col);
        changedValues.push(newVal);
      }
    }

    if (changedColumns.length === 0) {
      return { action: 'skipped', naturalKey: naturalKeyValue, changedColumns: [] };
    }

    // 3. UPDATE only the changed columns
    const setClauses = changedColumns.map((col) => `\`${col}\` = ?`);
    changedValues.push(naturalKeyValue);
    await this.pool!.execute(
      `UPDATE ${qualifiedTable} SET ${setClauses.join(', ')} WHERE \`${naturalKeyColumn}\` = ?`,
      changedValues,
    );

    return { action: 'updated', naturalKey: naturalKeyValue, changedColumns };
  }

  async introspect(schema: string, table: string): Promise<IntrospectResult> {
    this.ensureConnected();

    const sql = `
      SELECT
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE,
        CHARACTER_MAXIMUM_LENGTH,
        NUMERIC_PRECISION,
        NUMERIC_SCALE,
        COLUMN_DEFAULT,
        ORDINAL_POSITION
      FROM information_schema.columns
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `;

    const [rows] = await this.pool!.execute(sql, [schema, table]) as any;

    const columns: DbColumnSpec[] = rows.map((r: any) => ({
      columnName: r.COLUMN_NAME,
      dataType: r.DATA_TYPE,
      isNullable: r.IS_NULLABLE === 'YES',
      maxLength: r.CHARACTER_MAXIMUM_LENGTH,
      numericPrecision: r.NUMERIC_PRECISION,
      numericScale: r.NUMERIC_SCALE,
      columnDefault: r.COLUMN_DEFAULT,
      ordinalPosition: r.ORDINAL_POSITION,
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

    const conn: PoolConnection = await this.pool!.getConnection();
    try {
      await conn.beginTransaction();
      for (const stmt of statements) {
        await conn.query(stmt);
      }
      await conn.commit();
    } catch (err: unknown) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async softDelete(
    schema: string,
    table: string,
    naturalKeyColumn: string,
    naturalKeyValue: string,
  ): Promise<void> {
    this.ensureConnected();

    const qualifiedTable = schema ? `\`${schema}\`.\`${table}\`` : `\`${table}\``;
    await this.pool!.execute(
      `UPDATE ${qualifiedTable} SET \`is_deleted\` = 1 WHERE \`${naturalKeyColumn}\` = ?`,
      [naturalKeyValue],
    );
  }

  async testConnection(config: DbConnectionConfig): Promise<boolean> {
    const testPool = mysql.createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.username,
      password: config.password,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      waitForConnections: true,
      connectionLimit: 1,
      connectTimeout: 5000,
    });

    try {
      const [rows] = await testPool.execute('SELECT 1 AS ok') as any;
      return rows[0]?.ok === 1;
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
      throw new Error('MySqlWriter is not connected. Call connect() first.');
    }
  }
}
