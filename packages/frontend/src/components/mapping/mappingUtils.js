/* Shared field-mapping logic — the single source of truth used by both the
   Connection Wizard (step 4) and the standalone Mapping Canvas. Pure functions,
   no React. */

export const PRESET_TRANSFORMS = [
  { value: 'dateFormat', label: 'Date Format (YYYY-MM-DD)', desc: 'Extracts date portion' },
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

export function runPresetTransform(preset, value) {
  if (value === null || value === undefined) return '';
  switch (preset) {
    case 'dateFormat': return typeof value === 'string' ? value.substring(0, 10) : String(value);
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

/** Deterministic client-side auto-map (used as a fallback / offline). */
export function autoMapFields(srcFields, destFields) {
  const mappings = [];
  const usedDest = new Set();
  const normalise = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, '');
  let seq = 0;
  const make = (sf, df) => {
    const compat = typesCompatible(sf.type, df.type) && sf.type !== 'object' && sf.type !== 'array' && !sf.name.includes('.');
    mappings.push({
      id: `m${seq}-${++seq}`,
      sources: [sf.name], destinations: [df.name],
      srcTypes: [sf.type], destTypes: [df.type],
      transform: compat ? 'DIRECT' : 'EXPRESSION', preset: null,
      expression: compat ? '' : generateExpression([sf.name], [sf.type], [df.name], [df.type]),
      confidence: 0.9,
    });
    usedDest.add(df.name);
  };
  for (const sf of srcFields) {
    const sn = normalise(sf.name);
    const df = destFields.find((f) => !usedDest.has(f.name) && (normalise(f.name) === sn || normalise(f.displayName || f.name) === sn));
    if (df) make(sf, df);
  }
  const semanticMap = [
    [['key'], ['IssueKey', 'ExternalId']],
    [['summary'], ['Title', 'Summary']],
    [['status.name', 'status'], ['Status', 'StatusName']],
    [['priority.name', 'priority'], ['Priority']],
    [['assignee.displayName', 'assignee'], ['Assignee', 'AssigneeName', 'AssignedTo']],
    [['reporter.displayName', 'reporter'], ['Reporter']],
    [['issuetype.name', 'issuetype'], ['IssueType']],
    [['created'], ['CreatedDate', 'JiraCreated']],
    [['updated'], ['UpdatedDate', 'JiraUpdated', 'ModifiedDate']],
    [['labels'], ['Labels', 'Tags']],
  ];
  for (const [srcNames, destNames] of semanticMap) {
    const sf = srcFields.find((f) => srcNames.includes(f.name));
    if (!sf || mappings.some((m) => m.sources.includes(sf.name))) continue;
    const df = destFields.find((f) => !usedDest.has(f.name) && destNames.some((dn) => dn === f.name || dn.toLowerCase() === (f.displayName || '').toLowerCase()));
    if (df) make(sf, df);
  }
  return mappings;
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
