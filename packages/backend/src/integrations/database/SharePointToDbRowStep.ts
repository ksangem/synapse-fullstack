/**
 * SharePointToDbRowStep — ITransformStep that reshapes a SharePoint
 * envelope payload into a flat DB row shape based on field mappings.
 *
 * Input envelope payload: { spItemId, event, fields: { Title: "X", ... } }
 * Output envelope payload: { sp_item_id: "42", title: "X", owner_email: "a@b.com", ... }
 */

import type { MessageEnvelope, ITransformStep, JsonValue } from '../../hub/interfaces';
import { createEnvelope } from '../../hub/envelope';
import type { DbColumnMapping } from './types';

export class SharePointToDbRowStep implements ITransformStep {
  readonly stepId: string;

  constructor(
    stepId: string,
    private readonly fieldMap: DbColumnMapping[],
    private readonly naturalKeyColumn: string,
  ) {
    this.stepId = stepId;
  }

  async execute(
    envelope: MessageEnvelope,
    _signal: AbortSignal,
  ): Promise<MessageEnvelope> {
    const payload = envelope.payload as Record<string, JsonValue>;
    const spItemId = payload.spItemId as string;
    const fields = payload.fields as Record<string, JsonValue>;
    const event = payload.event as string;

    if (!spItemId) {
      throw new Error('SharePointToDbRowStep: payload missing spItemId');
    }

    // Build the flat row from field mappings
    const row: Record<string, JsonValue> = {
      [this.naturalKeyColumn]: spItemId,
    };

    for (const mapping of this.fieldMap) {
      const sourceValue = resolveFieldPath(fields, mapping.from);
      row[mapping.to] = coerceValue(sourceValue, mapping.type);
    }

    // Return a new envelope with the row as payload
    return createEnvelope({
      topic: envelope.topic,
      sourceConnectorId: envelope.sourceConnectorId,
      orgId: envelope.orgId,
      sequenceNo: envelope.sequenceNo,
      correlationId: envelope.correlationId,
      payload: {
        row,
        event,
        naturalKeyColumn: this.naturalKeyColumn,
        naturalKeyValue: spItemId,
      },
      headers: envelope.headers ? { ...envelope.headers } : undefined,
    });
  }
}

/**
 * Resolve a dot-notated field path from a nested object.
 * e.g., "Owner.email" resolves fields.Owner.email
 */
function resolveFieldPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return null;
    if (typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }

  return current ?? null;
}

/**
 * Coerce a value to the target column type.
 */
function coerceValue(value: unknown, type: string): JsonValue {
  if (value === null || value === undefined) return null;

  switch (type) {
    case 'string':
      if (typeof value === 'object') {
        // Person → displayName, Lookup → value
        const obj = value as Record<string, unknown>;
        return (obj.displayName ?? obj.value ?? JSON.stringify(value)) as string;
      }
      return String(value);

    case 'number':
      return typeof value === 'number' ? value : Number(value);

    case 'boolean':
      return typeof value === 'boolean' ? value : Boolean(value);

    case 'datetime':
      if (typeof value === 'string') return value;
      return String(value);

    case 'json':
      if (typeof value === 'object') return value as JsonValue;
      return value as JsonValue;

    default:
      return value as JsonValue;
  }
}
