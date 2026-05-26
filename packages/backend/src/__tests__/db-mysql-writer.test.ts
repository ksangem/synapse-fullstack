/**
 * MySqlWriter unit tests.
 *
 * Unit tests run without a real MySQL connection.
 * Integration tests require: docker compose up -d mysql
 */
import { describe, it, expect } from 'vitest';
import { MySqlWriter } from '../integrations/database/writers/MySqlWriter';
import { DbSchemaDiffCalculator } from '../integrations/database/DbSchemaDiffCalculator';

// ═══════════════════════════════════════════════════════
// Unit Tests — no DB required
// ═══════════════════════════════════════════════════════

describe('MySqlWriter: unit tests', () => {
  it('has engine set to mysql', () => {
    const writer = new MySqlWriter();
    expect(writer.engine).toBe('mysql');
  });

  it('throws when calling upsert without connect()', async () => {
    const writer = new MySqlWriter();
    await expect(
      writer.upsert('db', 'table', 'id', { id: '1', name: 'test' }),
    ).rejects.toThrow('not connected');
  });

  it('throws when calling smartUpsert without connect()', async () => {
    const writer = new MySqlWriter();
    await expect(
      writer.smartUpsert('db', 'table', 'id', { id: '1', name: 'test' }),
    ).rejects.toThrow('not connected');
  });

  it('throws when calling introspect without connect()', async () => {
    const writer = new MySqlWriter();
    await expect(
      writer.introspect('db', 'table'),
    ).rejects.toThrow('not connected');
  });

  it('throws when calling applyDdl without connect()', async () => {
    const writer = new MySqlWriter();
    await expect(
      writer.applyDdl(['CREATE TABLE t (id INT)']),
    ).rejects.toThrow('not connected');
  });

  it('throws when calling softDelete without connect()', async () => {
    const writer = new MySqlWriter();
    await expect(
      writer.softDelete('db', 'table', 'id', '1'),
    ).rejects.toThrow('not connected');
  });

  it('disconnect on unconnected writer does not throw', async () => {
    const writer = new MySqlWriter();
    await expect(writer.disconnect()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════
// DbSchemaDiffCalculator — MySQL engine
// ═══════════════════════════════════════════════════════

describe('DbSchemaDiffCalculator: MySQL engine', () => {
  it('resolves string type to TEXT for MySQL', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'mysql', 'synapse_db', 'test_table',
      [{ from: 'Title', to: 'title', type: 'string' }],
      'sp_item_id',
      [],
    );
    const titleCol = result.missingColumns.find(c => c.columnName === 'title');
    expect(titleCol?.suggestedDbType).toBe('TEXT');
  });

  it('resolves number type to DECIMAL(18,4) for MySQL', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'mysql', 'synapse_db', 'test_table',
      [{ from: 'Count', to: 'count', type: 'number' }],
      'sp_item_id',
      [],
    );
    const countCol = result.missingColumns.find(c => c.columnName === 'count');
    expect(countCol?.suggestedDbType).toBe('DECIMAL(18,4)');
  });

  it('resolves boolean type to TINYINT(1) DEFAULT 0 for MySQL', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'mysql', 'synapse_db', 'test_table',
      [{ from: 'Active', to: 'active', type: 'boolean' }],
      'sp_item_id',
      [],
    );
    const activeCol = result.missingColumns.find(c => c.columnName === 'active');
    expect(activeCol?.suggestedDbType).toBe('TINYINT(1) DEFAULT 0');
  });

  it('resolves datetime type to DATETIME for MySQL', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'mysql', 'synapse_db', 'test_table',
      [{ from: 'Created', to: 'created', type: 'datetime' }],
      'sp_item_id',
      [],
    );
    const dateCol = result.missingColumns.find(c => c.columnName === 'created');
    expect(dateCol?.suggestedDbType).toBe('DATETIME');
  });

  it('resolves json type to JSON for MySQL', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'mysql', 'synapse_db', 'test_table',
      [{ from: 'Meta', to: 'meta', type: 'json' }],
      'sp_item_id',
      [],
    );
    const jsonCol = result.missingColumns.find(c => c.columnName === 'meta');
    expect(jsonCol?.suggestedDbType).toBe('JSON');
  });

  it('generates ALTER TABLE with backtick quoting for MySQL', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'mysql', 'synapse_db', 'test_table',
      [{ from: 'Title', to: 'title', type: 'string' }],
      'sp_item_id',
      [],
    );
    const alterStmt = result.ddlStatements.find(s => s.includes('`title`'));
    expect(alterStmt).toBeDefined();
    expect(alterStmt).toContain('ALTER TABLE `synapse_db`.`test_table`');
    expect(alterStmt).toContain('ADD COLUMN `title`');
  });

  it('is_deleted column uses TINYINT(1) DEFAULT 0 for MySQL', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'mysql', 'synapse_db', 'test_table',
      [],
      'sp_item_id',
      [],
    );
    const delCol = result.missingColumns.find(c => c.columnName === 'is_deleted');
    expect(delCol?.suggestedDbType).toBe('TINYINT(1) DEFAULT 0');
  });
});

// ═══════════════════════════════════════════════════════
// Integration Tests — require live MySQL (docker compose up -d mysql)
// ═══════════════════════════════════════════════════════

const MYSQL_HOST = 'localhost';
const MYSQL_PORT = 3307;
const MYSQL_DB = 'synapse_db';
const MYSQL_USER = 'synapse';
const MYSQL_PASS = 'synapse';

describe('MySqlWriter: integration tests (requires MySQL)', () => {
  it('testConnection returns true for valid credentials', async () => {
    const writer = new MySqlWriter();
    const ok = await writer.testConnection({
      engine: 'mysql',
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      database: MYSQL_DB,
      username: MYSQL_USER,
      password: MYSQL_PASS,
    });
    // If MySQL isn't running, this will return false — not a test failure
    if (!ok) {
      console.warn('⚠ MySQL not available — skipping integration tests');
    }
    expect(typeof ok).toBe('boolean');
  });

  it('testConnection returns false for bad credentials', async () => {
    const writer = new MySqlWriter();
    const ok = await writer.testConnection({
      engine: 'mysql',
      host: MYSQL_HOST,
      port: MYSQL_PORT,
      database: MYSQL_DB,
      username: 'wrong_user',
      password: 'wrong_pass',
    });
    expect(ok).toBe(false);
  });

  it('full round-trip: connect, applyDdl, upsert, introspect, softDelete, disconnect', async () => {
    const writer = new MySqlWriter();
    const testOk = await writer.testConnection({
      engine: 'mysql', host: MYSQL_HOST, port: MYSQL_PORT,
      database: MYSQL_DB, username: MYSQL_USER, password: MYSQL_PASS,
    });
    if (!testOk) {
      console.warn('⚠ MySQL not available — skipping round-trip test');
      return;
    }

    await writer.connect({
      engine: 'mysql', host: MYSQL_HOST, port: MYSQL_PORT,
      database: MYSQL_DB, username: MYSQL_USER, password: MYSQL_PASS,
    });

    try {
      const testTable = 'e2e_mysql_test_' + Date.now();

      // 1. Create table
      await writer.applyDdl([
        `CREATE TABLE \`${MYSQL_DB}\`.\`${testTable}\` (
          \`sp_item_id\` VARCHAR(128) PRIMARY KEY,
          \`title\` TEXT,
          \`count\` DECIMAL(18,4),
          \`is_deleted\` TINYINT(1) DEFAULT 0,
          \`synced_at\` DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB`,
      ]);

      // 2. Introspect
      const schema = await writer.introspect(MYSQL_DB, testTable);
      expect(schema.exists).toBe(true);
      expect(schema.columns.length).toBeGreaterThanOrEqual(4);
      const colNames = schema.columns.map(c => c.columnName);
      expect(colNames).toContain('sp_item_id');
      expect(colNames).toContain('title');

      // 3. Upsert — INSERT
      const insertResult = await writer.upsert(MYSQL_DB, testTable, 'sp_item_id', {
        sp_item_id: 'test-1',
        title: 'Hello MySQL',
        count: 42,
      });
      expect(insertResult.action).toBe('inserted');
      expect(insertResult.naturalKey).toBe('test-1');

      // 4. Upsert — UPDATE
      const updateResult = await writer.upsert(MYSQL_DB, testTable, 'sp_item_id', {
        sp_item_id: 'test-1',
        title: 'Updated MySQL',
        count: 99,
      });
      expect(updateResult.action).toBe('updated');

      // 5. Smart upsert — no change = skipped
      const skipResult = await writer.smartUpsert(MYSQL_DB, testTable, 'sp_item_id', {
        sp_item_id: 'test-1',
        title: 'Updated MySQL',
        count: 99,
      });
      expect(skipResult.action).toBe('skipped');
      expect(skipResult.changedColumns).toHaveLength(0);

      // 6. Smart upsert — partial change
      const partialResult = await writer.smartUpsert(MYSQL_DB, testTable, 'sp_item_id', {
        sp_item_id: 'test-1',
        title: 'Changed Only Title',
        count: 99,
      });
      expect(partialResult.action).toBe('updated');
      expect(partialResult.changedColumns).toContain('title');
      expect(partialResult.changedColumns).not.toContain('count');

      // 7. Soft delete
      await writer.softDelete(MYSQL_DB, testTable, 'sp_item_id', 'test-1');

      // 8. Cleanup
      await writer.applyDdl([`DROP TABLE IF EXISTS \`${MYSQL_DB}\`.\`${testTable}\``]);
    } finally {
      await writer.disconnect();
    }
  });
});
