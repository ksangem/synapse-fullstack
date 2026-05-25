import type { IDbWriter } from './writers/IDbWriter';
import type { IntrospectResult, DbColumnSpec } from './types';

/**
 * High-level schema introspection service.
 * Delegates to the engine-specific IDbWriter.introspect() method,
 * then provides convenience methods over the result.
 */
export class DbSchemaIntrospector {
  constructor(private readonly writer: IDbWriter) {}

  async getTableSchema(schema: string, table: string): Promise<IntrospectResult> {
    return this.writer.introspect(schema, table);
  }

  async tableExists(schema: string, table: string): Promise<boolean> {
    const result = await this.writer.introspect(schema, table);
    return result.exists;
  }

  async getColumnNames(schema: string, table: string): Promise<string[]> {
    const result = await this.writer.introspect(schema, table);
    return result.columns.map((c) => c.columnName);
  }

  async getColumn(
    schema: string,
    table: string,
    columnName: string,
  ): Promise<DbColumnSpec | undefined> {
    const result = await this.writer.introspect(schema, table);
    return result.columns.find((c) => c.columnName === columnName);
  }

  async hasColumn(
    schema: string,
    table: string,
    columnName: string,
  ): Promise<boolean> {
    const col = await this.getColumn(schema, table, columnName);
    return col !== undefined;
  }
}
