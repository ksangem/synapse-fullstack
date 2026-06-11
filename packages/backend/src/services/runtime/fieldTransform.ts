/**
 * fieldTransform — the entity-model / field-rule layer for the crawler (Phase 1).
 *
 * After the CrawlEngine / StepReplayer pull raw text off the page (via CSS
 * selectors run in the browser), this turns each raw value into a clean, typed
 * field, entirely in Node:
 *
 *     raw text → (optional regex extract) → (optional type coercion) → value
 *
 * Pure, no I/O — so it's fully unit-testable and shared by both the engine and
 * the step-replayer. Invalid regex never throws (the raw value is kept); a value
 * that the regex can't find becomes empty (so `required`/typing see it as missing).
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'datetime' | 'json';

export interface FieldRule {
  /** output key, e.g. "story_points". */
  name: string;
  /** CSS selector; may list `||` fallbacks (first that yields a value wins). */
  selector: string;
  /** read this attribute instead of the element text, e.g. "href". */
  attr?: string | null;
  /** Phase-2 (script-json source): JSON path to this field within each item,
   *  e.g. "fields.summary" or "fields.customfield_10016". Defaults to `name`. */
  path?: string;
  /** optional: extract a substring from the captured value. */
  regex?: string;
  /** regex flags, e.g. "i". A `g` flag is ignored — we always take the first match. */
  regexFlags?: string;
  /** capture group to keep. Default: 1 if the pattern has groups, else 0 (whole match). */
  regexGroup?: number;
  /** canonical type for the extracted value (the entity model). */
  type?: FieldType;
  /** Phase 1: flag-only — empty required fields are reported in `missing`, not dropped. */
  required?: boolean;
}

// One warning per bad pattern, so a misconfigured recipe doesn't spam the logs.
const warnedPatterns = new Set<string>();

/**
 * Apply a field's regex to a raw string and return the chosen capture group.
 * Invalid pattern → the raw value is returned unchanged. No match → empty string.
 */
export function applyRegex(raw: string, pattern: string, flags?: string, group?: number): string {
  let re: RegExp;
  try {
    // Strip any global flag so `.exec` deterministically returns the first match.
    re = new RegExp(pattern, (flags || '').replace(/g/g, ''));
  } catch {
    if (!warnedPatterns.has(pattern)) {
      console.warn(`[fieldTransform] invalid regex ignored: ${pattern}`);
      warnedPatterns.add(pattern);
    }
    return raw;
  }
  const m = re.exec(raw);
  if (!m) return '';
  const g = group != null ? group : (m.length > 1 ? 1 : 0);
  return m[g] != null ? m[g] : '';
}

/** Coerce a single raw string to a canonical type. Falls back to the raw string when coercion fails. */
export function coerceValue(raw: string, type: FieldType): unknown {
  switch (type) {
    case 'number': {
      const cleaned = String(raw).replace(/[^0-9.\-]/g, '');
      if (cleaned === '' || cleaned === '-' || cleaned === '.') return raw; // no digits → keep raw
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : raw;
    }
    case 'boolean':
      return /^(true|yes|1|✓|on|done|closed|complete)/i.test(String(raw).trim());
    case 'datetime': {
      const d = new Date(String(raw));
      return Number.isNaN(d.getTime()) ? raw : d.toISOString();
    }
    case 'json':
      try { return JSON.parse(String(raw)); } catch { return raw; }
    default:
      return raw;
  }
}

/**
 * Apply a list of field rules to one raw record (field-name → raw string).
 * Returns the typed record plus the names of any required fields that came up empty.
 * Keys present on the raw record but not covered by a rule are passed through untouched
 * (e.g. the `url`/`title` the extractor injects).
 */
export function applyFieldRules(
  raw: Record<string, string | null>,
  rules: FieldRule[],
): { record: Record<string, unknown>; missing: string[] } {
  const record: Record<string, unknown> = {};
  const missing: string[] = [];
  const ruled = new Set(rules.map((r) => r.name));
  for (const [k, v] of Object.entries(raw)) if (!ruled.has(k)) record[k] = v;

  for (const rule of rules) {
    let val = raw[rule.name] == null ? '' : String(raw[rule.name]);
    if (rule.regex) val = applyRegex(val, rule.regex, rule.regexFlags, rule.regexGroup);
    const empty = val === '';
    if (rule.required && empty) missing.push(rule.name);
    if (empty) { record[rule.name] = rule.type === 'number' ? null : ''; continue; }
    record[rule.name] = rule.type ? coerceValue(val, rule.type) : val;
  }
  return { record, missing };
}

/**
 * Legacy coercion: apply `{ field → type }` to a record (the pre-Phase-1 path).
 * Preserved verbatim so old `selectors`-only recipes behave exactly as before —
 * a value that fails to coerce keeps its raw string.
 */
export function coerceTypes(
  rec: Record<string, string | null>,
  types: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rec };
  for (const [name, t] of Object.entries(types)) {
    const raw = rec[name];
    if (raw == null || raw === '') continue;
    if (t === 'number') {
      const n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(n)) out[name] = n;
    } else if (t === 'boolean') {
      out[name] = /^(true|yes|1|✓|on|done|closed|complete)/i.test(String(raw).trim());
    } else if (t === 'datetime') {
      const d = new Date(String(raw));
      if (!Number.isNaN(d.getTime())) out[name] = d.toISOString();
    } else if (t === 'json') {
      try { out[name] = JSON.parse(String(raw)); } catch { /* leave as string */ }
    }
  }
  return out;
}
