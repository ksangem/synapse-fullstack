/**
 * DbSchemaDiffCalculator — compares operator's planned mapping against the
 * live target table and generates ALTER TABLE DDL for missing columns.
 *
 * Hybrid schema mode: introspect at design-time, generate DDL preview at
 * wizard-time, require explicit operator approval before applying.
 * NEVER auto-DDL at runtime.
 */

import type { DbColumnSpec, DbColumnMapping, DbEngine } from './types';

export interface DdlDiffResult {
  /** Columns that exist in the mapping but not in the target table */
  missingColumns: MissingColumn[];
  /** ALTER TABLE statements to add the missing columns */
  ddlStatements: string[];
  /** Whether the table needs changes before the integration can run */
  requiresApproval: boolean;
}

export interface MissingColumn {
  columnName: string;
  mappingType: string;
  suggestedDbType: string;
}

export class DbSchemaDiffCalculator {
  /**
   * Calculate the diff between mapped columns and the live table schema.
   */
  static calculate(
    engine: DbEngine,
    schema: string,
    table: string,
    mappings: DbColumnMapping[],
    naturalKeyColumn: string,
    existingColumns: DbColumnSpec[],
  ): DdlDiffResult {
    const existingNames = new Set(existingColumns.map((c) => c.columnName.toLowerCase()));
    const missingColumns: MissingColumn[] = [];

    // Check natural key column
    if (!existingNames.has(naturalKeyColumn.toLowerCase())) {
      missingColumns.push({
        columnName: naturalKeyColumn,
        mappingType: 'string',
        suggestedDbType: resolveDbType('string', engine),
      });
    }

    // Check each mapped column
    for (const mapping of mappings) {
      if (!existingNames.has(mapping.to.toLowerCase())) {
        missingColumns.push({
          columnName: mapping.to,
          mappingType: mapping.type,
          suggestedDbType: resolveDbType(mapping.type, engine),
        });
      }
    }

    // Check is_deleted column if propagateDeletes might be used
    if (!existingNames.has('is_deleted')) {
      const boolType = engine === 'postgres' ? 'BOOLEAN DEFAULT false'
        : engine === 'mysql' ? 'TINYINT(1) DEFAULT 0'
        : 'BIT DEFAULT 0';
      missingColumns.push({
        columnName: 'is_deleted',
        mappingType: 'boolean',
        suggestedDbType: boolType,
      });
    }

    const ddlStatements = missingColumns.map((col) =>
      generateAlterAdd(engine, schema, table, col.columnName, col.suggestedDbType),
    );

    return {
      missingColumns,
      ddlStatements,
      requiresApproval: missingColumns.length > 0,
    };
  }
}

/**
 * Map a canonical mapping type to a concrete DB column type.
 */
function resolveDbType(mappingType: string, engine: DbEngine): string {
  if (engine === 'postgres') {
    switch (mappingType) {
      case 'string': return 'TEXT';
      case 'number': return 'NUMERIC';
      case 'boolean': return 'BOOLEAN DEFAULT false';
      case 'datetime': return 'TIMESTAMPTZ';
      case 'json': return 'JSONB';
      default: return 'TEXT';
    }
  }

  if (engine === 'mysql') {
    switch (mappingType) {
      case 'string': return 'TEXT';
      case 'number': return 'DECIMAL(18,4)';
      case 'boolean': return 'TINYINT(1) DEFAULT 0';
      case 'datetime': return 'DATETIME';
      case 'json': return 'JSON';
      default: return 'TEXT';
    }
  }

  // SQL Server
  switch (mappingType) {
    case 'string': return 'NVARCHAR(MAX)';
    case 'number': return 'DECIMAL(18,4)';
    case 'boolean': return 'BIT DEFAULT 0';
    case 'datetime': return 'DATETIMEOFFSET';
    case 'json': return 'NVARCHAR(MAX)';
    default: return 'NVARCHAR(MAX)';
  }
}

function generateAlterAdd(
  engine: DbEngine,
  schema: string,
  table: string,
  columnName: string,
  dbType: string,
): string {
  if (engine === 'postgres') {
    return `ALTER TABLE "${schema}"."${table}" ADD COLUMN "${columnName}" ${dbType};`;
  }
  if (engine === 'mysql') {
    return `ALTER TABLE \`${schema}\`.\`${table}\` ADD COLUMN \`${columnName}\` ${dbType};`;
  }
  return `ALTER TABLE [${schema}].[${table}] ADD [${columnName}] ${dbType};`;
}
