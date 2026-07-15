/**
 * MappingEngine — applies user-defined field mappings at push/sync time.
 *
 * Mappings are stored as JSON in integrations.fieldMappings and evaluated
 * on the fly per Jira issue. No intermediate tables are created.
 *
 * Three transform modes:
 * - DIRECT: copy source value to destination as-is
 * - PRESET: apply a built-in transform function (joinArray, dateFormat, etc.)
 * - EXPRESSION: evaluate a user-written JS expression via new Function()
 */

import { evalExpression } from './SafeExpression';
import { aggregate } from './aggregate';

export interface MappingEntry {
  id: string;
  sources: string[];          // e.g. ['key'] or ['priority.name', 'summary']
  destinations: string[];     // e.g. ['IssueKey'] or ['CreatedDate', 'CycleTimeDays']
  srcTypes: string[];
  destTypes: string[];
  transform: 'DIRECT' | 'PRESET' | 'EXPRESSION';
  preset: string | null;      // e.g. 'joinArray', 'dateFormat'
  presetConfig?: Record<string, unknown>;
  expression: string;         // JS code: return source['key'];
  /**
   * Multi-target routing (fan-out). When present, this is AUTHORITATIVE: the computed
   * value is delivered to each {targetId, column} pair, letting one source field be split
   * across several destination targets (and different columns per target). When absent,
   * `destinations` is used against the single (legacy) target — i.e. today's behaviour.
   */
  routes?: { targetId: string; column: string }[];
}

export interface MappingConfig {
  entity: string;             // e.g. 'issues'
  projectKey?: string;
  mappings: MappingEntry[];
}

/**
 * Resolve a dot-path like "status.name" against a Jira issue object.
 * Tries both flat (issue.fields['status.name']) and nested (issue.fields.status.name).
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  // For issue-level fields like 'key', 'id'
  if (path === 'key' || path === 'id') return obj[path];

  const fields = (obj.fields ?? obj) as Record<string, unknown>;

  // Try flat key first (for fields like 'customfield_10016')
  if (path in fields) return fields[path];

  // Try dot-notation traversal
  const parts = path.split('.');
  let current: unknown = fields;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

// ── Legacy mapper (used by SyncService) — DO NOT change its behaviour. ──

/**
 * Normalize a year / partial date / full ISO datetime into a SQL DATE string
 * "YYYY-MM-DD". A bare year "2026" → "2026-01-01"; "2026-05" → "2026-05-01"; a
 * full date or ISO datetime → its date portion. Unparseable values (e.g. "AM
 * Ignored") → null, so a strict DATE column stores NULL instead of failing the row.
 */
export function toSqlDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const m = String(value).trim().match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return null;
  const mo = (m[2] ?? '1').padStart(2, '0');
  const d = (m[3] ?? '1').padStart(2, '0');
  return `${m[1]}-${mo}-${d}`;
}

/** Apply a built-in preset transform to a value (legacy). */
function runPreset(preset: string, value: unknown, config?: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  switch (preset) {
    case 'dateFormat': return typeof value === 'string' ? value.substring(0, 10) : String(value);
    case 'toDate': return toSqlDate(value);
    case 'uppercase': return String(value).toUpperCase();
    case 'lowercase': return String(value).toLowerCase();
    case 'trim': return String(value).trim();
    case 'joinArray': { const sep = (config?.separator as string) ?? ', '; return Array.isArray(value) ? value.join(sep) : String(value); }
    case 'extractNumber': { const match = String(value).match(/[\d.]+/); return match ? Number(match[0]) : null; }
    case 'boolean': return Boolean(value);
    default: return value;
  }
}

/** Legacy applyMappings — used by SyncService's direct Jira→SharePoint path. */
export function applyMappings(
  jiraIssue: Record<string, unknown>,
  mappingConfig: MappingConfig,
): Record<string, unknown> {
  const spFields: Record<string, unknown> = {};
  for (const mapping of mappingConfig.mappings) {
    if (mapping.sources.length === 0 || mapping.destinations.length === 0) continue;
    const source: Record<string, unknown> = {};
    for (const srcField of mapping.sources) source[srcField] = getNestedValue(jiraIssue, srcField);

    let result: unknown;
    if (mapping.transform === 'DIRECT') result = source[mapping.sources[0]];
    else if (mapping.transform === 'PRESET') result = runPreset(mapping.preset ?? '', source[mapping.sources[0]], mapping.presetConfig);
    else if (mapping.transform === 'EXPRESSION') {
      try { result = new Function('source', mapping.expression)(source); }
      catch (err) { console.error(`[MappingEngine] Expression error for mapping ${mapping.id}: ${err}`); result = null; }
    }

    if (mapping.destinations.length === 1) spFields[mapping.destinations[0]] = result;
    else if (result && typeof result === 'object' && !Array.isArray(result)) Object.assign(spFields, result);
    else for (const dest of mapping.destinations) spFields[dest] = result;
  }
  return spFields;
}

// ── Wizard-faithful mapper (used by the bus) — matches WizardPage.computeMappedValue. ──

/**
 * Collapse a raw source value to a scalar the way the Wizard does client-side:
 * objects → .name / .displayName; arrays → their items' name/displayName joined.
 */
function extractScalar(raw: unknown): unknown {
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(raw)) {
      return raw
        .map((x) => (x && typeof x === 'object' ? ((x as Record<string, unknown>).name ?? (x as Record<string, unknown>).displayName ?? x) : x))
        .join(', ');
    }
    if (o.name) return o.name;
    if (o.displayName) return o.displayName;
  }
  return raw ?? '';
}

/**
 * Set a dotted path ("a.b.c") to `value` on `obj`, creating intermediate objects. Used so an
 * EXPRESSION can read a dotted source (e.g. "@join.alias.col") as source['a']['b']['c'] in
 * addition to the flat source['a.b.c'] key. Skips a hop if it already holds a non-object.
 */
function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Compute one mapping's output value for a record — a faithful port of the Wizard's
 * computeMappedValue (DIRECT, the 16 presets incl. row-local aggregations, EXPRESSION).
 */
function computeValue(m: MappingEntry, record: Record<string, unknown>): unknown {
  // rawVal keeps the source value's real shape (objects/arrays) for EXPRESSION formulas;
  // srcVal is the flattened scalar used by DIRECT and the presets.
  const rawVal = (m.sources || []).map((s) => getNestedValue(record, s));
  const srcVal = rawVal.map((v) => extractScalar(v));

  if (!m.transform || m.transform === 'DIRECT') return srcVal[0] ?? '';

  switch (m.preset) {
    case 'dateFormat': return String(srcVal[0] ?? '').substring(0, 10);
    case 'toDate': return toSqlDate(srcVal[0]);
    case 'uppercase': return String(srcVal[0] ?? '').toUpperCase();
    case 'lowercase': return String(srcVal[0] ?? '').toLowerCase();
    case 'trim': return String(srcVal[0] ?? '').trim();
    case 'joinArray': return Array.isArray(srcVal[0]) ? (srcVal[0] as unknown[]).join(', ') : String(srcVal[0] ?? '');
    case 'extractNumber': { const mm = String(srcVal[0] ?? '').match(/[\d.]+/); return mm ? Number(mm[0]) : 0; }
    case 'toInt': return parseInt(String(srcVal[0]), 10) || 0;
    case 'toFloat': return Number(srcVal[0]) || 0;
    case 'toText': return String(srcVal[0] ?? '');
    case 'boolean': return !!srcVal[0] && srcVal[0] !== 'false' && srcVal[0] !== '0';
    // Group aggregations delegate to the shared helper — single source of truth with the join
    // step (services/aggregate). Empty/missing values are dropped so an absent field never reads
    // as 0 and drags an average toward zero; a genuine 0 is kept.
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
    case 'count':
      return aggregate(m.preset, srcVal);
    // `concat` here is ROW-LOCAL field concatenation (space-joined, empties kept) — deliberately
    // distinct from the join's group `concat` (comma-joined), so it stays inline.
    case 'concat': return srcVal.map((v) => v ?? '').join(' ');
    default: break;
  }

  if (m.transform === 'EXPRESSION' && m.expression) {
    // Custom JS runs in the quickjs WASM sandbox (no Node globals, memory + time
    // limited) — the bus path is safe to run user expressions server-side.
    // Pass the RAW source values so a formula written against the real shape works:
    // e.g. source['status'].name or source['labels'].map(...). Previously this handed
    // over the pre-flattened scalar, so such formulas errored ("x is not a function")
    // or returned nothing — leaving the destination column empty.
    const source: Record<string, unknown> = {};
    (m.sources || []).forEach((s, i) => {
      source[s] = rawVal[i]; // flat key: source['@join.alias.col'] / source['status.name']
      // Also expose a NESTED view so an expression written as source['@join']['alias']['col']
      // resolves — the Wizard auto-generates dotted source paths as nested optional chains.
      if (s.includes('.')) setNestedPath(source, s, rawVal[i]);
    });
    try {
      return evalExpression(m.expression, source);
    } catch (err) {
      console.error(`[MappingEngine] Expression error for mapping ${m.id}: ${err}`);
      return null;
    }
  }

  return srcVal.join(', ');
}

/**
 * Apply Wizard-shaped mappings to one source record → a flat destination row.
 * Mirrors WizardPage.mapRecordsToDest exactly (extraction, 16 presets, one-to-many),
 * so a server-side run/preview equals what the Wizard showed. Used by the bus path
 * (FieldMappingStep + preview) — separate from the legacy applyMappings above.
 */
export function applyRichMappings(
  record: Record<string, unknown>,
  mappings: MappingEntry[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const m of mappings) {
    if (!m.sources?.length || !m.destinations?.length) continue;

    let val: unknown;
    try { val = computeValue(m, record); } catch { val = ''; }

    const dests = m.destinations;
    if (dests.length > 1 && val && typeof val === 'object' && !Array.isArray(val)) {
      // EXPRESSION returned { ColA: v1, ColB: v2 } → spread across destinations.
      for (const d of dests) out[d] = (val as Record<string, unknown>)[d];
    } else {
      out[dests[0]] = val;
    }
  }

  return out;
}

/**
 * Target-aware variant of applyRichMappings — used for multi-destination fan-out PREVIEW
 * (and as a testable model of the per-target split). For one source record it produces a
 * SEPARATE row per target, containing only the columns that each target's `routes` ask for.
 *
 * Routing rules per mapping (value computed ONCE via computeValue):
 *   - `routes` present → deliver the value to each {targetId, column} in routes.
 *   - `routes` absent  → legacy: deliver to `destinations` against `legacyTargetId`
 *     (so an un-migrated mapping still previews under the single synthesized target).
 * The EXPRESSION-returns-object spread (a formula returning { ColA: v1, ColB: v2 }) is
 * honored per target: a column is filled from the object's matching key when present.
 *
 * Returns Map<targetId, row>; every id in `targetIds` gets an entry (possibly empty).
 */
export function applyRichMappingsByTarget(
  record: Record<string, unknown>,
  mappings: MappingEntry[],
  targetIds: string[],
  legacyTargetId = 'legacy',
): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const id of targetIds) out.set(id, {});

  const place = (targetId: string, column: string, value: unknown) => {
    const row = out.get(targetId);
    if (row) row[column] = value;
  };

  for (const m of mappings) {
    if (!m.sources?.length) continue;

    let val: unknown;
    try { val = computeValue(m, record); } catch { val = ''; }
    const isObj = val != null && typeof val === 'object' && !Array.isArray(val);

    const routes = m.routes?.length
      ? m.routes
      : (m.destinations ?? []).map((column) => ({ targetId: legacyTargetId, column }));

    // Mirror applyRichMappings: spread an EXPRESSION-returned object across columns ONLY
    // when there is more than one destination column; a single column receives the whole
    // value (object included). This keeps single-target preview identical to the run.
    const spread = routes.length > 1 && isObj;
    for (const r of routes) {
      const v = spread ? (val as Record<string, unknown>)[r.column] : val;
      place(r.targetId, r.column, v);
    }
  }

  return out;
}

/**
 * Check if a mapping config is valid.
 */
export function validateMappingConfig(config: MappingConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!config.mappings || config.mappings.length === 0) {
    errors.push('No mappings defined');
  }
  for (const m of config.mappings) {
    if (m.sources.length === 0) errors.push(`Mapping ${m.id}: no source fields`);
    if (m.destinations.length === 0) errors.push(`Mapping ${m.id}: no destination fields`);
    if (m.transform === 'EXPRESSION' && !m.expression.trim()) {
      errors.push(`Mapping ${m.id}: empty expression`);
    }
    if (m.transform === 'PRESET' && !m.preset) {
      errors.push(`Mapping ${m.id}: no preset selected`);
    }
  }
  return { valid: errors.length === 0, errors };
}
