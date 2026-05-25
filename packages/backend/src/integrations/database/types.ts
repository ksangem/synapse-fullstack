/**
 * Database destination connector types.
 */

export type DbEngine = 'postgres' | 'sqlserver';

export interface DbConnectionConfig {
  engine: DbEngine;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl?: boolean;
}

export interface DbColumnSpec {
  columnName: string;
  dataType: string;
  isNullable: boolean;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  columnDefault: string | null;
  ordinalPosition: number;
}

export interface DbTableSchema {
  schema: string;
  table: string;
  columns: DbColumnSpec[];
}

export interface DbTableMapping {
  schema: string;
  table: string;
  naturalKeyColumn: string;
  propagateDeletes: boolean;
  columns: DbColumnMapping[];
}

export interface DbColumnMapping {
  from: string;
  to: string;
  type: DbColumnType;
}

export type DbColumnType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'datetime'
  | 'json';

export interface UpsertRow {
  [column: string]: unknown;
}

export interface UpsertResult {
  action: 'inserted' | 'updated' | 'skipped';
  naturalKey: string;
  /** Columns that were actually changed (only set for smart upsert) */
  changedColumns?: string[];
}

export interface IntrospectResult {
  schema: string;
  table: string;
  columns: DbColumnSpec[];
  exists: boolean;
}
