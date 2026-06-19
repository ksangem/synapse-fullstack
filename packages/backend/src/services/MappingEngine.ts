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
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
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

/** Apply a built-in preset transform to a value (legacy). */
function runPreset(preset: string, value: unknown, config?: Record<string, unknown>): unknown {
  if (value === null || value === undefined) return null;
  switch (preset) {
    case 'dateFormat': return typeof value === 'string' ? value.substring(0, 10) : String(value);
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
 * Compute one mapping's output value for a record — a faithful port of the Wizard's
 * computeMappedValue (DIRECT, the 16 presets incl. row-local aggregations, EXPRESSION).
 */
function computeValue(m: MappingEntry, record: Record<string, unknown>): unknown {
  const srcVal = (m.sources || []).map((s) => extractScalar(getNestedValue(record, s)));

  if (!m.transform || m.transform === 'DIRECT') return srcVal[0] ?? '';

  const nums = srcVal.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
  switch (m.preset) {
    case 'dateFormat': return String(srcVal[0] ?? '').substring(0, 10);
    case 'uppercase': return String(srcVal[0] ?? '').toUpperCase();
    case 'lowercase': return String(srcVal[0] ?? '').toLowerCase();
    case 'trim': return String(srcVal[0] ?? '').trim();
    case 'joinArray': return Array.isArray(srcVal[0]) ? (srcVal[0] as unknown[]).join(', ') : String(srcVal[0] ?? '');
    case 'extractNumber': { const mm = String(srcVal[0] ?? '').match(/[\d.]+/); return mm ? Number(mm[0]) : 0; }
    case 'toInt': return parseInt(String(srcVal[0]), 10) || 0;
    case 'toFloat': return Number(srcVal[0]) || 0;
    case 'toText': return String(srcVal[0] ?? '');
    case 'boolean': return !!srcVal[0] && srcVal[0] !== 'false' && srcVal[0] !== '0';
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'min': return nums.length ? Math.min(...nums) : 0;
    case 'max': return nums.length ? Math.max(...nums) : 0;
    case 'count': return srcVal.filter((v) => v !== null && v !== undefined && v !== '').length;
    case 'concat': return srcVal.map((v) => v ?? '').join(' ');
    default: break;
  }

  if (m.transform === 'EXPRESSION' && m.expression) {
    // Custom JS runs in the quickjs WASM sandbox (no Node globals, memory + time
    // limited) — the bus path is safe to run user expressions server-side.
    const source: Record<string, unknown> = {};
    (m.sources || []).forEach((s, i) => { source[s] = srcVal[i]; });
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
