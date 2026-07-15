/**
 * Strategy interface for database-engine-specific operations.
 * One implementation per dialect (Postgres, SQL Server, etc.).
 */

import type { DbConnectionConfig, UpsertRow, UpsertResult, IntrospectResult } from '../types';

export interface IDbWriter {
  readonly engine: string;

  /**
   * Open a connection to the target database.
   */
  connect(config: DbConnectionConfig): Promise<void>;

  /**
   * UPSERT a single row by natural key column.
   * Returns whether the row was inserted or updated.
   */
  upsert(
    schema: string,
    table: string,
    naturalKeyColumn: string,
    row: UpsertRow,
  ): Promise<UpsertResult>;

  /**
   * Smart UPSERT: fetches the existing row, compares column-by-column, and
   * only writes the columns that actually changed. Returns the changed columns
   * (empty = no change = skipped). Used by the SharePoint→DB sync flow.
   */
  smartUpsert(
    schema: string,
    table: string,
    naturalKeyColumn: string,
    row: UpsertRow,
  ): Promise<UpsertResult>;

  /**
   * Read the column schema of a target table via information_schema.
   */
  introspect(schema: string, table: string): Promise<IntrospectResult>;

  /**
   * Read-only bulk SELECT of the given columns from a table (or all columns when
   * `columns` is empty). Returns the raw rows; grouping/indexing by a join key is
   * the caller's job (the entity-join provider). Used ONLY by cross-entity
   * join/lookup enrichment — never by the write path.
   */
  loadRows(schema: string, table: string, columns: string[]): Promise<Record<string, unknown>[]>;

  /**
   * Execute raw DDL (ALTER TABLE, etc.) within a transaction.
   */
  applyDdl(statements: string[]): Promise<void>;

  /**
   * Mark a row as soft-deleted (set is_deleted = true).
   */
  softDelete(
    schema: string,
    table: string,
    naturalKeyColumn: string,
    naturalKeyValue: string,
  ): Promise<void>;

  /**
   * Test the connection by running SELECT 1.
   */
  testConnection(config: DbConnectionConfig): Promise<boolean>;

  /**
   * Close the connection / release the pool.
   */
  disconnect(): Promise<void>;
}
