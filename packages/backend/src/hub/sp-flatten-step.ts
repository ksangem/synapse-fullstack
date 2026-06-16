/**
 * SpFlattenStep — ITransformStep that turns a SharePoint source envelope into a
 * flat DB row the generic DbDestinationConnector can write.
 *
 * Input payload  : { spItemId, event, fields: { Title, Owner:{displayName}, ... } }
 * Output payload : { sp_item_id, is_deleted, title, owner, ... }  (flat row)
 *
 * `event` is folded into the `is_deleted` soft-delete flag, so created/updated/
 * deleted all flow through one upsert path keyed on sp_item_id (matching the
 * is_deleted convention DbSchemaDiffCalculator already seeds for SP→DB).
 *
 * Self-contained (identity flatten — no pre-declared field map needed), so it
 * works against any list. A configured mapping can replace it later.
 */

import type { MessageEnvelope, ITransformStep, JsonValue } from './interfaces';
import { createEnvelope } from './envelope';

export const SP_FLATTEN_STEP_ID = 'sp-flatten';

export class SpFlattenStep implements ITransformStep {
  readonly stepId: string;

  constructor(stepId: string = SP_FLATTEN_STEP_ID) {
    this.stepId = stepId;
  }

  async execute(envelope: MessageEnvelope, _signal: AbortSignal): Promise<MessageEnvelope> {
    const p = (envelope.payload ?? {}) as {
      spItemId?: JsonValue;
      event?: JsonValue;
      fields?: Record<string, JsonValue>;
    };
    const spItemId = String(p.spItemId ?? '');
    if (!spItemId) throw new Error('SpFlattenStep: payload missing spItemId');

    const row: Record<string, JsonValue> = {
      sp_item_id: spItemId,
      is_deleted: p.event === 'deleted',
    };
    for (const [k, v] of Object.entries(p.fields ?? {})) {
      const col = sanitizeCol(k);
      if (col === 'sp_item_id' || col === 'is_deleted') continue; // don't clobber
      row[col] = flattenValue(v);
    }

    return createEnvelope({
      topic: envelope.topic,
      sourceConnectorId: envelope.sourceConnectorId,
      orgId: envelope.orgId,
      sequenceNo: envelope.sequenceNo,
      correlationId: envelope.correlationId,
      payload: row as JsonValue,
    });
  }
}

/** SP field name → safe lowercase snake_case column. */
function sanitizeCol(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'col';
}

/** Person/lookup objects → a readable scalar; arrays/objects → JSON. */
function flattenValue(v: JsonValue): JsonValue {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, JsonValue>;
    return (o.displayName ?? o.value ?? o.Title ?? o.email ?? JSON.stringify(v)) as JsonValue;
  }
  return v;
}
