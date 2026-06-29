/**
 * Integration targets — the single normalizer that turns an integration row into a list of
 * destination TARGETS, so the rest of the hub (flow builder, validate-recipe, run trigger,
 * preview) can treat single-destination and multi-destination (fan-out) integrations
 * uniformly.
 *
 * Canonical multi-target shape lives in `fieldMappings.targets[]` (see the design plan):
 *   targets: [{ targetId, label?, connectorId, naturalKeyColumn, config:{…factory keys…} }]
 * and each mapping routes its value via `MappingEntry.routes:[{targetId, column}]`.
 *
 * LEGACY (no `targets`): synthesize ONE target ('legacy') from the existing single-dest
 * fields, and treat every mapping's existing `destinations[]` as routing to that one target.
 * This keeps every pre-existing integration byte-identical — same wiring, topic, scope, and
 * delivery — with no data migration (fieldMappings is JSONB).
 */

import type { integrations } from '../db/schema';
import type { MappingEntry } from '../services/MappingEngine';

type Integration = typeof integrations.$inferSelect;

export const LEGACY_TARGET_ID = 'legacy';

export interface NormalizedTarget {
  /** Stable id used in mapping routes and to scope the per-target subscription/destination. */
  targetId: string;
  label?: string;
  /** Destination connector TEMPLATE id (registry kind source). */
  connectorId: string;
  /** Per-target config slice the destination factory reads (pgTable/listName/…). */
  config: Record<string, unknown>;
  /** Per-target dedup/merge key column. */
  naturalKeyColumn: string;
  /** Credentials reference for this target (resolved separately by the caller). */
  destCredId?: string;
  /** Resolved destination table name (DB targets) to stamp on the envelope. */
  destTable?: string;
}

export interface NormalizedTargets {
  legacy: boolean;
  targets: NormalizedTarget[];
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

/**
 * Resolve an integration to its destination targets. Always returns at least one target
 * for a wired integration; `legacy` is true when synthesized from the old single-dest shape.
 */
export function normalizeTargets(integration: Integration): NormalizedTargets {
  const fm = (integration.fieldMappings ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(fm.targets) ? (fm.targets as Record<string, unknown>[]) : null;

  if (raw && raw.length) {
    return {
      legacy: false,
      targets: raw.map((t, i) => {
        const config = (t.config ?? {}) as Record<string, unknown>;
        return {
          targetId: str(t.targetId) || `t${i + 1}`,
          label: t.label as string | undefined,
          connectorId: str(t.connectorId) || str(integration.destConnectorId),
          config,
          naturalKeyColumn: str(t.naturalKeyColumn) || str(fm.naturalKeyColumn),
          destCredId: (config.destCredId ?? fm.destCredId) as string | undefined,
          destTable: (config.pgTable ?? config.destTable) as string | undefined,
        };
      }),
    };
  }

  // Legacy single-dest synthesis — the whole fieldMappings object IS the target config
  // (the destination factory reads its own keys from it, exactly as today).
  return {
    legacy: true,
    targets: [
      {
        targetId: LEGACY_TARGET_ID,
        connectorId: str(integration.destConnectorId),
        config: fm,
        naturalKeyColumn: str(fm.naturalKeyColumn),
        destCredId: fm.destCredId as string | undefined,
        destTable: (fm.pgTable ?? fm.destTable) as string | undefined,
      },
    ],
  };
}

/**
 * The column(s) a mapping routes to a given target, as a fresh MappingEntry whose
 * `destinations` are exactly those columns — so the existing FieldMappingStep /
 * applyRichMappings produce that target's column SUBSET unchanged.
 *
 * - Multi-target (mapping has `routes`): pick routes for this target → their columns.
 * - Legacy (no `routes`): the whole `destinations[]` belongs to the single target.
 * Returns null when this mapping sends nothing to the target (so it is dropped from the
 * target's transform).
 */
export function mappingForTarget(m: MappingEntry, targetId: string, legacy: boolean): MappingEntry | null {
  if (legacy || !m.routes?.length) {
    // Legacy: every mapping routes its destinations to the sole synthesized target.
    return legacy ? m : null;
  }
  const cols = m.routes.filter((r) => r.targetId === targetId).map((r) => r.column);
  if (!cols.length) return null;
  return { ...m, destinations: cols };
}

/** All mappings (sliced to their per-target columns) that deliver to the given target. */
export function mappingsForTarget(mappings: MappingEntry[], targetId: string, legacy: boolean): MappingEntry[] {
  const out: MappingEntry[] = [];
  for (const m of mappings) {
    const sliced = mappingForTarget(m, targetId, legacy);
    if (sliced) out.push(sliced);
  }
  return out;
}
