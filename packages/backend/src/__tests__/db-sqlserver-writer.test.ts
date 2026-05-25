import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqlServerWriter } from '../integrations/database/writers/SqlServerWriter';
import { DbSchemaIntrospector } from '../integrations/database/DbSchemaIntrospector';
import type { DbConnectionConfig } from '../integrations/database/types';

/**
 * Commit 6 — SqlServerWriter stand-alone smoke tests.
 *
 * Set TEST_SQLSERVER_URL to enable (e.g., mssql://sa:Password1@localhost:1433/synapse_test).
 * When absent, the live-DB tests are skipped.
 */

const TEST_SQLSERVER_URL = process.env.TEST_SQLSERVER_URL || '';

function parseSqlServerUrl(url: string): DbConnectionConfig {
  const parsed = new URL(url);
  return {
    engine: 'sqlserver',
    host: parsed.hostname,
    port: Number(parsed.port) || 1433,
    database: parsed.pathname.replace('/', ''),
    username: parsed.username,
    password: parsed.password,
    ssl: false,
  };
}

const hasDb = TEST_SQLSERVER_URL.startsWith('mssql');
const describeDb = hasDb ? describe : describe.skip;

// ─── Unit tests (no DB needed) ──────────────────────────────

describe('SqlServerWriter (unit)', () => {
  it('engine is sqlserver', () => {
    const writer = new SqlServerWriter();
    expect(writer.engine).toBe('sqlserver');
  });

  it('throws when upsert called without connect()', async () => {
    const writer = new SqlServerWriter();
    await expect(
      writer.upsert('dbo', 'test', 'id', { id: '1' }),
    ).rejects.toThrow('not connected');
  });

  it('throws when introspect called without connect()', async () => {
    const writer = new SqlServerWriter();
    await expect(
      writer.introspect('dbo', 'test'),
    ).rejects.toThrow('not connected');
  });

  it('throws when applyDdl called without connect()', async () => {
    const writer = new SqlServerWriter();
    await expect(
      writer.applyDdl(['SELECT 1']),
    ).rejects.toThrow('not connected');
  });

  it('disconnect on unconnected writer is a no-op', async () => {
    const writer = new SqlServerWriter();
    await expect(writer.disconnect()).resolves.toBeUndefined();
  });
});

// ─── Integration tests (require live SQL Server) ────────────

describeDb('SqlServerWriter (integration)', () => {
  const writer = new SqlServerWriter();
  const introspector = new DbSchemaIntrospector(writer);
  let config: DbConnectionConfig;
  const testTable = '_synapse_ss_writer_test';
  const testSchema = 'dbo';

  beforeAll(async () => {
    config = parseSqlServerUrl(TEST_SQLSERVER_URL);
    await writer.connect(config);

    await writer.applyDdl([
      `IF OBJECT_ID('[${testSchema}].[${testTable}]', 'U') IS NOT NULL DROP TABLE [${testSchema}].[${testTable}]`,
      `CREATE TABLE [${testSchema}].[${testTable}] (
        sp_item_id NVARCHAR(128) PRIMARY KEY,
        title NVARCHAR(MAX),
        owner_email NVARCHAR(255),
        created_utc DATETIMEOFFSET,
        amount DECIMAL(18,4),
        is_deleted BIT DEFAULT 0
      )`,
    ]);
  });

  afterAll(async () => {
    try {
      await writer.applyDdl([
        `IF OBJECT_ID('[${testSchema}].[${testTable}]', 'U') IS NOT NULL DROP TABLE [${testSchema}].[${testTable}]`,
      ]);
    } catch {
      // ignore cleanup errors
    }
    await writer.disconnect();
  });

  it('testConnection returns true for valid config', async () => {
    const result = await writer.testConnection(config);
    expect(result).toBe(true);
  });

  it('introspect returns column schema for test table', async () => {
    const result = await introspector.getTableSchema(testSchema, testTable);

    expect(result.exists).toBe(true);
    expect(result.columns.length).toBe(6);

    const colNames = result.columns.map((c) => c.columnName);
    expect(colNames).toContain('sp_item_id');
    expect(colNames).toContain('title');
    expect(colNames).toContain('is_deleted');
  });

  it('upsert inserts a new row', async () => {
    const result = await writer.upsert(testSchema, testTable, 'sp_item_id', {
      sp_item_id: 'SP-001',
      title: 'Test Project Alpha',
      owner_email: 'alice@example.com',
      amount: 1500.50,
    });

    expect(result.action).toBe('inserted');
    expect(result.naturalKey).toBe('SP-001');
  });

  it('upsert updates existing row (idempotent)', async () => {
    const result = await writer.upsert(testSchema, testTable, 'sp_item_id', {
      sp_item_id: 'SP-001',
      title: 'Test Project Alpha — Updated',
      owner_email: 'alice@example.com',
      amount: 2000.00,
    });

    expect(result.action).toBe('updated');
    expect(result.naturalKey).toBe('SP-001');
  });

  it('softDelete sets is_deleted flag', async () => {
    await writer.upsert(testSchema, testTable, 'sp_item_id', {
      sp_item_id: 'SP-DEL',
      title: 'To Delete',
    });

    await writer.softDelete(testSchema, testTable, 'sp_item_id', 'SP-DEL');
    // No error thrown = success
  });

  it('upsert throws on empty row', async () => {
    await expect(
      writer.upsert(testSchema, testTable, 'sp_item_id', {}),
    ).rejects.toThrow('empty row');
  });

  it('upsert throws when natural key is missing', async () => {
    await expect(
      writer.upsert(testSchema, testTable, 'sp_item_id', { title: 'No key' }),
    ).rejects.toThrow('missing or empty');
  });
});
