import { describe, it, expect } from 'vitest';
import { DbSchemaDiffCalculator } from '../integrations/database/DbSchemaDiffCalculator';
import type { DbColumnSpec, DbColumnMapping } from '../integrations/database/types';

describe('DbSchemaDiffCalculator', () => {
  const existingColumns: DbColumnSpec[] = [
    { columnName: 'sp_item_id', dataType: 'character varying', isNullable: false, maxLength: 128, numericPrecision: null, numericScale: null, columnDefault: null, ordinalPosition: 1 },
    { columnName: 'title', dataType: 'text', isNullable: true, maxLength: null, numericPrecision: null, numericScale: null, columnDefault: null, ordinalPosition: 2 },
    { columnName: 'is_deleted', dataType: 'boolean', isNullable: true, maxLength: null, numericPrecision: null, numericScale: null, columnDefault: 'false', ordinalPosition: 3 },
  ];

  const mappings: DbColumnMapping[] = [
    { from: 'Title', to: 'title', type: 'string' },
    { from: 'Owner.email', to: 'owner_email', type: 'string' },
    { from: 'Created', to: 'created_utc', type: 'datetime' },
    { from: 'Amount', to: 'amount', type: 'number' },
  ];

  it('detects missing columns (Postgres)', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'postgres',
      'public',
      'projects',
      mappings,
      'sp_item_id',
      existingColumns,
    );

    expect(result.requiresApproval).toBe(true);
    expect(result.missingColumns).toHaveLength(3); // owner_email, created_utc, amount
    const names = result.missingColumns.map((c) => c.columnName);
    expect(names).toContain('owner_email');
    expect(names).toContain('created_utc');
    expect(names).toContain('amount');
  });

  it('generates Postgres ALTER TABLE statements', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'postgres',
      'public',
      'projects',
      mappings,
      'sp_item_id',
      existingColumns,
    );

    for (const stmt of result.ddlStatements) {
      expect(stmt).toMatch(/^ALTER TABLE "public"\."projects" ADD COLUMN/);
      expect(stmt).toMatch(/;$/);
    }

    const ownerStmt = result.ddlStatements.find((s) => s.includes('owner_email'));
    expect(ownerStmt).toContain('TEXT');

    const dateStmt = result.ddlStatements.find((s) => s.includes('created_utc'));
    expect(dateStmt).toContain('TIMESTAMPTZ');

    const amountStmt = result.ddlStatements.find((s) => s.includes('amount'));
    expect(amountStmt).toContain('NUMERIC');
  });

  it('generates SQL Server ALTER TABLE statements', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'sqlserver',
      'dbo',
      'projects',
      mappings,
      'sp_item_id',
      existingColumns,
    );

    for (const stmt of result.ddlStatements) {
      expect(stmt).toMatch(/^ALTER TABLE \[dbo\]\.\[projects\] ADD/);
    }

    const ownerStmt = result.ddlStatements.find((s) => s.includes('owner_email'));
    expect(ownerStmt).toContain('NVARCHAR(MAX)');

    const dateStmt = result.ddlStatements.find((s) => s.includes('created_utc'));
    expect(dateStmt).toContain('DATETIMEOFFSET');
  });

  it('returns no changes when all columns exist', () => {
    const fullColumns: DbColumnSpec[] = [
      ...existingColumns,
      { columnName: 'owner_email', dataType: 'text', isNullable: true, maxLength: null, numericPrecision: null, numericScale: null, columnDefault: null, ordinalPosition: 4 },
      { columnName: 'created_utc', dataType: 'timestamptz', isNullable: true, maxLength: null, numericPrecision: null, numericScale: null, columnDefault: null, ordinalPosition: 5 },
      { columnName: 'amount', dataType: 'numeric', isNullable: true, maxLength: null, numericPrecision: null, numericScale: null, columnDefault: null, ordinalPosition: 6 },
    ];

    const result = DbSchemaDiffCalculator.calculate(
      'postgres',
      'public',
      'projects',
      mappings,
      'sp_item_id',
      fullColumns,
    );

    expect(result.requiresApproval).toBe(false);
    expect(result.missingColumns).toHaveLength(0);
    expect(result.ddlStatements).toHaveLength(0);
  });

  it('detects missing natural key column', () => {
    const result = DbSchemaDiffCalculator.calculate(
      'postgres',
      'public',
      'projects',
      mappings,
      'external_id', // not in existingColumns
      existingColumns,
    );

    const names = result.missingColumns.map((c) => c.columnName);
    expect(names).toContain('external_id');
  });

  it('detects missing is_deleted column', () => {
    const columnsWithoutDeleted = existingColumns.filter((c) => c.columnName !== 'is_deleted');

    const result = DbSchemaDiffCalculator.calculate(
      'postgres',
      'public',
      'projects',
      [],
      'sp_item_id',
      columnsWithoutDeleted,
    );

    const names = result.missingColumns.map((c) => c.columnName);
    expect(names).toContain('is_deleted');
  });

  it('column matching is case-insensitive', () => {
    const upperColumns: DbColumnSpec[] = [
      { columnName: 'SP_ITEM_ID', dataType: 'varchar', isNullable: false, maxLength: 128, numericPrecision: null, numericScale: null, columnDefault: null, ordinalPosition: 1 },
      { columnName: 'TITLE', dataType: 'text', isNullable: true, maxLength: null, numericPrecision: null, numericScale: null, columnDefault: null, ordinalPosition: 2 },
      { columnName: 'IS_DELETED', dataType: 'boolean', isNullable: true, maxLength: null, numericPrecision: null, numericScale: null, columnDefault: null, ordinalPosition: 3 },
    ];

    const result = DbSchemaDiffCalculator.calculate(
      'postgres',
      'public',
      'projects',
      [{ from: 'Title', to: 'title', type: 'string' }],
      'sp_item_id',
      upperColumns,
    );

    // title and sp_item_id and is_deleted should match despite case
    expect(result.missingColumns).toHaveLength(0);
    expect(result.requiresApproval).toBe(false);
  });
});
