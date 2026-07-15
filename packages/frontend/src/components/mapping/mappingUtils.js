/* Shared field-mapping logic — the single source of truth used by both the
   Connection Wizard (step 4) and the standalone Mapping Canvas. Pure functions,
   no React. */

export const PRESET_TRANSFORMS = [
  { value: 'dateFormat', label: 'Date Format (YYYY-MM-DD)', desc: 'Extracts date portion' },
  { value: 'toDate', label: 'Year/Partial → Date (YYYY-MM-DD)', desc: 'Year "2026" → 2026-01-01; junk → empty. For SQL date columns.' },
  { value: 'uppercase', label: 'Uppercase', desc: 'Converts text to UPPER CASE' },
  { value: 'lowercase', label: 'Lowercase', desc: 'Converts text to lower case' },
  { value: 'trim', label: 'Trim Whitespace', desc: 'Removes leading/trailing spaces' },
  { value: 'joinArray', label: 'Join Array → String', desc: 'Joins array items with comma' },
  { value: 'extractNumber', label: 'Extract Number', desc: 'Extracts first number from text' },
  { value: 'boolean', label: 'Boolean (truthy check)', desc: 'Returns true/false' },
];

export const PAIR_COLORS = ['#6366f1', '#22c55e', '#a855f7', '#f59e0b', '#ef4444', '#3b82f6', '#14b8a6', '#ec4899', '#84cc16', '#06b6d4'];

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

export function runPresetTransform(preset, value) {
  if (value === null || value === undefined) return '';
  switch (preset) {
    case 'dateFormat': return typeof value === 'string' ? value.substring(0, 10) : String(value);
    case 'toDate': return toSqlDate(value);
    case 'uppercase': return String(value).toUpperCase();
    case 'lowercase': return String(value).toLowerCase();
    case 'trim': return String(value).trim();
    case 'joinArray': return Array.isArray(value) ? value.join(', ') : String(value);
    case 'extractNumber': { const m = String(value).match(/[\d.]+/); return m ? Number(m[0]) : ''; }
    case 'boolean': return Boolean(value);
    default: return value;
  }
}

export function evaluateExpression(expression, sourceObj) {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('source', expression);
    return { result: fn(sourceObj), error: null };
  } catch (err) {
    return { result: null, error: err.message };
  }
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

/** Build a small sample source object for live preview. */
export function sampleFor(sources, srcFields) {
  const sample = {};
  for (const s of sources) {
    const sf = srcFields.find((f) => f.name === s);
    if (sf?.type === 'array') sample[s] = ['item1', 'item2'];
    else if (sf?.type === 'number') sample[s] = 42;
    else if (sf?.type === 'boolean') sample[s] = true;
    else if (sf?.type === 'datetime') sample[s] = '2025-06-15T10:30:00.000Z';
    else sample[s] = `Sample ${s}`;
  }
  return sample;
}
