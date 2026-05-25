/**
 * DbDestinationConnectorBase — IDestinationConnector implementation
 * that dispatches envelopes to a database via an IDbWriter.
 *
 * Expects the envelope payload (after transform) to contain:
 * { row: Record<string, unknown>, event: string, naturalKeyColumn: string, naturalKeyValue: string }
 */

import type { IDestinationConnector, MessageEnvelope, JsonValue } from '../../hub/interfaces';
import type { IDbWriter } from './writers/IDbWriter';
import type { UpsertRow } from './types';

export class DbDestinationConnectorBase implements IDestinationConnector {
  readonly connectorId: string;
  readonly orgId: string;

  constructor(
    connectorId: string,
    orgId: string,
    private readonly writer: IDbWriter,
    private readonly targetSchema: string,
    private readonly targetTable: string,
    private readonly propagateDeletes: boolean,
  ) {
    this.connectorId = connectorId;
    this.orgId = orgId;
  }

  async dispatch(
    envelope: MessageEnvelope,
    _signal: AbortSignal,
  ): Promise<void> {
    const payload = envelope.payload as Record<string, JsonValue>;
    const event = payload.event as string;
    const row = payload.row as Record<string, JsonValue>;
    const naturalKeyColumn = payload.naturalKeyColumn as string;
    const naturalKeyValue = payload.naturalKeyValue as string;

    if (!row || !naturalKeyColumn || !naturalKeyValue) {
      throw new Error(
        'DbDestinationConnectorBase: envelope payload missing row, naturalKeyColumn, or naturalKeyValue',
      );
    }

    if (event === 'deleted') {
      if (this.propagateDeletes) {
        await this.writer.softDelete(
          this.targetSchema,
          this.targetTable,
          naturalKeyColumn,
          naturalKeyValue,
        );
      }
      // If propagateDeletes is false, ignore deletes (as per spec)
      return;
    }

    // UPSERT by natural key
    await this.writer.upsert(
      this.targetSchema,
      this.targetTable,
      naturalKeyColumn,
      row as UpsertRow,
    );
  }
}
