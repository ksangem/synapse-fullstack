/**
 * FieldMappingStep — the one, connector-agnostic transform.
 *
 * Reshapes a source record (the envelope payload) into a destination row using a
 * declarative list of field mappings, with dotted source paths
 * (e.g. "fields.status.name") and per-target type coercion. It replaces every
 * connector-specific transform: any source that emits its record as the payload
 * can be mapped by this one step.
 *
 * Output envelope: payload = the mapped row; headers carry the change event, the
 * natural-key column + its value, and (optionally) the destination table — so the
 * destination needs no source knowledge.
 */

import type { MessageEnvelope, ITransformStep, JsonValue } from './interfaces';
import { createEnvelope } from './envelope';
import { H } from './envelope-meta';

export interface FieldMapping {
  /** Dotted path into the source record. */
  from: string;
  /** Target column / field name. */
  to: string;
  /** Optional coercion: string | number | boolean | datetime | json. */
  type?: string;
}

export interface FieldMappingOptions {
  stepId: string;
  mappings: FieldMapping[];
  /** Target column that holds the natural (dedup/upsert) key. */
  naturalKeyColumn: string;
  /** Optional explicit destination table to stamp on the envelope. */
  destTable?: string;
}

export class FieldMappingStep implements ITransformStep {
  readonly stepId: string;
  private readonly mappings: FieldMapping[];
  private readonly naturalKeyColumn: string;
  private readonly destTable?: string;

  constructor(opts: FieldMappingOptions) {
    this.stepId = opts.stepId;
    this.mappings = opts.mappings;
    this.naturalKeyColumn = opts.naturalKeyColumn;
    this.destTable = opts.destTable;
  }

  async execute(envelope: MessageEnvelope, _signal: AbortSignal): Promise<MessageEnvelope> {
    const record = (envelope.payload ?? {}) as Record<string, JsonValue>;

    const row: Record<string, JsonValue> = {};
    for (const m of this.mappings) {
      row[m.to] = coerce(resolvePath(record, m.from), m.type);
    }

    const naturalKeyValue = row[this.naturalKeyColumn];
    const headers: Record<string, string> = {
      ...(envelope.headers ?? {}),
      [H.NATURAL_KEY_COLUMN]: this.naturalKeyColumn,
      [H.NATURAL_KEY]: naturalKeyValue == null ? '' : String(naturalKeyValue),
    };
    if (this.destTable) headers[H.DEST_TABLE] = this.destTable;

    return createEnvelope({
      topic: envelope.topic,
      sourceConnectorId: envelope.sourceConnectorId,
      orgId: envelope.orgId,
      sequenceNo: envelope.sequenceNo,
      correlationId: envelope.correlationId,
      payload: row as JsonValue,
      headers,
    });
  }
}

/** Resolve a dotted path ("a.b.c") from a nested record; null if any hop is missing. */
function resolvePath(record: Record<string, unknown>, path: string): unknown {
  let cur: unknown = record;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur ?? null;
}

/** Coerce a value to a target type; objects collapse to a readable scalar or JSON. */
function coerce(value: unknown, type?: string): JsonValue {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return typeof value === 'boolean' ? value : /^(true|yes|1|✓|done|closed)$/i.test(String(value));
    case 'json':
      return value as JsonValue;
    case 'string':
    case 'datetime':
    default:
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const o = value as Record<string, unknown>;
        return (o.displayName ?? o.value ?? o.name ?? o.email ?? JSON.stringify(value)) as JsonValue;
      }
      return type === undefined && typeof value !== 'object' ? (value as JsonValue) : String(value);
  }
}
