/* Shared field-mapping logic — the single source of truth used by both the
   Connection Wizard (step 4) and the standalone Mapping Canvas. Pure functions,
   no React.

   PARITY CONTRACT: `computeMappedValue` mirrors the backend's
   MappingEngine.computeValue (services/MappingEngine.ts) case-for-case, and
   `aggregate` mirrors services/aggregate.ts. The backend is the real execution
   path — the Wizard pushes a mapping *recipe* and the bus maps server-side — so
   this function exists purely to preview what the backend will write. If you
   change a preset on either side, change it on both. */

/** Config schema per preset — drives the Wizard/Canvas config form and is stored
    on the mapping as `presetConfig`, which the backend reads. Presets absent from
    this table take no configuration. */
export const PRESET_CONFIG_SPEC = {
  codeMap: [
    { key: 'map', label: 'Code → Value', type: 'keyvalue', help: 'Each source code and what to write instead.' },
    { key: 'default', label: 'Fallback', type: 'text', default: 'Unknown', help: 'Used when a code is not in the table.' },
  ],
  default: [
    { key: 'value', label: 'Value when empty', type: 'text', help: 'Written when the source is null or blank.' },
  ],
  currency: [
    { key: 'rate', label: 'Exchange rate', type: 'number', default: 1, required: true, help: 'Amount is multiplied by this.' },
    { key: 'decimals', label: 'Decimal places', type: 'number', default: 2 },
  ],
  divide: [
    { key: 'multiplier', label: 'Multiply result by', type: 'number', default: 1, help: 'Use 100 to produce a percentage.' },
    { key: 'decimals', label: 'Decimal places', type: 'number', default: 2 },
  ],
  parseDate: [
    {
      key: 'format', label: 'Source date format', type: 'select', default: 'dd/MM/yyyy',
      options: ['dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy/MM/dd', 'dd-MM-yyyy', 'MM-dd-yyyy', 'yyyy-MM-dd', 'dd.MM.yyyy'],
      help: 'The order the day / month / year appear in the source.',
    },
  ],
  lookup: [
    { key: 'parentTable', label: 'Parent table', type: 'text', required: true, help: 'The table holding the real row, e.g. accounts.' },
    { key: 'matchColumn', label: 'Match on column', type: 'text', default: 'name', required: true, help: 'The parent text column your source value matches, e.g. name.' },
    { key: 'returnColumn', label: 'Write this column', type: 'text', default: 'id', required: true, help: "The parent column stored in the destination, e.g. id." },
  ],
};

export const PRESET_TRANSFORMS = [
  // Text (single source)
  { value: 'dateFormat', label: 'Date Format (YYYY-MM-DD)', desc: 'Extracts date portion', group: 'Text' },
  { value: 'toDate', label: 'Year/Partial → Date (YYYY-MM-DD)', desc: 'Year "2026" → 2026-01-01; junk → empty. For SQL date columns.', group: 'Text' },
  { value: 'uppercase', label: 'Uppercase', desc: 'Converts text to UPPER CASE', group: 'Text' },
  { value: 'lowercase', label: 'Lowercase', desc: 'Converts text to lower case', group: 'Text' },
  { value: 'trim', label: 'Trim Whitespace', desc: 'Removes leading/trailing spaces', group: 'Text' },
  { value: 'joinArray', label: 'Join Array → String', desc: 'Joins array items with comma', group: 'Text' },
  { value: 'extractNumber', label: 'Extract Number', desc: 'Extracts first number from text', group: 'Text' },
  // Type casts (single source)
  { value: 'toInt', label: 'Cast → Integer', desc: 'Parse the value as a whole number', group: 'Type casts' },
  { value: 'toFloat', label: 'Cast → Decimal', desc: 'Parse the value as a decimal number', group: 'Type casts' },
  { value: 'toText', label: 'Cast → Text', desc: 'Convert the value to a string', group: 'Type casts' },
  { value: 'boolean', label: 'Cast → Boolean', desc: 'Truthy check → true / false', group: 'Type casts' },
  // Aggregations (across ALL selected source fields, coerced to numbers)
  { value: 'sum', label: 'Σ Sum (all sources)', desc: 'Add all selected sources as numbers', group: 'Aggregations', minSources: 2 },
  { value: 'avg', label: 'Average / Mean (all sources)', desc: 'Mean of the selected number sources', group: 'Aggregations', minSources: 2 },
  { value: 'min', label: 'Min (all sources)', desc: 'Smallest of the source values', group: 'Aggregations', minSources: 2 },
  { value: 'max', label: 'Max (all sources)', desc: 'Largest of the source values', group: 'Aggregations', minSources: 2 },
  { value: 'count', label: 'Count (non-empty sources)', desc: 'How many sources have a value', group: 'Aggregations', minSources: 2 },
  { value: 'concat', label: 'Concatenate (all sources)', desc: 'Join all sources with a space', group: 'Aggregations', minSources: 2 },
  // Lookup & defaults
  { value: 'codeMap', label: 'Code Lookup (A → Active)', desc: 'Translate codes via a lookup table, with a fallback', group: 'Lookup & defaults' },
  { value: 'default', label: 'Default When Empty', desc: 'Substitute a value when the source is null/blank', group: 'Lookup & defaults' },
  // Resolved in the DB destination, not here — the mapping step has no DB connection.
  { value: 'lookup', label: 'Foreign Key (name → id)', desc: "Look the source name up in a parent table and store that row's id", group: 'Lookup & defaults' },
  // Numeric
  { value: 'currency', label: 'Currency Convert (× rate)', desc: 'Multiply an amount by an exchange rate', group: 'Numeric' },
  { value: 'divide', label: 'Divide / Ratio (a ÷ b)', desc: 'Safe ratio of two sources; ÷0 → empty', group: 'Numeric', minSources: 2, exactSources: 2 },
  // Dates
  { value: 'parseDate', label: 'Parse Date (dd/MM/yyyy → ISO)', desc: 'Parse a non-ISO date; impossible dates → empty', group: 'Dates' },
];

/** Preset list grouped for <optgroup> rendering, preserving declaration order. */
export const PRESET_GROUPS = PRESET_TRANSFORMS.reduce((acc, p) => {
  const g = p.group || 'Other';
  (acc[g] = acc[g] || []).push(p);
  return acc;
}, {});

// Output type each preset produces — used to auto-type a new destination column.
// Presets whose output type follows the source (e.g. `default`) are deliberately absent.
export const PRESET_OUTPUT_TYPE = {
  toInt: 'number', toFloat: 'number', extractNumber: 'number',
  sum: 'number', avg: 'number', min: 'number', max: 'number', count: 'number',
  boolean: 'boolean', dateFormat: 'datetime',
  toText: 'string', uppercase: 'string', lowercase: 'string', trim: 'string', joinArray: 'string', concat: 'string',
  codeMap: 'string', currency: 'number', divide: 'number', parseDate: 'datetime',
};

export const PAIR_COLORS = ['#6366f1', '#22c55e', '#a855f7', '#f59e0b', '#ef4444', '#3b82f6', '#14b8a6', '#ec4899', '#84cc16', '#06b6d4'];

export function presetSpec(preset) {
  return PRESET_TRANSFORMS.find((p) => p.value === preset) || null;
}

export function presetConfigSpec(preset) {
  return PRESET_CONFIG_SPEC[preset] || null;
}

/** Fill a preset's config with its declared defaults, keeping anything already set. */
export function defaultPresetConfig(preset, existing) {
  const spec = presetConfigSpec(preset);
  if (!spec) return undefined;
  const out = { ...(existing || {}) };
  for (const f of spec) {
    if (out[f.key] === undefined && f.default !== undefined) out[f.key] = f.default;
    if (f.type === 'keyvalue' && !out[f.key]) out[f.key] = {};
  }
  return out;
}

/** Human-readable problem with a preset mapping's shape/config, or null if it's fine.
    Advisory only — surfaced in the editor so a misconfigured preset isn't silently empty. */
export function presetIssue(mapping) {
  if (!mapping || mapping.transform !== 'PRESET' || !mapping.preset) return null;
  const spec = presetSpec(mapping.preset);
  if (!spec) return null;
  const n = (mapping.sources || []).length;
  if (spec.exactSources && n !== spec.exactSources) {
    return `Needs exactly ${spec.exactSources} source fields (numerator, then denominator) — ${n} selected.`;
  }
  if (spec.minSources && n < spec.minSources) {
    return `Works across ${spec.minSources}+ source fields — only ${n} selected.`;
  }
  const cfg = mapping.presetConfig || {};
  for (const f of presetConfigSpec(mapping.preset) || []) {
    if (f.required && (cfg[f.key] === undefined || cfg[f.key] === '')) return `“${f.label}” is required.`;
  }
  if (mapping.preset === 'codeMap' && !Object.keys(cfg.map || {}).length) {
    return 'No codes mapped yet — every value would fall back to the default.';
  }
  return null;
}

export function typesCompatible(srcType, destType) {
  if (!srcType || !destType) return true;
  const src = srcType.toLowerCase();
  const dest = destType.toLowerCase();
  if (src === dest) return true;
  const stringLike = new Set(['string', 'text', 'choice', 'hyperlinkorpicture', 'note']);
  if (stringLike.has(src) && stringLike.has(dest)) return true;
  if (src === 'datetime' && (dest === 'datetime' || dest === 'date')) return true;
  if (src === 'number' && dest === 'number') return true;
  return false;
}

// Year / partial date / ISO datetime → SQL "YYYY-MM-DD"; unparseable → '' (NULL).
// "2026" → "2026-01-01"; "2026-05" → "2026-05-01"; "AM Ignored" → ''.
export function toSqlDate(value) {
  if (value === null || value === undefined) return '';
  const m = String(value).trim().match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
  if (!m) return '';
  return `${m[1]}-${(m[2] ?? '1').padStart(2, '0')}-${(m[3] ?? '1').padStart(2, '0')}`;
}

/**
 * Parse a date written in a known day/month/year order into ISO `YYYY-MM-DD`.
 * Mirrors MappingEngine.parseDateWithFormat: unlike `dateFormat` (which assumes the
 * source is already ISO and slices 10 chars), this understands dd/MM/yyyy and friends,
 * and returns null for impossible dates (30/02/2026) rather than rolling them over.
 */
export function parseDateWithFormat(input, format = 'dd/MM/yyyy') {
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
 * Aggregate a list of values — mirrors backend services/aggregate.ts.
 * Numeric fns ignore null/undefined/'' before coercing, so an absent field never
 * reads as 0 and drags an average toward zero; a genuine 0 is kept.
 */
export function aggregate(fn, values) {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '');
  const nums = present.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
  switch (fn) {
    case 'count': return present.length;
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'min': return nums.length ? Math.min(...nums) : 0;
    case 'max': return nums.length ? Math.max(...nums) : 0;
    case 'concat': return present.map((v) => String(v)).join(', ');
    case 'first': return present.length ? present[0] : null;
    default: return null;
  }
}

// Resolve a (possibly nested / SharePoint `.fields`) source value from a record.
export function getNestedValue(obj, path) {
  if (!obj || !path) return '';
  const parts = String(path).split('.');
  let val = obj;
  for (const p of parts) {
    if (val == null) return '';
    if (p === 'fields' || p === 'key' || p === 'id') val = val[p];
    else val = val.fields?.[p] ?? val[p];
  }
  return val;
}

/**
 * Collapse a raw source value to a scalar the way the backend does
 * (MappingEngine.extractScalar): arrays → their items' name/displayName joined;
 * objects → .name / .displayName.
 */
export function extractScalar(raw) {
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw)) {
      return raw.map((x) => (x && typeof x === 'object' ? (x.name ?? x.displayName ?? x) : x)).join(', ');
    }
    if (raw.name) return raw.name;
    if (raw.displayName) return raw.displayName;
  }
  return raw ?? '';
}

/**
 * Compute a mapping's output value for ONE record, applying the transform
 * (DIRECT / preset / multi-source EXPRESSION). Shared by the Wizard's row + step-5
 * previews and by the Mapping Canvas preview, and kept faithful to the backend so
 * what you preview is what the bus writes. Returns the raw value (numbers stay numbers).
 */
export function computeMappedValue(m, record) {
  // rawVal keeps the source value's real shape (objects/arrays) for EXPRESSION formulas;
  // srcVal is the flattened scalar used by DIRECT and the presets.
  const rawVal = (m.sources || []).map((s) => getNestedValue(record, s));
  const srcVal = rawVal.map((v) => extractScalar(v));
  const cfg = m.presetConfig || {};

  if (!m.transform || m.transform === 'DIRECT') return srcVal[0] ?? '';

  switch (m.preset) {
    // text
    case 'dateFormat': return String(srcVal[0] ?? '').substring(0, 10);
    case 'toDate': return toSqlDate(srcVal[0]);
    case 'uppercase': return String(srcVal[0] ?? '').toUpperCase();
    case 'lowercase': return String(srcVal[0] ?? '').toLowerCase();
    case 'trim': return String(srcVal[0] ?? '').trim();
    case 'joinArray': return Array.isArray(srcVal[0]) ? srcVal[0].join(', ') : String(srcVal[0] ?? '');
    case 'extractNumber': { const n = String(srcVal[0] ?? '').match(/[\d.]+/); return n ? Number(n[0]) : 0; }
    // type casts
    case 'toInt': return parseInt(String(srcVal[0]), 10) || 0;
    case 'toFloat': return Number(srcVal[0]) || 0;
    case 'toText': return String(srcVal[0] ?? '');
    case 'boolean': return !!srcVal[0] && srcVal[0] !== 'false' && srcVal[0] !== '0';
    // aggregations (across all sources) — delegate to the shared helper, as the backend does
    case 'sum':
    case 'avg':
    case 'min':
    case 'max':
    case 'count':
      return aggregate(m.preset, srcVal);
    // `concat` is ROW-LOCAL field concatenation (space-joined, empties kept) — deliberately
    // distinct from the group `concat` in aggregate() (comma-joined, empties dropped).
    case 'concat': return srcVal.map((v) => v ?? '').join(' ');

    // ── QC-safe additive presets (opt-in per mapping; config in presetConfig) ──
    // codeMap: lookup source value in a table; unmapped codes fall back to a default.
    case 'codeMap': {
      const map = cfg.map || {};
      const key = String(srcVal[0] ?? '');
      const fallback = cfg.default ?? 'Unknown';
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
    }
    // default: substitute a configured value when the source is null/empty.
    case 'default': {
      const v = srcVal[0];
      const empty = v === null || v === undefined || v === '';
      return empty ? (cfg.value ?? '') : v;
    }
    // currency: amount × configured rate, rounded to N decimals.
    case 'currency': {
      const n = Number(srcVal[0]);
      if (!Number.isFinite(n)) return null;
      const rate = Number(cfg.rate ?? 1);
      const decimals = Number(cfg.decimals ?? 2);
      return Number((n * rate).toFixed(decimals));
    }
    // divide: safe ratio of two sources; ÷0 → null, never NaN/Infinity.
    case 'divide': {
      const num = Number(srcVal[0]);
      const den = Number(srcVal[1]);
      if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
      const multiplier = Number(cfg.multiplier ?? 1);
      const decimals = Number(cfg.decimals ?? 2);
      return Number(((num / den) * multiplier).toFixed(decimals));
    }
    // parseDate: non-ISO date → ISO YYYY-MM-DD; invalid → null.
    case 'parseDate':
      return parseDateWithFormat(String(srcVal[0] ?? ''), String(cfg.format ?? 'dd/MM/yyyy'));

    /* lookup (foreign key): pass through, exactly like the backend. The parent
       row is resolved in the DB destination, which owns the connection — so a
       preview honestly shows the NAME that will be resolved, not a fabricated id. */
    case 'lookup': return srcVal[0];

    default: break;
  }

  if (m.transform === 'EXPRESSION' && m.expression) {
    // Pass the RAW source values so a formula written against the real shape works
    // (e.g. source['status'].name). Matches the backend's sandboxed evaluator.
    const source = {};
    (m.sources || []).forEach((s, i) => {
      source[s] = rawVal[i]; // flat key: source['@join.alias.col'] / source['status.name']
      // Also expose a NESTED view so source['@join']['alias']['col'] resolves — the Wizard
      // auto-generates dotted source paths as nested optional chains.
      if (String(s).includes('.')) {
        const parts = String(s).split('.');
        let cur = source;
        for (let k = 0; k < parts.length - 1; k++) {
          const p = parts[k];
          if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
          cur = cur[p];
        }
        cur[parts[parts.length - 1]] = rawVal[i];
      }
    });
    const fn = new Function('source', m.expression);
    return fn(source);
  }

  return srcVal.join(', ');
}

export function generateExpression(sources, srcTypes, destinations, destTypes) {
  if (!sources || sources.length === 0) return '';
  const src0 = sources[0];
  const srcType0 = (srcTypes?.[0] || '').toLowerCase();
  const destType0 = (destTypes?.[0] || '').toLowerCase();

  if (sources.length > 1) {
    const parts = sources.map((s) => s.includes('.')
      ? `(${s.split('.').reduce((acc, p) => `${acc}?.${p}`, 'source')} ?? '')`
      : `(source['${s}'] ?? '')`);
    return `return ${parts.join(" + ' ' + ")};`;
  }
  if (src0.includes('.')) {
    const chain = src0.split('.').reduce((acc, p) => `${acc}?.['${p}']`, 'source');
    if (destType0 === 'text' || destType0 === 'string' || destType0 === 'choice') return `return String(${chain} ?? '');`;
    return `return ${chain};`;
  }
  if (srcType0 === 'object') {
    if (/assignee|reporter|creator/i.test(src0)) return `return source['${src0}']?.displayName ?? source['${src0}']?.name ?? '';`;
    if (/status|priority|issuetype|resolution/i.test(src0)) return `return source['${src0}']?.name ?? '';`;
    return `return source['${src0}']?.name ?? source['${src0}']?.displayName ?? JSON.stringify(source['${src0}']);`;
  }
  if (srcType0 === 'array') return `const arr = source['${src0}'] || [];\nreturn arr.map(v => typeof v === 'object' ? (v.name || v) : v).join(', ');`;
  if (srcType0 === 'string' && destType0 === 'number') return `const val = source['${src0}'];\nreturn val ? Number(val) : null;`;
  if (srcType0 === 'number' && (destType0 === 'text' || destType0 === 'string')) return `return String(source['${src0}'] ?? '');`;
  if (srcType0 === 'datetime' && destType0 === 'date') return `return (source['${src0}'] || '').substring(0, 10);`;
  if (destType0 === 'boolean') return `return Boolean(source['${src0}']);`;
  return `return source['${src0}'];`;
}

/** Render a sample date in a `dd/MM/yyyy`-style token format, e.g. "15/06/2026". */
function sampleDateForFormat(format) {
  return String(format || 'dd/MM/yyyy').replace(/y+/gi, '2026').replace(/d+/g, '15').replace(/M+/g, '06');
}

/**
 * Build a small sample source object for live preview.
 * `mapping` is optional and only makes the sample preset-aware: parseDate reads a
 * date written in the configured format, so previewing it against a generic
 * "Sample x" string (which parses to null) doesn't read as broken.
 */
export function sampleFor(sources, srcFields, mapping) {
  const sample = {};
  for (const s of sources) {
    const sf = srcFields.find((f) => f.name === s);
    if (sf?.type === 'array') sample[s] = ['item1', 'item2'];
    else if (sf?.type === 'number') sample[s] = 42;
    else if (sf?.type === 'boolean') sample[s] = true;
    else if (sf?.type === 'datetime') sample[s] = '2025-06-15T10:30:00.000Z';
    else sample[s] = `Sample ${s}`;
  }
  if (mapping?.transform === 'PRESET' && mapping.preset === 'parseDate') {
    const example = sampleDateForFormat(mapping.presetConfig?.format);
    for (const s of sources) sample[s] = example;
  }
  return sample;
}
