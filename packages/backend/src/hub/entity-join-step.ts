/**
 * EntityJoinStep — connector-agnostic cross-entity enrichment.
 *
 * Runs BEFORE FieldMappingStep. For each configured join it resolves a local key
 * from the record, looks that key up in the joined entity's INDEX (supplied by an
 * injected EntityIndexProvider), and stamps the pulled / aggregated values onto the
 * record under a flat, dotted namespace key: `@join.<alias>.<as>`.
 *
 * The existing dot-path resolver (MappingEngine.getNestedValue) checks a FLAT key
 * before nested traversal, so a mapping whose source is `@join.client.region` reads
 * the stamped value with ZERO engine change — the mapping engine stays row-local and
 * simply happens to see extra fields.
 *
 * ── The architecture boundary (why this respects "no bus hardwiring") ──
 * This step is a pure ITransformStep. It imports NOTHING connector-specific: no
 * buildSource, no DB writer, no Graph client. Its only dependency is the generic
 * `EntityIndexProvider` port, injected at construction by the wiring layer
 * (integration-flow.ts). The bus core still runs it exactly like FieldMappingStep —
 * the channel never learns the word "join". Swap in a fake provider and the whole
 * step is unit-testable with zero infrastructure.
 *
 * Purely additive: wired only when a connection carries `fieldMappings.joins`, so
 * every existing flow is byte-for-byte unchanged.
 */

import type { MessageEnvelope, ITransformStep, JsonValue } from './interfaces';
import { createEnvelope } from './envelope';
import { getNestedValue } from '../services/MappingEngine';
import { aggregate, type AggFn } from '../services/aggregate';

// Re-exported so existing importers keep a stable surface; the implementation is shared.
export { aggregate };
export type { AggFn };

/** Flat-key namespace under which joined columns are stamped. */
export const JOIN_NS = '@join';
/** Build the flat record key for a joined value: `@join.<alias>.<as>`. */
export function joinFieldKey(alias: string, as: string): string {
  return `${JOIN_NS}.${alias}.${as}`;
}

export type JoinOp = 'eq' | 'ci-eq';

/** Bring a column of the joined row back under `@join.<alias>.<as>`. */
export interface JoinPull {
  column: string; // column on the joined entity (dot-path allowed)
  as: string;     // name under @join.<alias>.<as>
}

/** Aggregate a column across the matched (one-to-many) joined rows. */
export interface JoinAggregate {
  as: string;
  fn: AggFn;
  column?: string; // required for every fn except 'count'
}

/** Where the joined entity comes from — resolved by the provider, NOT this step. */
export interface JoinEntityRef {
  side: 'source' | 'dest';
  connectionId?: string;
  ref: string;       // list / table / entity name
  keyColumn: string; // column matched against on.localField
}

export interface JoinSpec {
  alias: string;                          // namespace: @join.<alias>.*
  on: { localField: string; op?: JoinOp };
  entity: JoinEntityRef;
  pull?: JoinPull[];
  aggregate?: JoinAggregate[];
  onMissing?: 'null' | 'error';           // default 'null'
}

/**
 * A ready, keyed index over ONE joined entity. `lookup` returns the matched joined
 * row (object), an array of rows for one-to-many, or undefined for no match. The
 * index owns op-aware key normalization (it was built knowing the join's `op`), so
 * this step just hands it the raw stringified key.
 */
export interface EntityIndex {
  lookup(key: string): unknown;
}

/**
 * The ONE dependency of this step. The concrete implementation (which reads sources
 * via buildSource / destinations via DB writers, with a TTL cache) lives OUTSIDE the
 * bus, in the composition root. Here it is an opaque port.
 */
export interface EntityIndexProvider {
  getIndex(join: JoinSpec, signal: AbortSignal): Promise<EntityIndex>;
}

export interface EntityJoinOptions {
  stepId: string;
  joins: JoinSpec[];
  provider: EntityIndexProvider;
}

/**
 * Static validation for a join list — used at save-time and defensively here.
 * Enforces: unique aliases; pull/aggregate shape; and BACKWARD-ONLY chaining
 * (a join's localField may reference an `@join.X.*` output only if alias X was
 * defined by an EARLIER join). Because joins run in list order, backward-only
 * references are inherently acyclic.
 */
export function validateJoins(joins: JoinSpec[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < joins.length; i++) {
    const j = joins[i];
    if (!j.alias) { errors.push(`Join #${i + 1}: missing alias`); continue; }
    if (seen.has(j.alias)) errors.push(`Join "${j.alias}": duplicate alias`);
    if (!j.on?.localField) errors.push(`Join "${j.alias}": missing on.localField`);
    if (!j.entity?.ref || !j.entity?.keyColumn) errors.push(`Join "${j.alias}": entity.ref and entity.keyColumn are required`);
    if (!j.pull?.length && !j.aggregate?.length) errors.push(`Join "${j.alias}": needs at least one pull or aggregate`);
    for (const p of j.pull ?? []) if (!p.as || !p.column) errors.push(`Join "${j.alias}": each pull needs column + as`);
    for (const a of j.aggregate ?? []) {
      if (!a.as || !a.fn) errors.push(`Join "${j.alias}": each aggregate needs fn + as`);
      if (a.fn !== 'count' && !a.column) errors.push(`Join "${j.alias}": aggregate "${a.as}" (${a.fn}) needs a column`);
    }
    // Chain reference check: localField pointing at an @join alias must be an EARLIER one.
    const ref = j.on?.localField ?? '';
    if (ref.startsWith(`${JOIN_NS}.`)) {
      const referenced = ref.split('.')[1];
      if (referenced === j.alias) errors.push(`Join "${j.alias}": localField references its own output (cycle)`);
      else if (!seen.has(referenced)) errors.push(`Join "${j.alias}": localField references "${referenced}" which is not defined by an earlier join`);
    }
    seen.add(j.alias);
  }
  return errors;
}

export class EntityJoinStep implements ITransformStep {
  readonly stepId: string;
  private readonly joins: readonly JoinSpec[];
  private readonly provider: EntityIndexProvider;

  constructor(opts: EntityJoinOptions) {
    this.stepId = opts.stepId;
    this.joins = opts.joins;
    this.provider = opts.provider;
  }

  async execute(envelope: MessageEnvelope, signal: AbortSignal): Promise<MessageEnvelope> {
    const src = (envelope.payload ?? {}) as Record<string, JsonValue>;
    const row: Record<string, JsonValue> = { ...src };

    // Stamp into the SAME container getNestedValue reads from: `record.fields` when the
    // source record nests its fields (e.g. SharePoint items), else the record itself.
    // Cloned for immutability. Flat keys here are found by getNestedValue's flat-first branch.
    const hasFields = row.fields != null && typeof row.fields === 'object' && !Array.isArray(row.fields);
    const bag: Record<string, JsonValue> = hasFields ? { ...(row.fields as Record<string, JsonValue>) } : row;
    if (hasFields) row.fields = bag;

    for (const join of this.joins) {
      const onMissing = join.onMissing ?? 'null';
      // Read the local key through the SAME resolver mappings use — so a native field
      // and a chained `@join.a.x` (stamped by an earlier join into `bag`) both resolve.
      const keyRaw = getNestedValue(row, join.on.localField);

      const stampNulls = () => {
        for (const p of join.pull ?? []) bag[joinFieldKey(join.alias, p.as)] = null;
        // A missing key means zero related rows: aggregate over the empty set (count→0, sum→0…).
        for (const a of join.aggregate ?? []) bag[joinFieldKey(join.alias, a.as)] = aggregate(a.fn, []);
      };

      if (keyRaw === null || keyRaw === undefined || keyRaw === '') {
        if (onMissing === 'error') throw new Error(`Join "${join.alias}": local key "${join.on.localField}" is empty`);
        stampNulls();
        continue;
      }

      const index = await this.provider.getIndex(join, signal);
      const match = index.lookup(String(keyRaw));

      if (match === undefined || match === null) {
        if (onMissing === 'error') throw new Error(`Join "${join.alias}": no match where ${join.entity.ref}.${join.entity.keyColumn} = "${String(keyRaw)}"`);
        stampNulls();
        continue;
      }

      const rows = Array.isArray(match) ? match : [match];

      // pull: single-row semantics (first matched row).
      for (const p of join.pull ?? []) {
        const first = rows[0] as Record<string, unknown> | undefined;
        bag[joinFieldKey(join.alias, p.as)] = (first ? getNestedValue(first, p.column) : null) as JsonValue;
      }
      // aggregate: over all matched rows. `count` counts rows; others map the column.
      for (const a of join.aggregate ?? []) {
        const values = a.fn === 'count'
          ? rows
          : rows.map((r) => getNestedValue(r as Record<string, unknown>, a.column ?? ''));
        bag[joinFieldKey(join.alias, a.as)] = aggregate(a.fn, values);
      }
    }

    return createEnvelope({
      topic: envelope.topic,
      sourceConnectorId: envelope.sourceConnectorId,
      orgId: envelope.orgId,
      sequenceNo: envelope.sequenceNo,
      correlationId: envelope.correlationId,
      payload: row as JsonValue,
      headers: { ...(envelope.headers ?? {}) },
    });
  }
}
