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

/**
 * One foreign-key resolution, derived from a `preset: 'lookup'` mapping and handed
 * to the DB destination (which owns the connection the mapping step lacks).
 *
 * The child source carries the parent's business NAME (e.g. `ClientName`), never the
 * parent's surrogate id, so an insert into the child table failed its FK constraint.
 */
export interface FkLookup {
  /** Destination column holding the FK (e.g. `account_id`). */
  column: string;
  /** Parent table to resolve against (e.g. `accounts`). */
  parentTable: string;
  /** Parent text column matched against the child's value (e.g. `name`). */
  matchColumn: string;
  /** Parent column returned as the FK value (e.g. `id`). */
  returnColumn: string;
  /** Only 'error' today: an unresolvable parent fails that row rather than writing a bad FK. */
  onMissing?: 'error';
}

/** Derive the FK-lookup list for a target from its mappings. */
export function foreignKeysFromMappings(mappings: MappingEntry[]): FkLookup[] {
  const out: FkLookup[] = [];
  for (const m of mappings) {
    if (m.preset !== 'lookup') continue;
    const c = m.presetConfig ?? {};
    const column = m.destinations?.[0];
    const parentTable = c.parentTable as string | undefined;
    const matchColumn = c.matchColumn as string | undefined;
    const returnColumn = c.returnColumn as string | undefined;
    // A half-configured lookup would silently write the raw NAME into an integer FK
    // column, so an incomplete one is dropped here and the mapping behaves as a
    // pass-through — visible as a type error at write time, not a silent bad id.
    if (!column || !parentTable || !matchColumn || !returnColumn) {
      console.warn(`[MappingEngine] ignoring incomplete lookup mapping ${m.id}`);
      continue;
    }
    out.push({ column, parentTable, matchColumn, returnColumn, onMissing: 'error' });
  }
  return out;
}

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

// ── Legacy mapper — DEPRECATED, no production caller. ──
// As of the mapping-engine unification, NOTHING on a production path calls applyMappings:
// both the bus (run-integration) and SyncService now map via applyRichMappings below, so a
// Jira→SP integration maps identically however it is triggered. applyMappings / runPreset /
// validateMappingConfig / MappingConfig are retained ONLY because e2e-mapping-push.test.ts
// still locks their legacy behaviour. Deleting them (and those tests) is a safe follow-up
// once the SyncService rich-mapping switch is verified against real Jira→SP data.

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

/**
 * @deprecated DEAD on every production path — SyncService was migrated to applyRichMappings
 * (the same engine the bus uses) so a Jira→SP connection maps identically however it is
 * triggered. Retained only for its own test suite; the old "used by SyncService's direct
 * Jira→SharePoint path" note above was stale. Safe to delete with those tests.
 */
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
 * Parse a date written in a known day/month/year order into ISO `YYYY-MM-DD`.
 * Additive helper for the `parseDate` preset — unlike `dateFormat` (which assumes the
 * source is already ISO and just slices 10 chars), this understands dd/MM/yyyy and
 * friends, and returns null for impossible dates (e.g. 30/02/2026) instead of a
 * silently-rolled-over value. `format` names the token order, e.g. 'dd/MM/yyyy'.
 */
export function parseDateWithFormat(input: string, format = 'dd/MM/yyyy'): string | null {
  const parts = String(input).split(/[^0-9]+/).filter(Boolean).map(Number);
  const tokens = String(format).split(/[^a-zA-Z]+/).filter(Boolean);
  if (parts.length < 3 || tokens.length < 3) return null;
  let day = 0, month = 0, year = 0;
  for (let i = 0; i < 3; i++) {
    const t = tokens[i].toLowerCase();
    if (t.startsWith('d')) day = parts[i];
    else if (t.startsWith('m')) month = parts[i];
    else if (t.startsWith('y')) year = parts[i];
  }
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  // Reject calendar rollover (JS Date would turn 30 Feb into 2 Mar).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
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

    // ── QC-safe additive presets (no bus/config changes; used only when a mapping opts in) ──
    // codeMap: lookup source value in a table; unmapped codes fall back to a default ('Unknown').
    // presetConfig: { map: { A: 'Active', ... }, default?: 'Unknown' }
    case 'codeMap': {
      const map = (m.presetConfig?.map as Record<string, unknown>) || {};
      const key = String(srcVal[0] ?? '');
      const fallback = (m.presetConfig?.default as unknown) ?? 'Unknown';
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
    }
    // default: substitute a configured value when the source is null/empty (not written as null).
    // presetConfig: { value: <any> }
    case 'default': {
      const v = srcVal[0];
      const empty = v === null || v === undefined || v === '';
      return empty ? ((m.presetConfig?.value as unknown) ?? '') : v;
    }
    // currency: multiply a numeric amount by a configured exchange rate, rounded to N decimals.
    // presetConfig: { rate: 83.2, decimals?: 2 }
    case 'currency': {
      const n = Number(srcVal[0]);
      if (!Number.isFinite(n)) return null;
      const rate = Number(m.presetConfig?.rate ?? 1);
      const decimals = Number(m.presetConfig?.decimals ?? 2);
      return Number((n * rate).toFixed(decimals));
    }
    // divide: safe ratio of two sources with division-by-zero handled (returns null, never NaN/Infinity).
    // sources: [numerator, denominator]; presetConfig: { multiplier?: 100 (for %), decimals?: 2 }
    case 'divide': {
      const num = Number(srcVal[0]);
      const den = Number(srcVal[1]);
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
      const multiplier = Number(m.presetConfig?.multiplier ?? 1);
      const decimals = Number(m.presetConfig?.decimals ?? 2);
      return Number(((num / den) * multiplier).toFixed(decimals));
    }
    // parseDate: parse a non-ISO date (e.g. dd/MM/yyyy) into ISO YYYY-MM-DD; invalid dates -> null.
    // presetConfig: { format?: 'dd/MM/yyyy' }
    case 'parseDate':
      return parseDateWithFormat(String(srcVal[0] ?? ''), String(m.presetConfig?.format ?? 'dd/MM/yyyy'));

    /* lookup (foreign key): PASS THROUGH here, resolved later in the DB destination.
       The mapping step has no DB connection, so it cannot query the parent table;
       the destination owns the connection and does the resolve with a cached parent
       map. The payload column therefore carries the parent's NAME at this point and
       is swapped for the parent's id before the write.
       presetConfig: { parentTable, matchColumn, returnColumn, onMissing } */
    case 'lookup': return srcVal[0];

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
