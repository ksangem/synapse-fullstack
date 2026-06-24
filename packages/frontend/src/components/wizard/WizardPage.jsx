import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { runtimeClient } from '../../services/runtimeClient';

/* ─── Static Data ──────────────────────────────────────��── */
const stepLabels = ['Select Systems', 'Credentials', 'Entities', 'Mapping', 'Fetch & Review', 'Push & Sync'];
// Per-tab persistence of the whole wizard session: survives navigating away and back,
// and a page refresh, so "go back" returns you to the exact step/state (incl. an
// in-flight push). Cleared by the "Start over" button.
const WIZARD_STATE_KEY = 'synapseWizardState';
const DEFAULT_ICON = '\u{1F50C}'; // fallback card icon for registry connectors without one

// A connector icon can be emoji(s) OR an image/logo URL (e.g. a Keka logo); render accordingly.
const isIconUrl = (v) => typeof v === 'string' && /^(https?:|data:image\/)/i.test(v.trim());
function ConnIcon({ icon, size = 26 }) {
  if (isIconUrl(icon)) return <img src={icon.trim()} alt="" style={{ width: size, height: size, objectFit: 'contain', verticalAlign: 'middle' }} />;
  return <span style={{ fontSize: size }}>{icon || DEFAULT_ICON}</span>;
}
/* Connector cards, credential field schemas, DB engine config, and entity
   descriptions are loaded at runtime from the connector registry
   (`/api/connectors`) into component state — see the connector-metadata effect
   inside WizardPage. `isDbDest` / `getFields` / `dbCfg` are registry-driven. */

const PRESET_TRANSFORMS = [
  // Text (single source)
  { value: 'dateFormat', label: 'Date Format (YYYY-MM-DD)', desc: 'Extracts date portion' },
  { value: 'uppercase', label: 'Uppercase', desc: 'Converts text to UPPER CASE' },
  { value: 'lowercase', label: 'Lowercase', desc: 'Converts text to lower case' },
  { value: 'trim', label: 'Trim Whitespace', desc: 'Removes leading/trailing spaces' },
  { value: 'joinArray', label: 'Join Array \u2192 String', desc: 'Joins array items with comma' },
  { value: 'extractNumber', label: 'Extract Number', desc: 'Extracts first number from text' },
  // Type casts (single source)
  { value: 'toInt', label: 'Cast \u2192 Integer', desc: 'Parse the value as a whole number' },
  { value: 'toFloat', label: 'Cast \u2192 Decimal', desc: 'Parse the value as a decimal number' },
  { value: 'toText', label: 'Cast \u2192 Text', desc: 'Convert the value to a string' },
  { value: 'boolean', label: 'Cast \u2192 Boolean', desc: 'Truthy check \u2192 true / false' },
  // Aggregations (across ALL selected source fields, coerced to numbers)
  { value: 'sum', label: '\u03a3 Sum (all sources)', desc: 'Add all selected sources as numbers' },
  { value: 'avg', label: 'Average / Mean (all sources)', desc: 'Mean of the selected number sources' },
  { value: 'min', label: 'Min (all sources)', desc: 'Smallest of the source values' },
  { value: 'max', label: 'Max (all sources)', desc: 'Largest of the source values' },
  { value: 'count', label: 'Count (non-empty sources)', desc: 'How many sources have a value' },
  { value: 'concat', label: 'Concatenate (all sources)', desc: 'Join all sources with a space' },
];

// Output type each preset produces \u2014 used to auto-type a new destination column.
const PRESET_OUTPUT_TYPE = {
  toInt: 'number', toFloat: 'number', extractNumber: 'number',
  sum: 'number', avg: 'number', min: 'number', max: 'number', count: 'number',
  boolean: 'boolean', dateFormat: 'datetime',
  toText: 'string', uppercase: 'string', lowercase: 'string', trim: 'string', joinArray: 'string', concat: 'string',
};
function inferMappingOutputType(m) {
  if (m.transform === 'PRESET' && PRESET_OUTPUT_TYPE[m.preset]) return PRESET_OUTPUT_TYPE[m.preset];
  if (m.transform === 'DIRECT') return m.srcTypes?.[0] || 'string';
  return m.srcTypes?.[0] || 'string'; // EXPRESSION: unknown statically \u2192 user can override
}

const PAIR_COLORS = ['#6366f1','#22c55e','#a855f7','#f59e0b','#ef4444','#3b82f6','#14b8a6','#ec4899','#84cc16','#06b6d4'];

/* ─── Helpers ───────────────────────────────────────────── */
// Safe hostname extraction — fm.endpointUrl/siteUrl may be missing or not a
// fully-qualified URL, and a raw `new URL()` throws and crashes the render.
function hostnameOf(url) {
  if (!url) return '';
  try { return new URL(url).hostname; }
  catch { return String(url).replace(/^https?:\/\//, '').split('/')[0]; }
}

function typesCompatible(srcType, destType) {
  if (!srcType || !destType) return true;
  const src = srcType.toLowerCase();
  const dest = destType.toLowerCase();
  if (src === dest) return true;
  const stringLike = new Set(['string', 'text', 'choice', 'hyperlinkorpicture']);
  if (stringLike.has(src) && stringLike.has(dest)) return true;
  if (src === 'datetime' && (dest === 'datetime' || dest === 'date')) return true;
  if (src === 'number' && dest === 'number') return true;
  return false;
}

// Turn a source field name into a SharePoint-safe internal column name. SP column
// names can't contain dots/spaces/special chars, so a nested Jira field like
// `status.name` becomes `statusname` — which still normalise-matches the source in
// autoMapFields, so Auto-Map produces a direct/expression mapping for it.
function spSafeColName(name) {
  const clean = String(name).replace(/[^A-Za-z0-9]/g, '');
  return /^[0-9]/.test(clean) ? `f${clean}` : (clean || 'Field');
}

function autoMapFields(srcFields, destFields) {
  const mappings = [];
  const usedDest = new Set();
  const normalise = (n) => n.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Pass 1: exact name match
  for (const sf of srcFields) {
    const srcNorm = normalise(sf.name);
    for (const df of destFields) {
      if (usedDest.has(df.name)) continue;
      if (normalise(df.name) === srcNorm || normalise(df.displayName || df.name) === srcNorm) {
        const compat = typesCompatible(sf.type, df.type) && sf.type !== 'object' && sf.type !== 'array';
        mappings.push({
          id: `m${Date.now()}-${mappings.length}`,
          sources: [sf.name],
          destinations: [df.name],
          srcTypes: [sf.type],
          destTypes: [df.type],
          transform: compat ? 'DIRECT' : 'EXPRESSION',
          preset: null,
          expression: compat ? '' : generateExpression([sf.name], [sf.type], [df.name], [df.type]),
        });
        usedDest.add(df.name);
        break;
      }
    }
  }

  // Pass 2: partial/semantic match for common field pairs
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
    [['resolutiondate'], ['ResolutionDate']],
    [['labels'], ['Labels', 'Tags']],
    [['customfield_10016'], ['StoryPoints']],
    [['resolution.name', 'resolution'], ['Resolution']],
  ];

  for (const [srcNames, destNames] of semanticMap) {
    const srcField = srcFields.find(f => srcNames.includes(f.name));
    if (!srcField) continue;
    const alreadyMapped = mappings.some(m => m.sources.includes(srcField.name));
    if (alreadyMapped) continue;

    for (const dn of destNames) {
      const destField = destFields.find(f => f.name === dn || (f.displayName || '').toLowerCase() === dn.toLowerCase());
      if (!destField || usedDest.has(destField.name)) continue;

      const compat = typesCompatible(srcField.type, destField.type) && srcField.type !== 'object' && srcField.type !== 'array' && !srcField.name.includes('.');
      mappings.push({
        id: `m${Date.now()}-${mappings.length}`,
        sources: [srcField.name],
        destinations: [destField.name],
        srcTypes: [srcField.type],
        destTypes: [destField.type],
        transform: compat ? 'DIRECT' : 'EXPRESSION',
        preset: null,
        expression: compat ? '' : generateExpression([srcField.name], [srcField.type], [destField.name], [destField.type]),
      });
      usedDest.add(destField.name);
      break;
    }
  }

  return mappings;
}

function runPresetTransform(preset, value) {
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

function evaluateExpression(expression, sourceObj) {
  try {
    const fn = new Function('source', expression);
    return { result: fn(sourceObj), error: null };
  } catch (err) {
    return { result: null, error: err.message };
  }
}

/**
 * Auto-generate a JS expression based on source fields and destination type.
 * Handles nested objects (assignee.displayName), arrays (labels), type coercion, etc.
 */
function generateExpression(sources, srcTypes, destinations, destTypes) {
  if (sources.length === 0) return '';
  const src0 = sources[0];
  const srcType0 = (srcTypes[0] || '').toLowerCase();
  const destType0 = (destTypes[0] || '').toLowerCase();

  // Multiple sources → concatenate
  if (sources.length > 1) {
    const parts = sources.map(s => {
      if (s.includes('.')) {
        const chain = s.split('.').reduce((acc, p) => `${acc}?.${p}`, 'source');
        return `(${chain} ?? '')`;
      }
      return `(source['${s}'] ?? '')`;
    });
    return `// Combine ${sources.join(' + ')}\nreturn ${parts.join(" + ' ' + ")};`;
  }

  // Nested object field (e.g. status.name, assignee.displayName)
  if (src0.includes('.')) {
    const parts = src0.split('.');
    const chain = parts.reduce((acc, p) => `${acc}?.['${p}']`, 'source');
    if (destType0 === 'text' || destType0 === 'string' || destType0 === 'choice') {
      return `return String(${chain} ?? '');`;
    }
    return `return ${chain};`;
  }

  // Object source → extract name/displayName
  if (srcType0 === 'object') {
    const field = src0;
    // Common Jira objects: status, assignee, reporter, priority, issuetype, resolution
    if (/assignee|reporter|creator/i.test(field)) {
      return `return source['${field}']?.displayName ?? source['${field}']?.name ?? 'Unassigned';`;
    }
    if (/status|priority|issuetype|resolution/i.test(field)) {
      return `return source['${field}']?.name ?? '';`;
    }
    // Generic object → try .name then .displayName
    return `return source['${field}']?.name ?? source['${field}']?.displayName ?? JSON.stringify(source['${field}']);`;
  }

  // Array source → join
  if (srcType0 === 'array') {
    return `const arr = source['${src0}'] || [];\nreturn arr.map(v => typeof v === 'object' ? (v.name || v) : v).join(', ');`;
  }

  // Type coercion: string → number
  if (srcType0 === 'string' && destType0 === 'number') {
    return `const val = source['${src0}'];\nreturn val ? Number(val) : null;`;
  }

  // Type coercion: number → string
  if (srcType0 === 'number' && (destType0 === 'text' || destType0 === 'string')) {
    return `return String(source['${src0}'] ?? '');`;
  }

  // Datetime → date
  if (srcType0 === 'datetime' && destType0 === 'date') {
    return `return (source['${src0}'] || '').substring(0, 10);`;
  }

  // Boolean
  if (destType0 === 'boolean') {
    return `return Boolean(source['${src0}']);`;
  }

  // Default: direct access
  return `return source['${src0}'];`;
}

/* ─── Sub-Components ────────────────────────────────────── */
function PasswordField({ value, onChange, placeholder, label }) {
  const [showPw, setShowPw] = useState(false);
  const togglePw = () => { setShowPw(true); setTimeout(() => setShowPw(false), 3000); };
  return (
    <div className="form-group">
      <label>{label}</label>
      <div className="password-wrap">
        <input type={showPw ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
        <button className="eye-btn" type="button" onClick={togglePw}>&#128065;</button>
      </div>
    </div>
  );
}

// Resolve a (possibly nested / SharePoint `.fields`) source value from a record.
function getNestedValue(obj, path) {
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

// Compute a mapping's output value for ONE record, applying the transform
// (DIRECT / preset / multi-source EXPRESSION). Shared by the Step-5 preview AND the push,
// so what you preview is exactly what gets written. Returns the raw value (numbers stay numbers).
function computeMappedValue(m, record) {
  const srcVal = (m.sources || []).map((s) => {
    const raw = getNestedValue(record, s);
    if (raw && typeof raw === 'object') {
      if (raw.name) return raw.name;
      if (raw.displayName) return raw.displayName;
      if (Array.isArray(raw)) return raw.map((v) => (typeof v === 'object' ? (v.name || JSON.stringify(v)) : v)).join(', ');
      return JSON.stringify(raw);
    }
    return raw ?? '';
  });
  if (!m.transform || m.transform === 'DIRECT') return srcVal[0] ?? '';
  const nums = srcVal.map((v) => Number(v)).filter((n) => !Number.isNaN(n));
  switch (m.preset) {
    // text
    case 'dateFormat': return String(srcVal[0] ?? '').substring(0, 10);
    case 'uppercase': return String(srcVal[0] ?? '').toUpperCase();
    case 'lowercase': return String(srcVal[0] ?? '').toLowerCase();
    case 'trim': return String(srcVal[0] ?? '').trim();
    case 'joinArray': return Array.isArray(srcVal[0]) ? srcVal[0].join(', ') : String(srcVal[0] ?? '');
    case 'extractNumber': { const n = String(srcVal[0] ?? '').match(/[\d.]+/); return n ? Number(n[0]) : 0; }
    // type casts
    case 'toInt': return parseInt(srcVal[0], 10) || 0;
    case 'toFloat': return Number(srcVal[0]) || 0;
    case 'toText': return String(srcVal[0] ?? '');
    case 'boolean': return !!srcVal[0] && srcVal[0] !== 'false' && srcVal[0] !== '0';
    // aggregations (across all sources)
    case 'sum': return nums.reduce((a, b) => a + b, 0);
    case 'avg': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    case 'min': return nums.length ? Math.min(...nums) : 0;
    case 'max': return nums.length ? Math.max(...nums) : 0;
    case 'count': return srcVal.filter((v) => v !== null && v !== undefined && v !== '').length;
    case 'concat': return srcVal.map((v) => v ?? '').join(' ');
    default: break;
  }
  if (m.transform === 'EXPRESSION' && m.expression) {
    const source = {};
    (m.sources || []).forEach((s, i) => { source[s] = srcVal[i]; });
    // eslint-disable-next-line no-new-func
    const fn = new Function('source', m.expression);
    return fn(source);
  }
  return srcVal.join(', ');
}

function MappingRow({ mapping, index, srcFields, destFields, allowNewDest, isKey, onSetKey, onUpdate, onRemove, expanded, onToggle }) {
  const color = PAIR_COLORS[index % PAIR_COLORS.length];
  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState('');
  const addNewDestColumn = (raw) => {
    const name = (raw || '').trim();
    if (!name || mapping.destinations.includes(name)) return;
    const t = newColType || inferMappingOutputType(mapping);
    const newDests = [...mapping.destinations, name];
    const newDestTypes = [...mapping.destTypes, t];
    const needsExpr = newDests.length > 1;
    onUpdate({
      ...mapping,
      destinations: newDests,
      destTypes: newDestTypes,
      transform: needsExpr ? 'EXPRESSION' : mapping.transform,
      expression: needsExpr
        ? `// Multiple destinations\nreturn { ${newDests.map((d) => `'${d}': source['${mapping.sources[0]}']`).join(', ')} };`
        : mapping.expression,
    });
    setNewColName('');
  };
  const srcDisplay = mapping.sources.join(' + ');
  const destDisplay = mapping.destinations.join(' + ');
  const compatible = mapping.sources.every((s, i) => {
    const sf = srcFields.find(f => f.name === s);
    const df = destFields.find(f => f.name === mapping.destinations[0]);
    return typesCompatible(sf?.type, df?.type);
  });
  const hasMismatch = !compatible && mapping.transform === 'DIRECT';

  const transformLabel = mapping.transform === 'DIRECT' ? 'Direct'
    : mapping.transform === 'PRESET' ? (PRESET_TRANSFORMS.find(p => p.value === mapping.preset)?.label || 'Preset')
    : 'JS Expr';
  const badgeClass = hasMismatch ? 'mismatch'
    : mapping.transform === 'DIRECT' ? 'direct'
    : mapping.transform === 'PRESET' ? 'transform'
    : 'expression';

  // Preview
  const sampleSource = {};
  for (const s of mapping.sources) {
    const sf = srcFields.find(f => f.name === s);
    if (sf?.type === 'array') sampleSource[s] = ['item1', 'item2'];
    else if (sf?.type === 'number') sampleSource[s] = 42;
    else if (sf?.type === 'boolean') sampleSource[s] = true;
    else if (sf?.type === 'datetime') sampleSource[s] = '2025-06-15T10:30:00.000Z';
    else sampleSource[s] = `Sample ${s}`;
  }

  let previewOutput = '';
  let previewError = '';
  try {
    previewOutput = JSON.stringify(computeMappedValue(mapping, sampleSource));
  } catch (e) {
    previewError = e.message;
  }

  return (
    <div className={`mapping-row${expanded ? ' expanded' : ''}${hasMismatch ? ' has-warning' : ''}`}>
      <div className="mapping-row-header" onClick={onToggle}>
        <button
          type="button"
          className="map-key-star"
          title={isKey
            ? 'This column is the identity / match key — records are deduped & upserted by it. Click to clear (append every row instead).'
            : 'Use this mapping as the identity / match key (dedupe & upsert by this column)'}
          onClick={(e) => { e.stopPropagation(); onSetKey(); }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px',
            fontSize: '1.1rem', lineHeight: 1, color: isKey ? '#f59e0b' : 'var(--text-dim)',
            opacity: isKey ? 1 : 0.55,
          }}
        >{isKey ? '★' : '☆'}</button>
        <div className="map-num" style={{ background: color }}>{index + 1}</div>
        <span className="map-src" title={srcDisplay}>{srcDisplay}</span>
        <span className="map-arrow">&rarr;</span>
        <span className="map-dest" title={destDisplay}>{destDisplay}</span>
        <span className={`map-badge ${badgeClass}`}>{hasMismatch ? '\u26A0 Type' : transformLabel}</span>
        <span className="map-actions">
          <button title="Remove" onClick={e => { e.stopPropagation(); onRemove(); }}>&times;</button>
        </span>
      </div>
      {expanded && (
        <div className="mapping-row-editor">
          <div className="mapping-editor-grid">
            <div className="editor-field">
              <label>Source Field(s)</label>
              <div className="multi-field-list">
                {mapping.sources.map((s, i) => (
                  <span key={i} className="multi-field-chip">
                    {s}
                    {mapping.sources.length > 1 && (
                      <button onClick={() => {
                        const next = { ...mapping, sources: mapping.sources.filter((_, j) => j !== i), srcTypes: mapping.srcTypes.filter((_, j) => j !== i) };
                        onUpdate(next);
                      }}>&times;</button>
                    )}
                  </span>
                ))}
              </div>
              <select
                value=""
                onChange={e => {
                  if (!e.target.value) return;
                  const sf = srcFields.find(f => f.name === e.target.value);
                  if (sf && !mapping.sources.includes(sf.name)) {
                    const newSources = [...mapping.sources, sf.name];
                    const newSrcTypes = [...mapping.srcTypes, sf.type];
                    const needsExpr = newSources.length > 1 || sf.type === 'object' || sf.type === 'array' || sf.name.includes('.')
                      || !typesCompatible(sf.type, mapping.destTypes[0] || 'text');
                    const newTransform = needsExpr ? 'EXPRESSION' : mapping.transform;
                    const newExpr = needsExpr
                      ? generateExpression(newSources, newSrcTypes, mapping.destinations, mapping.destTypes)
                      : mapping.expression;
                    onUpdate({
                      ...mapping,
                      sources: newSources,
                      srcTypes: newSrcTypes,
                      transform: newTransform,
                      expression: newExpr,
                    });
                  }
                  e.target.value = '';
                }}
                style={{ marginTop: 6 }}
              >
                <option value="">+ Add source field...</option>
                {srcFields.filter(f => !mapping.sources.includes(f.name)).map(f => (
                  <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                ))}
              </select>
            </div>
            <div className="editor-field">
              <label>Destination Column(s)</label>
              <div className="multi-field-list">
                {mapping.destinations.map((d, i) => (
                  <span key={i} className="multi-field-chip">
                    {d}
                    {mapping.destinations.length > 1 && (
                      <button onClick={() => {
                        const next = { ...mapping, destinations: mapping.destinations.filter((_, j) => j !== i), destTypes: mapping.destTypes.filter((_, j) => j !== i) };
                        onUpdate(next);
                      }}>&times;</button>
                    )}
                  </span>
                ))}
              </div>
              <select
                value=""
                onChange={e => {
                  if (!e.target.value) return;
                  const df = destFields.find(f => f.name === e.target.value);
                  if (df && !mapping.destinations.includes(df.name)) {
                    const newDests = [...mapping.destinations, df.name];
                    const newDestTypes = [...mapping.destTypes, df.type];
                    const needsExpr = newDests.length > 1 || mapping.sources.some(s => s.includes('.'))
                      || mapping.srcTypes.some(t => t === 'object' || t === 'array')
                      || !typesCompatible(mapping.srcTypes[0] || 'string', df.type);
                    const newTransform = needsExpr ? 'EXPRESSION' : mapping.transform;
                    const newExpr = needsExpr
                      ? (newDests.length > 1
                          ? `// Multiple destinations\nreturn { ${newDests.map(d => `'${d}': source['${mapping.sources[0]}']`).join(', ')} };`
                          : generateExpression(mapping.sources, mapping.srcTypes, newDests, newDestTypes))
                      : mapping.expression;
                    onUpdate({
                      ...mapping,
                      destinations: newDests,
                      destTypes: newDestTypes,
                      transform: newTransform,
                      expression: newExpr,
                    });
                  }
                  e.target.value = '';
                }}
                style={{ marginTop: 6 }}
              >
                <option value="">+ Add destination column...</option>
                {destFields.filter(f => !mapping.destinations.includes(f.name)).map(f => (
                  <option key={f.name} value={f.name}>{f.displayName || f.name} ({f.type}){f.required ? ' *' : ''}</option>
                ))}
              </select>
              {allowNewDest && (
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <input
                    value={newColName}
                    onChange={(e) => setNewColName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNewDestColumn(newColName); } }}
                    placeholder="+ New column…"
                    style={{ flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 6, border: '1px dashed var(--border)', fontSize: '.82rem' }}
                  />
                  <select value={newColType || inferMappingOutputType(mapping)} onChange={(e) => setNewColType(e.target.value)}
                    title="Column type (defaults to the transform's output type)"
                    style={{ padding: '5px 6px', borderRadius: 6, border: '1px solid var(--border)', fontSize: '.78rem' }}>
                    <option value="string">Text</option>
                    <option value="number">Number</option>
                    <option value="boolean">Boolean</option>
                    <option value="datetime">Date</option>
                  </select>
                  <button className="btn btn-outline btn-sm" disabled={!newColName.trim()} onClick={() => addNewDestColumn(newColName)}>Add</button>
                </div>
              )}
            </div>
          </div>

          <div className="transform-section">
            <label>Transform</label>
            <div className="transform-modes">
              <button className={`transform-mode-btn${mapping.transform === 'DIRECT' ? ' active' : ''}`}
                onClick={() => onUpdate({ ...mapping, transform: 'DIRECT', preset: null, expression: '' })}>
                Direct Copy
              </button>
              <button className={`transform-mode-btn${mapping.transform === 'PRESET' ? ' active' : ''}`}
                onClick={() => onUpdate({ ...mapping, transform: 'PRESET', preset: mapping.preset || 'joinArray' })}>
                Preset
              </button>
              <button className={`transform-mode-btn${mapping.transform === 'EXPRESSION' ? ' active' : ''}`}
                onClick={() => onUpdate({ ...mapping, transform: 'EXPRESSION', expression: mapping.expression || generateExpression(mapping.sources, mapping.srcTypes, mapping.destinations, mapping.destTypes) })}>
                JavaScript
              </button>
            </div>

            {mapping.transform === 'PRESET' && (
              <select value={mapping.preset || ''} onChange={e => onUpdate({ ...mapping, preset: e.target.value })}
                style={{ width: '100%', marginBottom: 8 }}>
                {PRESET_TRANSFORMS.map(p => (
                  <option key={p.value} value={p.value}>{p.label} &mdash; {p.desc}</option>
                ))}
              </select>
            )}

            {mapping.transform === 'EXPRESSION' && (
              <textarea
                className="expr-editor"
                value={mapping.expression}
                onChange={e => onUpdate({ ...mapping, expression: e.target.value })}
                placeholder={`// Available: ${mapping.sources.map(s => `source['${s}']`).join(', ')}\nreturn source['${mapping.sources[0]}'];`}
                spellCheck={false}
              />
            )}
          </div>

          {/* Preview */}
          <div className="preview-box">
            <div className="preview-label">Preview</div>
            <div className="preview-input">Input: {JSON.stringify(sampleSource)}</div>
            {previewError
              ? <div className="preview-error">Error: {previewError}</div>
              : <div className="preview-output">Output: {previewOutput}</div>
            }
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main Wizard ───────────────────────────────────────── */
export default function WizardPage() {
  const [wizardStep, setWizardStep] = useState(1);
  // True once the saved session (if any) has been applied — gates the persist effect so
  // the initial empty render never overwrites a snapshot before it's restored.
  const [hydrated, setHydrated] = useState(false);
  const [selectedSource, setSelectedSource] = useState(null);
  const [selectedDest, setSelectedDest] = useState(null);
  const navigate = useNavigate();

  // Connector registry (replaces the old hardcoded sourceCards / destCards /
  // credentialFields / DB_DEST_CONFIG / entityDescriptions). Loaded on mount.
  const [sourceCards, setSourceCards] = useState([]); // [{ icon, label, connectorId }]
  const [destCards, setDestCards] = useState([]);
  const [connectorMeta, setConnectorMeta] = useState({}); // label → { connectorId, latestVersionId, credFields, runtimeConfig, entityDescriptions }

  // Saved connections (loaded on mount)
  const [savedConnections, setSavedConnections] = useState([]);
  const [savedLoading, setSavedLoading] = useState(false);
  // Horizontal "My Connections" strip — ref + one-card scroll for the arrow buttons.
  const connStripRef = useRef(null);
  // Whether there's more to scroll in each direction (drives the arrow disabled state).
  const [connScroll, setConnScroll] = useState({ left: false, right: false });
  const updateConnScroll = useCallback(() => {
    const el = connStripRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setConnScroll({
      left: scrollLeft > 1,
      right: scrollLeft < scrollWidth - clientWidth - 1,
    });
  }, []);
  const scrollConnStrip = (dir) => {
    const el = connStripRef.current;
    if (!el) return;
    const card = el.querySelector('[data-conn-card]');
    const step = card ? card.offsetWidth + 10 : 250; // card width + flex gap
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  };

  // One name for the whole integration (replaces per-side "Connection Name").
  const [connectionName, setConnectionName] = useState('');

  // Step 1 — search filters
  const [connSearch, setConnSearch] = useState('');
  const [srcSysSearch, setSrcSysSearch] = useState('');
  const [destSysSearch, setDestSysSearch] = useState('');

  // Re-evaluate arrow state when the list/filter changes or the window resizes.
  useEffect(() => {
    updateConnScroll();
    window.addEventListener('resize', updateConnScroll);
    return () => window.removeEventListener('resize', updateConnScroll);
  }, [updateConnScroll, savedConnections, connSearch]);

  // SharePoint destination — list selection moved to Step 3 (existing vs. create new)
  const [spDestCreateNew, setSpDestCreateNew] = useState(false);
  const [spDestLists, setSpDestLists] = useState([]);     // discovered lists on the dest site
  const [spDestListsLoading, setSpDestListsLoading] = useState(false);
  const [spNewListName, setSpNewListName] = useState(''); // name when creating a new dest list

  // Step 2 — Credentials
  const [srcCreds, setSrcCreds] = useState({});
  const [destCreds, setDestCreds] = useState({});
  const [srcTestStatus, setSrcTestStatus] = useState('idle');
  const [destTestStatus, setDestTestStatus] = useState('idle');
  const [srcTestMsg, setSrcTestMsg] = useState('');
  const [destTestMsg, setDestTestMsg] = useState('');
  const [srcConnectionData, setSrcConnectionData] = useState(null);
  const [destConnectionData, setDestConnectionData] = useState(null);
  const [saveStatus, setSaveStatus] = useState('idle'); // idle | saving | saved | error
  const [saveMsg, setSaveMsg] = useState('');
  const [deleteStatus, setDeleteStatus] = useState('idle'); // idle | confirming | deleting | deleted
  const [activeIntegrationId, setActiveIntegrationId] = useState(null); // tracks which saved connection is loaded

  // Step 3 — Entities
  const [entities, setEntities] = useState([]);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState('');

  // Step 3 — Search + PG tables
  const [entitySearch, setEntitySearch] = useState('');
  const [pgTables, setPgTables] = useState([]); // [{ name, columnCount }]
  const [pgTablesLoading, setPgTablesLoading] = useState(false);
  const [selectedPgTable, setSelectedPgTable] = useState('');
  const [createNewTable, setCreateNewTable] = useState(false);
  const [newTableName, setNewTableName] = useState('');

  // Step 4 — Mapping
  const [srcFields, setSrcFields] = useState([]);
  const [destFields, setDestFields] = useState([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [mappings, setMappings] = useState([]);
  const [expandedMapping, setExpandedMapping] = useState(-1);
  const [srcSearch, setSrcSearch] = useState('');
  const [destSearch, setDestSearch] = useState('');
  // Which destination column to dedup/upsert by. '' = default (first mapping); '__append__' = no matching (append every row).
  const [matchKey, setMatchKey] = useState('');

  // Step 5 — Fetch & Review
  const [fetchStatus, setFetchStatus] = useState('idle'); // idle | fetching | done | error
  const [fetchResult, setFetchResult] = useState(null); // { runId, tickets, totalCount }
  const [fetchError, setFetchError] = useState('');
  const [dateStart, setDateStart] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 10); });
  const [dateEnd, setDateEnd] = useState(() => new Date().toISOString().slice(0, 10));

  // Step 6 — Push to SharePoint
  const [pushStatus, setPushStatus] = useState('idle'); // idle | pushing | polling | done | error
  const [pushResult, setPushResult] = useState(null); // { pushRunId, total, created, updated, failed }
  const [pushError, setPushError] = useState('');
  const [pushProgress, setPushProgress] = useState(null);
  // Set when the user clicks "Stop push" so the status poll bails out immediately
  // instead of racing the natural cancelled→finished settle.
  const pushStoppedRef = useRef(false);
  const [stopping, setStopping] = useState(false);

  // Step 6 — DDL Preview (Database destination)
  const [ddlPreview, setDdlPreview] = useState(null); // { missingColumns, ddlStatements, requiresApproval, tableExists }
  const [ddlStatus, setDdlStatus] = useState('idle'); // idle | loading | loaded | applying | applied | error
  const [ddlError, setDdlError] = useState('');

  // Step 6 — Quick View (DB lookup after push)
  const [quickView, setQuickView] = useState(null); // { columns, rows, rowCount, totalCount, table }
  const [quickViewLoading, setQuickViewLoading] = useState(false);
  const [quickViewError, setQuickViewError] = useState('');

  const updateSrcCred = (key, val) => setSrcCreds(prev => ({ ...prev, [key]: val }));
  const updateDestCred = (key, val) => setDestCreds(prev => ({ ...prev, [key]: val }));

  // ─── Registry-driven helpers (replace the old hardcoded lookups) ───
  // Kinds that execute through the generic, registry-dispatched runtime endpoints
  // (/api/connectors/runtime/{test,fetch,push}). Everything EXCEPT the three
  // legacy handler-based kinds (jira/sharepoint/database, which still use their
  // own routes) shares this path, so the Wizard treats them uniformly — adding a
  // new category needs no Wizard change.
  const GENERIC_RUNTIME_KINDS = ['rest', 'generic', 'graphql', 'flatfile', 'soap', 'mq', 'webhook', 'fileshare', 'email', 'scrape'];
  // Hide fields that belong to the integration as a whole, not to one side:
  //  • connectionName → one shared "Connection name" field for the whole pipeline.
  //  • SharePoint listName → a dataset chosen in Step 3, not a credential.
  const getFields = (label) => {
    const f = connectorMeta[label]?.credFields || [];
    const isSp = connectorMeta[label]?.runtimeConfig?.runtimeKind === 'sharepoint';
    return f.filter((x) => x.key !== 'connectionName' && !(isSp && x.key === 'listName'));
  };
  const dbCfg = (label) => connectorMeta[label]?.runtimeConfig || null;
  const isDbDest = (label) => connectorMeta[label]?.runtimeConfig?.runtimeKind === 'database';
  const isRest = (label) => GENERIC_RUNTIME_KINDS.includes(connectorMeta[label]?.runtimeConfig?.runtimeKind);
  // Recognize a SharePoint connector by runtime kind (covers the built-in AND clones like "sp1").
  const isSpSource = (label) => connectorMeta[label]?.runtimeConfig?.runtimeKind === 'sharepoint';
  // A database used AS A SOURCE (reads rows). Kept separate from isDbDest so dest routing is unaffected.
  const isDbSource = (label) => connectorMeta[label]?.runtimeConfig?.runtimeKind === 'database';
  // Source side runs through the generic runtime path (REST-style) for both REST-family and DB sources.
  const isRuntimeSource = (label) => isRest(label) || isDbSource(label);
  const isFlatFile = (label) => connectorMeta[label]?.runtimeConfig?.runtimeKind === 'flatfile';
  const connectorIdOf = (label) => connectorMeta[label]?.connectorId;
  const versionIdOf = (label) => connectorMeta[label]?.latestVersionId;

  // ─── Load saved connections on mount ───────────────────
  useEffect(() => {
    (async () => {
      setSavedLoading(true);
      const res = await api.getSavedConnections();
      if (res.ok && res.data?.data) {
        // Newest first — latest-created connection shows on the left.
        const active = res.data.data
          .filter(c => c.status === 'active')
          .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        setSavedConnections(active);
      }
      setSavedLoading(false);
    })();
  }, []);

  // ─── Load connector registry on mount ──────────────────
  useEffect(() => {
    (async () => {
      const [srcRes, dstRes] = await Promise.all([
        api.getConnectors('source'),
        api.getConnectors('destination'),
      ]);
      const srcList = (srcRes.ok && srcRes.data?.data) || [];
      const dstList = (dstRes.ok && dstRes.data?.data) || [];
      setSourceCards(srcList.map(c => ({ icon: c.icon || DEFAULT_ICON, label: c.name, connectorId: c.connectorId })));
      setDestCards(dstList.map(c => ({ icon: c.icon || DEFAULT_ICON, label: c.name, connectorId: c.connectorId })));

      // Dedup (SharePoint is in both lists), then fetch each connector's schema/config/entities.
      const byId = {};
      [...srcList, ...dstList].forEach(c => { byId[c.connectorId] = c; });
      const metas = await Promise.all(Object.values(byId).map(async (c) => {
        const [credRes, rcRes, entRes] = await Promise.all([
          api.getConnectorCredentialSchema(c.connectorId),
          api.getConnectorRuntimeConfig(c.connectorId),
          api.getConnectorEntities(c.connectorId),
        ]);
        const descriptions = {};
        const entities = (entRes.ok && entRes.data?.data?.entities) || [];
        entities.forEach(e => { descriptions[e.key] = e.description || ''; });
        return [c.name, {
          connectorId: c.connectorId,
          latestVersionId: c.latestVersionId,
          credFields: (credRes.ok && credRes.data?.data?.fields) || [],
          runtimeConfig: (rcRes.ok && rcRes.data?.data) || null,
          entityDescriptions: descriptions,
          entities, // full entity defs (key/name/description/fields) — used by REST source steps
        }];
      }));
      setConnectorMeta(Object.fromEntries(metas));
    })();
  }, []);

  // ─── Apply a saved connection ──────────────────────────
  const applySavedConnection = async (intg) => {
    const fm = intg.fieldMappings || {};
    setConnectionName(intg.name || '');
    // Honor the saved source/destination types (e.g. SharePoint → SQL Server),
    // instead of assuming every saved connection is Jira → SharePoint.
    const srcType = fm.sourceType || 'Jira';
    const destType = fm.destType || 'SharePoint';

    setSelectedSource(srcType);
    setSelectedDest(destType);

    // ── Source prefill ──
    if (srcType === 'Jira') {
      if (fm.credId) {
        const credRes = await api.decryptCredential(fm.credId);
        if (credRes.ok && credRes.data?.data?.payload) {
          const payload = credRes.data.data.payload;
          setSrcCreds({
            connectionName: intg.name,
            endpointUrl: fm.endpointUrl || '',
            email: payload.email || '',
            apiToken: payload.apiToken || '',
          });
          setSrcTestStatus('idle');
          setSrcTestMsg('Credentials loaded from saved connection');
        }
      } else if (fm.endpointUrl) {
        setSrcCreds(prev => ({ ...prev, connectionName: intg.name, endpointUrl: fm.endpointUrl }));
      }
    } else if (srcType === 'SharePoint') {
      // Decrypt the stored Azure app-registration creds so the connection
      // authenticates with its own creds (the test no longer falls back to env).
      let azure = {};
      if (fm.credId) {
        const credRes = await api.decryptCredential(fm.credId);
        if (credRes.ok && credRes.data?.data?.payload) azure = credRes.data.data.payload;
      }
      setSrcCreds(prev => ({
        ...prev,
        connectionName: intg.name,
        siteUrl: fm.siteUrl || fm.endpointUrl || '',
        listName: fm.listName || '',
        tenantId: azure.tenantId || '',
        clientId: azure.clientId || '',
        clientSecret: azure.clientSecret || '',
      }));
      setSrcTestStatus('idle');
      setSrcTestMsg(fm.credId
        ? 'SharePoint source + Azure credentials loaded from saved connection'
        : 'SharePoint source loaded — re-enter Azure credentials and save to store them');
    }

    // ── Destination prefill ──
    if (destType === 'SharePoint') {
      // Decrypt the stored DESTINATION Azure creds (like the DB dest does), so the
      // destination authenticates with its own creds and the fields show on reload.
      let azure = {};
      if (fm.destCredId) {
        const dRes = await api.decryptCredential(fm.destCredId);
        if (dRes.ok && dRes.data?.data?.payload) azure = dRes.data.data.payload;
      }
      setDestCreds({
        connectionName: intg.name + ' (SP)',
        siteUrl: fm.destSiteUrl || fm.siteUrl || '',
        listName: fm.destListName || fm.listName || '',
        tenantId: azure.tenantId || '',
        clientId: azure.clientId || '',
        clientSecret: azure.clientSecret || '',
      });
      setDestTestStatus('idle');
      setDestTestMsg(fm.destCredId
        ? 'SharePoint destination + Azure credentials loaded from saved connection'
        : 'SharePoint destination loaded — re-enter Azure credentials and save to store them');
    } else if (isDbDest(destType)) {
      // Decrypt the stored DB credential to restore username + password too.
      let dbc = {};
      if (fm.destCredId) {
        const dRes = await api.decryptCredential(fm.destCredId);
        if (dRes.ok && dRes.data?.data?.payload) dbc = dRes.data.data.payload;
      }
      setDestCreds(prev => ({
        ...prev,
        connectionName: intg.name,
        host: dbc.host || fm.pgHost || 'localhost',
        port: String(dbc.port || fm.pgPort || connectorMeta[destType]?.runtimeConfig?.defaultPort || ''),
        database: dbc.database || fm.pgDatabase || '',
        schema: dbc.schema || fm.pgSchema || connectorMeta[destType]?.runtimeConfig?.defaultSchema || '',
        username: dbc.username || '',
        password: dbc.password || '',
      }));
      setDestTestStatus('idle');
      setDestTestMsg(fm.destCredId
        ? 'Database destination + credentials loaded from saved connection'
        : 'Database destination loaded — re-enter username/password and save to store them');
    }

    // Pre-select project (Jira only)
    if (fm.projectKey) setSelectedProject(fm.projectKey);

    // Track which integration is loaded
    setActiveIntegrationId(intg.integrationId);
    setSaveStatus('idle');
    setSaveMsg('');
    setDeleteStatus('idle');

    // Move to step 2
    setWizardStep(2);
  };

  // ─── Navigation ──────────────────────────────────────────
  const goBack = () => setWizardStep(prev => Math.max(1, prev - 1));
  const goNext = () => {
    if (wizardStep === 1 && (!selectedSource || !selectedDest)) return;
    if (wizardStep === 2 && (srcTestStatus !== 'connected' || destTestStatus !== 'connected')) return;
    if (wizardStep === 3 && !selectedEntity) return;
    // Sync the destination table picker into destCreds for ALL sources (Jira, SharePoint,
    // and DB→DB / REST→DB). Without this, runtime sources left destCreds.table empty and
    // the push fell back to a 'rest_data' table — and the Quick View button stayed hidden.
    if (wizardStep === 3 && isDbDest(selectedDest)) {
      const tbl = createNewTable ? newTableName : selectedPgTable;
      if (tbl) setDestCreds(prev => ({ ...prev, table: tbl }));
      else if (!destCreds.table) return; // must pick/create a table (or already have one set)
    }
    if (wizardStep === 5 && fetchStatus !== 'done') return; // must fetch before push
    if (wizardStep === 6) { handlePush(); return; } // Step 6 button triggers push
    setWizardStep(prev => Math.min(6, prev + 1));
  };

  // ─── Step 5: Fetch source data ─────────────────────────
  const handleFetchData = async () => {
    setFetchStatus('fetching');
    setFetchError('');
    setFetchResult(null);
    try {
      if (selectedSource === 'Jira') {
        const { endpointUrl, email, apiToken } = srcCreds;
        const result = await api.fetchJiraIssues({
          endpointUrl, email, apiToken,
          projectKey: selectedProject,
          selectedEntities: [selectedEntity],
          dateFrom: dateStart,
          dateTo: dateEnd,
          saveConnection: true,
        });
        if (result.ok && result.data?.success) {
          const data = result.data.data;
          const runId = data?.runId;
          const issueEntity = data?.entities?.issues;
          const tickets = issueEntity?.records || [];
          const totalCount = issueEntity?.count ?? tickets.length;
          setFetchResult({ runId, tickets, totalCount });
          setFetchStatus('done');
        } else { setFetchError(result.data?.error || 'Fetch failed'); setFetchStatus('error'); }
      } else if (isSpSource(selectedSource)) {
        const result = await api.fetchSpItems({
          siteId: srcConnectionData?.siteId,
          listId: selectedEntity,
          tenantId: srcCreds.tenantId, clientId: srcCreds.clientId, clientSecret: srcCreds.clientSecret,
        });
        if (result.ok && result.data?.success) {
          const items = result.data.data?.items || [];
          setFetchResult({ runId: 'sp-fetch-' + Date.now(), tickets: items, totalCount: items.length });
          setFetchStatus('done');
        } else { setFetchError(result.data?.error || 'Fetch failed'); setFetchStatus('error'); }
      } else if (isRuntimeSource(selectedSource)) {
        const meta = connectorMeta[selectedSource];
        const result = await runtimeClient.fetch(meta.connectorId, meta.latestVersionId, selectedEntity, srcCreds);
        if (result.ok && result.data?.success) {
          const records = result.data.data?.records || [];
          setFetchResult({ runId: 'rest-fetch-' + Date.now(), tickets: records, totalCount: records.length });
          setFetchStatus('done');
        } else { setFetchError(result.data?.error || 'Fetch failed'); setFetchStatus('error'); }
      }
    } catch (err) {
      setFetchError('Network error during fetch');
      setFetchStatus('error');
    }
  };

  // ─── Step 6: Push to destination ───────────────────────
  // Server-side push (Wizard convergence): persist the recipe (mappings + key + date
  // window) and trigger run-integration so the BACKEND reads the source, maps each
  // record (shared MappingEngine), and busses it — only config crosses HTTP, so dataset
  // size is irrelevant (no more "payload too large"). Reuses pollRunStatus for the UI.
  const pushServerSide = async () => {
    pushStoppedRef.current = false; setStopping(false);
    setPushStatus('pushing'); setPushError(''); setPushResult(null); setPushProgress(null);
    try {
      const id = await handleSaveConnection(); // persists the recipe; returns integrationId
      if (!id) {
        setPushError('Could not save the connection before pushing — check the fields and that both sides are tested.');
        setPushStatus('error');
        return;
      }
      const res = await api.runIntegration(id);
      if (!res.ok || !res.data?.success) {
        setPushError(res.status === 0
          ? 'Cannot reach the server — the backend may be restarting. Wait a moment and try again.'
          : (res.data?.error || 'Failed to start the run'));
        setPushStatus('error');
        return;
      }
      const { runId, published, duplicate } = res.data.data;
      if (published === 0) {
        setPushResult({ pushRunId: runId, total: 0, status: 'success', created: 0, updated: 0, skipped: duplicate, failed: 0 });
        setPushStatus('done');
        return;
      }
      setPushResult({ pushRunId: runId, total: published, status: 'running', skipped: duplicate });
      setPushStatus('polling');
      pollRunStatus(runId, { skipped: duplicate });
    } catch {
      setPushError('Network error during push');
      setPushStatus('error');
    }
  };

  const handlePush = async () => {
    // Convergence (Phase 2): EVERY transform — DIRECT, PRESET, and custom-JS EXPRESSION
    // (run in the backend quickjs sandbox) — maps server-side. The Wizard always persists
    // the recipe and triggers run-integration; the dataset never crosses HTTP, so payload
    // size is irrelevant. The legacy client push handlers below
    // (handleSpDestPush / handleRestToDbPush / handleRestPush / handlePushToSharePoint /
    // mapRecordsToDest / deliverViaBus) are now unused — retained for reference, removable.
    await pushServerSide();
  };

  // ─── The single write path: publish already-mapped rows onto the Integration Bus ───
  // Every push handler funnels through here. The Wizard still fetches + transforms
  // CLIENT-side (presets/expressions/aggregations, previewed in Step 5); we hand the
  // finished destination rows to the bus, which owns delivery (idempotency, retry,
  // DLQ, run audit) to a generic database/sharepoint destination. Returns 202 + a
  // runId we poll for delivery counts.
  const deliverViaBus = async ({ destination, records, naturalKeyColumn, destTable, extra = {} }) => {
    pushStoppedRef.current = false; setStopping(false);
    setPushStatus('pushing'); setPushError(''); setPushResult(null); setPushProgress(null);
    try {
      if (!records.length || !records.some((r) => r && Object.keys(r).length)) {
        setPushError('Nothing to push — 0 mapped rows (or no mapping produced a value). Re-fetch in Step 5 and check your mappings.');
        setPushStatus('error');
        return;
      }
      const res = await api.publishRecords({
        destination, records,
        naturalKeyColumn: naturalKeyColumn || undefined,
        destTable, event: 'created',
      });
      if (!res.ok || !res.data?.success) {
        // Distinguish unreachable (status 0), too-large (413), and a real bus rejection.
        setPushError(
          res.status === 0
            ? 'Cannot reach the server — the backend may be restarting. Wait a moment and try again.'
            : res.status === 413
              ? 'This dataset is too large for one request. Narrow the date range (or push in smaller batches) and try again.'
              : (res.data?.error || 'Failed to publish to the bus'),
        );
        setPushStatus('error');
        return;
      }
      const { runId, published, duplicate } = res.data.data;
      if (published === 0) {
        // Whole batch was an unchanged duplicate (idempotent re-run) — nothing to deliver.
        setPushResult({ pushRunId: runId, total: 0, status: 'success', created: 0, updated: 0, skipped: duplicate, failed: 0, ...extra });
        setPushStatus('done');
        return;
      }
      setPushResult({ pushRunId: runId, total: published, status: 'running', skipped: duplicate, ...extra });
      setPushStatus('polling');
      pollRunStatus(runId, { skipped: duplicate, ...extra });
    } catch { setPushError('Network error during push'); setPushStatus('error'); }
  };

  // Poll /api/hub/run-status until every published record reaches a terminal delivery
  // state. The bus reports delivered/failed (not insert-vs-update), so "delivered"
  // maps to the Inserted counter and failures point at the DLQ.
  const pollRunStatus = (runId, extra = {}) => {
    let attempts = 0;
    const maxAttempts = 120; // ~5 min at 2.5s
    const poll = async () => {
      if (pushStoppedRef.current) return; // stopped by the user — handleStopPush owns the UI now
      attempts++;
      const res = await api.getRunStatus(runId);
      const s = res.ok && res.data?.success ? res.data.data : null;
      if (s) {
        setPushProgress({ createdCount: s.delivered, updatedCount: 0, failedCount: s.failed });
        if (s.finished || attempts >= maxAttempts) {
          // Honor a force-terminated run's real status (cancelled = operator Stop / watchdog
          // timeout shows as 'error'); otherwise derive success/error from the counts.
          const finalStatus = s.status === 'cancelled' ? 'cancelled'
            : (s.failed > 0 && s.delivered === 0) || s.status === 'error' ? 'error'
            : 'success';
          setPushResult((prev) => ({ ...prev, status: finalStatus,
            created: s.delivered, updated: 0, failed: s.failed, errors: s.errors || prev?.errors || [], ...extra }));
          if (s.failed > 0) {
            const why = (s.errors && s.errors.length) ? ` First error: ${s.errors[0]}` : ' Check the DLQ on the Monitor page.';
            setPushError(`${s.delivered} delivered, ${s.failed} failed.${why}`);
          }
          setPushStatus('done');
          return;
        }
      }
      if (attempts < maxAttempts) setTimeout(poll, 2500);
    };
    setTimeout(poll, 1500);
  };

  // ─── Stop an in-flight push (cooperative cancel) ───────────
  // Tells the backend to stop queuing/delivering this run. Records already sent
  // to the destination are kept (idempotent upsert), so there are no duplicates.
  const handleStopPush = async () => {
    const runId = pushResult?.pushRunId;
    if (!runId || stopping) return;
    setStopping(true);
    pushStoppedRef.current = true; // halt the status poll
    try {
      await api.cancelRun(runId);
    } catch { /* best-effort — the run is flagged client-side regardless */ }
    const p = pushProgress || {};
    const delivered = (p.createdCount ?? 0) + (p.updatedCount ?? 0);
    setPushResult((prev) => ({ ...prev, status: 'cancelled', created: delivered, failed: p.failedCount ?? 0 }));
    setPushError('Push stopped. Records already sent were kept (upsert — no duplicates); the rest were not sent.');
    setPushStatus('done');
    setStopping(false);
  };

  // Generic "write mapped records into a SharePoint list" push (SP→SP, CSV→SP, REST→SP).
  // ensure-list creates the list if it doesn't exist and adds any mapped columns that
  // are missing; the rows are then delivered through the bus to the SharePoint dest.
  const handleSpDestPush = async () => {
    if (!fetchResult?.tickets?.length) { setPushError('No data fetched. Go back and fetch first.'); return; }
    const records = mapRecordsToDest();
    if (!records.some((r) => r && Object.keys(r).length)) {
      setPushError('Nothing to push — the source returned 0 rows (or no mapping produced a value). Re-fetch in Step 5 and check your mappings.');
      setPushStatus('error');
      return;
    }
    setPushStatus('pushing'); setPushError('');
    const cols = mappings.flatMap((m) => (m.destinations || []).map((d, j) => ({ name: d, type: (m.destTypes || [])[j] || 'text' }))).filter((c) => c.name);
    const ens = await api.call('/api/sharepoint/ensure-list', {
      siteUrl: destCreds.siteUrl, siteId: destConnectionData?.siteId, listName: destCreds.listName,
      columns: cols, tenantId: destCreds.tenantId, clientId: destCreds.clientId, clientSecret: destCreds.clientSecret,
    });
    if (!ens.ok || !ens.data?.success) { setPushError(ens.data?.error || 'Failed to create/prepare the destination list'); setPushStatus('error'); return; }
    // SharePoint items dedup by a key column; fall back to 'Title' when no ★ key is set.
    const spKey = effectiveKey || 'Title';
    await deliverViaBus({
      destination: {
        kind: 'sharepoint',
        config: { siteUrl: destCreds.siteUrl, listName: destCreds.listName, keyColumn: spKey },
        creds: { tenantId: destCreds.tenantId, clientId: destCreds.clientId, clientSecret: destCreds.clientSecret },
      },
      records,
      naturalKeyColumn: spKey,
      extra: { listCreated: ens.data.data.created, addedColumns: ens.data.data.addedColumns, listUrl: ens.data.data.webUrl },
    });
  };

  // Map the fetched source records to destination shape, APPLYING each mapping's
  // transform (DIRECT / preset / multi-source aggregation expression) — same logic
  // as the Step-5 preview. Handles multi-destination expressions (object result).
  const mapRecordsToDest = () => (fetchResult?.tickets || []).map((rec) => {
    const out = {};
    for (const m of mappings) {
      const dests = m.destinations || [];
      if (!dests.length || !(m.sources || []).length) continue;
      let val;
      try { val = computeMappedValue(m, rec); } catch { val = ''; }
      if (dests.length > 1 && val && typeof val === 'object' && !Array.isArray(val)) {
        for (const d of dests) out[d] = val[d];
      } else {
        out[dests[0]] = val;
      }
    }
    return out;
  });

  const handleRestPush = async () => {
    if (!fetchResult?.tickets?.length) { setPushError('No data fetched. Go back and fetch first.'); return; }
    const destMeta = connectorMeta[selectedDest];
    const entity = (destMeta?.entities || [])[0]?.key;
    const records = mapRecordsToDest();
    await deliverViaBus({
      destination: {
        kind: 'rest',
        config: { destEntity: entity, entity },
        creds: destCreds,
      },
      records,
      naturalKeyColumn: matchKey === '__append__' ? '' : (effectiveKey || undefined),
    });
  };

  const handleRestToDbPush = async () => {
    if (!fetchResult?.tickets?.length) { setPushError('No data fetched. Go back and fetch first.'); return; }
    const cfg = dbCfg(selectedDest);
    // Conn values may live on the saved/tested connection (SharePoint→DB) or
    // directly on the destination creds (REST→DB).
    const dbc = destConnectionData || destCreds;
    // Apply transforms client-side, then deliver the computed rows through the bus.
    const records = mapRecordsToDest();
    const table = destCreds.table || 'rest_data';
    const naturalKey = matchKey === '__append__' ? '' : (effectiveKey || undefined);
    await deliverViaBus({
      destination: {
        kind: 'database',
        config: {
          destType: cfg.engine, engine: cfg.engine,
          pgHost: dbc.host, pgPort: Number(dbc.port) || cfg.defaultPort,
          pgDatabase: dbc.database,
          pgSchema: cfg.hasSchema ? (dbc.schema || cfg.defaultSchema) : undefined,
          pgTable: table,
          naturalKeyColumn: naturalKey,
        },
        creds: { username: dbc.username, password: dbc.password },
      },
      records,
      naturalKeyColumn: naturalKey,
      destTable: table,
    });
  };

  const handleQuickView = async () => {
    setQuickViewLoading(true);
    setQuickViewError('');
    setQuickView(null);
    try {
      const cfg = dbCfg(selectedDest);
      const apiFn = (body) => api.call(cfg?.handlers?.quickView, body);
      const res = await apiFn({
        host: destCreds.host || 'localhost',
        port: Number(destCreds.port) || cfg.defaultPort,
        database: destCreds.database || 'synapse_db',
        username: destCreds.username || 'synapse',
        password: destCreds.password || 'synapse',
        schema: cfg.hasSchema ? (destCreds.schema || cfg.defaultSchema) : undefined,
        table: destCreds.table,
        limit: 50,
      });
      if (res.ok && res.data?.success) {
        setQuickView(res.data.data);
      } else {
        setQuickViewError(res.data?.error || 'Failed to query table');
      }
    } catch {
      setQuickViewError('Network error');
    } finally {
      setQuickViewLoading(false);
    }
  };

  // SharePoint-source → DB now flows through the same transform-aware path as every
  // other record source (handleRestToDbPush), so mapping presets AND aggregations
  // (sum/avg/min/max/count) are applied to the written rows. The old SP→DB endpoints
  // (api.pushToPg/pushToMysql/pushToMssql) re-read the list server-side and did a raw
  // column copy, which silently dropped every transform. The Step-5 fetch already
  // pages the full list, so routing through the records writer loses no data.
  const handlePushToPg = () => handleRestToDbPush();

  const handlePushToMysql = () => handleRestToDbPush();

  const handlePushToMssql = () => handleRestToDbPush();

  // Jira → SharePoint. The fetched Jira issues are mapped CLIENT-side (Step 4/5,
  // honouring the operator's custom field mappings), the list is ensured, then the
  // mapped SP rows are delivered through the bus — same single path as every other
  // push. Dedup/upsert is by the ★ key column (default 'Title').
  const handlePushToSharePoint = async () => {
    if (!fetchResult?.tickets?.length) { setPushError('No Jira data fetched. Go back and fetch first.'); return; }
    const records = mapRecordsToDest();
    if (!records.some((r) => r && Object.keys(r).length)) {
      setPushError('No mapped rows — map the Jira fields to SharePoint columns in Step 4, then re-check the Step 5 preview.');
      setPushStatus('error');
      return;
    }
    setPushStatus('pushing'); setPushError('');
    const { siteUrl, listName } = destCreds;
    const cols = mappings.flatMap((m) => (m.destinations || []).map((d, j) => ({ name: d, type: (m.destTypes || [])[j] || 'text' }))).filter((c) => c.name);
    // Ensure the list (and mapped columns) exist before delivering rows into it.
    const ens = await api.call('/api/sharepoint/ensure-list', {
      siteUrl, siteId: destConnectionData?.siteId, listName, columns: cols,
      tenantId: destCreds.tenantId, clientId: destCreds.clientId, clientSecret: destCreds.clientSecret,
    });
    if ((!ens.ok || !ens.data?.success) && spDestCreateNew) {
      setPushError(ens.data?.error || 'Failed to create the destination list');
      setPushStatus('error');
      return;
    }
    const spKey = effectiveKey || 'Title';
    await deliverViaBus({
      destination: {
        kind: 'sharepoint',
        config: { siteUrl, listName, keyColumn: spKey },
        creds: { tenantId: destCreds.tenantId, clientId: destCreds.clientId, clientSecret: destCreds.clientSecret },
      },
      records,
      naturalKeyColumn: spKey,
      extra: { listUrl: ens.ok && ens.data?.success ? ens.data.data.webUrl : null },
    });
  };

  /** Map SP field type string to PG column type for wizard mappings */
  function mapSpTypeToPgType(spType) {
    const map = { text: 'string', note: 'string', number: 'number', currency: 'number',
      dateTime: 'datetime', boolean: 'boolean', choiceSingle: 'string', choiceMulti: 'json',
      person: 'json', lookup: 'json', hyperlink: 'json', managedMetadata: 'string' };
    return map[spType] || 'string';
  }

  // ─── Credential handlers ────────────────────────────────
  const handleSrcCredChange = (key, val) => {
    updateSrcCred(key, val);
    if (srcTestStatus !== 'idle') { setSrcTestStatus('idle'); setSrcTestMsg(''); }
  };
  const handleDestCredChange = (key, val) => {
    updateDestCred(key, val);
    if (destTestStatus !== 'idle') { setDestTestStatus('idle'); setDestTestMsg(''); }
  };

  // Flat File upload — read the operator's file into srcCreds.fileContent
  // (text for CSV/TSV/JSON, base64 for XLSX) so the generic runtime can parse it.
  const handleFileUpload = (file) => {
    if (!file) return;
    const name = file.name.toLowerCase();
    const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls');
    const fmt = isXlsx ? 'XLSX' : name.endsWith('.json') ? 'JSON' : name.endsWith('.tsv') ? 'TSV' : 'CSV';
    const reader = new FileReader();
    reader.onload = () => {
      let content;
      if (isXlsx) {
        const bytes = new Uint8Array(reader.result);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        content = btoa(bin);
      } else {
        content = reader.result;
      }
      updateSrcCred('fileFormat', fmt);
      updateSrcCred('fileContent', content);
      setSrcTestStatus('idle'); setSrcTestMsg(`Loaded ${file.name} (${fmt})`);
    };
    if (isXlsx) reader.readAsArrayBuffer(file); else reader.readAsText(file);
  };

  const testSourceConnection = async () => {
    setSrcTestStatus('testing'); setSrcTestMsg('');
    try {
      if (selectedSource === 'Jira') {
        const { endpointUrl, email, apiToken } = srcCreds;
        if (!endpointUrl || !email || !apiToken) { setSrcTestStatus('error'); setSrcTestMsg('Please fill in all required fields'); return; }
        const result = await api.testJiraConnection(endpointUrl, email, apiToken);
        if (result.ok && result.data?.success) {
          setSrcTestStatus('connected');
          setSrcTestMsg(`Connected as ${result.data.data?.displayName || 'verified user'}`);
          setSrcConnectionData(result.data.data);
        } else { setSrcTestStatus('error'); setSrcTestMsg(result.data?.error || 'Connection failed'); }
      } else if (isSpSource(selectedSource)) {
        const { siteUrl } = srcCreds;
        if (!siteUrl) { setSrcTestStatus('error'); setSrcTestMsg('Please fill in the Site URL'); return; }
        const result = await api.testSpSource({ siteUrl, tenantId: srcCreds.tenantId, clientId: srcCreds.clientId, clientSecret: srcCreds.clientSecret });
        if (result.ok && result.data?.success) {
          setSrcTestStatus('connected');
          setSrcTestMsg(`Connected to "${result.data.data?.siteDisplayName}" (${result.data.data?.hostname})`);
          setSrcConnectionData(result.data.data);
        } else { setSrcTestStatus('error'); setSrcTestMsg(result.data?.error || 'Connection failed'); }
      } else if (isRuntimeSource(selectedSource)) {
        const meta = connectorMeta[selectedSource];
        const result = await runtimeClient.test(meta.connectorId, meta.latestVersionId, srcCreds);
        if (result.ok && result.data?.success) {
          const d = result.data.data || {};
          setSrcTestStatus('connected');
          setSrcTestMsg(`Connected${d.status ? ` (HTTP ${d.status})` : ''}${d.sampleCount != null ? ` — ${d.sampleCount} sample records` : ''}`);
          setSrcConnectionData(d);
        } else { setSrcTestStatus('error'); setSrcTestMsg(result.data?.error || result.data?.data?.message || 'Connection failed'); }
      } else { setSrcTestStatus('error'); setSrcTestMsg(`${selectedSource} not yet supported.`); }
    } catch { setSrcTestStatus('error'); setSrcTestMsg('Connection failed.'); }
  };

  const testDestConnection = async () => {
    setDestTestStatus('testing'); setDestTestMsg('');
    try {
      if (isSpSource(selectedDest)) {
        // SharePoint destination \u2014 only the SITE + Azure creds are needed here.
        // The target LIST is chosen in Step 3 (existing or create-new).
        const { siteUrl, tenantId, clientId, clientSecret } = destCreds;
        if (!siteUrl) { setDestTestStatus('error'); setDestTestMsg('Please fill in the Site URL'); return; }
        const site = await api.testSpSource({ siteUrl, tenantId, clientId, clientSecret });
        if (site.ok && site.data?.success) {
          setDestTestStatus('connected');
          setDestTestMsg(`Connected to "${site.data.data?.siteDisplayName}" \u2014 choose the list in the next step`);
          setDestConnectionData({ siteId: site.data.data?.siteId });
        } else { setDestTestStatus('error'); setDestTestMsg(site.data?.error || 'Connection failed'); }
      } else if (isDbDest(selectedDest)) {
        // Engine-based dispatch (NOT label) so cloned DB connectors test correctly.
        const cfg = dbCfg(selectedDest);
        const engine = cfg?.engine;
        const { host, port, database, username, password } = destCreds;
        if (!host || !database || !username) { setDestTestStatus('error'); setDestTestMsg('Please fill in Host, Database, and Username'); return; }
        const defPort = engine === 'mysql' ? 3306 : engine === 'sqlserver' ? 1433 : 5432;
        const p = Number(port) || defPort;
        const testFn = engine === 'mysql' ? api.testMysqlDest : engine === 'sqlserver' ? api.testMssqlDest : api.testPgDest;
        const result = await testFn({ host, port: p, database, username, password });
        if (result.ok && result.data?.data?.connectionOk) {
          const defSchema = engine === 'sqlserver' ? 'dbo' : 'public';
          setDestTestStatus('connected');
          setDestTestMsg(`Connected to ${host}:${p}/${database}`);
          setDestConnectionData({ host, port: p, database, username, password, schema: cfg?.hasSchema ? (destCreds.schema || defSchema) : undefined, table: destCreds.table });
        } else { setDestTestStatus('error'); setDestTestMsg('Connection failed \u2014 check credentials'); }
      } else if (isRest(selectedDest)) {
        const meta = connectorMeta[selectedDest];
        const result = await runtimeClient.test(meta.connectorId, meta.latestVersionId, destCreds);
        if (result.ok && result.data?.success) {
          const d = result.data.data || {};
          setDestTestStatus('connected');
          setDestTestMsg(`Connected${d.status ? ` (HTTP ${d.status})` : ''}`);
          setDestConnectionData({ ...destCreds });
        } else { setDestTestStatus('error'); setDestTestMsg(result.data?.error || result.data?.data?.message || 'Connection failed'); }
      } else { setDestTestStatus('error'); setDestTestMsg(`${selectedDest} not yet supported.`); }
    } catch { setDestTestStatus('error'); setDestTestMsg('Connection failed.'); }
  };

  const handleSourceSelect = (label) => {
    setSelectedSource(label); setSrcCreds({}); setSrcTestStatus('idle'); setSrcTestMsg(''); setSrcConnectionData(null);
    setActiveIntegrationId(null); setSaveStatus('idle'); setSaveMsg(''); setDeleteStatus('idle');
  };
  const handleDestSelect = (label) => {
    // Pre-fill defaults for the destination
    const fields = getFields(label);
    const defaults = {};
    fields.forEach(f => { if (f.defaultValue) defaults[f.key] = f.defaultValue; });
    setSelectedDest(label); setDestCreds(defaults); setDestTestStatus('idle'); setDestTestMsg(''); setDestConnectionData(null);
  };

  // ─── Save connection (upsert by endpoint URL) ──────────
  const handleSaveConnection = async () => {
    // Validate based on source type
    if (selectedSource === 'Jira' && (!srcCreds.endpointUrl || !srcCreds.email || !srcCreds.apiToken)) {
      setSaveMsg('Fill in all Jira credential fields first');
      setSaveStatus('error');
      return;
    }
    if (isSpSource(selectedSource) && !srcCreds.siteUrl) {
      setSaveMsg('Fill in the SharePoint Site URL first');
      setSaveStatus('error');
      return;
    }
    if (srcTestStatus !== 'connected' || destTestStatus !== 'connected') {
      setSaveMsg('Test both connections before saving');
      setSaveStatus('error');
      return;
    }
    setSaveStatus('saving');
    setSaveMsg('');
    try {
      const body = {
        // Re-saves update the SAME connection instead of creating duplicates as the
        // list/table/mappings change through the wizard.
        integrationId: activeIntegrationId || undefined,
        name: connectionName || `${selectedSource} → ${selectedDest}`,
        sourceType: selectedSource,
        destType: selectedDest,
        // Connector-registry pins (template-driven wizard)
        sourceConnectorId: connectorIdOf(selectedSource),
        destConnectorId: connectorIdOf(selectedDest),
        sourceConnectorVersionId: versionIdOf(selectedSource),
        destConnectorVersionId: versionIdOf(selectedDest),
        endpointUrl: srcCreds.endpointUrl || srcCreds.siteUrl || '',
        email: srcCreds.email || undefined,
        apiToken: srcCreds.apiToken || undefined,
        projectKey: selectedProject || undefined,
        siteUrl: isSpSource(selectedSource) ? srcCreds.siteUrl : (destCreds.siteUrl || undefined),
        listName: srcCreds.listName || destCreds.listName || undefined,
        // SharePoint Azure creds — stored encrypted with the connection (no env fallback)
        tenantId: srcCreds.tenantId || undefined,
        clientId: srcCreds.clientId || undefined,
        clientSecret: srcCreds.clientSecret || undefined,
        // SharePoint DESTINATION creds + site/list (when SharePoint is the destination)
        destTenantId: isSpSource(selectedDest) ? destCreds.tenantId || undefined : undefined,
        destClientId: isSpSource(selectedDest) ? destCreds.clientId || undefined : undefined,
        destClientSecret: isSpSource(selectedDest) ? destCreds.clientSecret || undefined : undefined,
        destSiteUrl: isSpSource(selectedDest) ? destCreds.siteUrl || undefined : undefined,
        destListName: isSpSource(selectedDest) ? destCreds.listName || undefined : undefined,
        // DB dest fields
        pgHost: destCreds.host || undefined,
        pgPort: destCreds.port || undefined,
        pgDatabase: destCreds.database || undefined,
        pgSchema: destCreds.schema || undefined,
        pgTable: destCreds.table || undefined,
        pgUsername: destCreds.username || undefined,
        pgPassword: destCreds.password || undefined,
        // Server-side mapping recipe (Wizard convergence): persist the mappings + dedup
        // key + date window so run-integration reads, maps, and busses without the
        // browser ever shipping the dataset.
        mappings,
        naturalKeyColumn: matchKey === '__append__' ? '' : (effectiveKey || undefined),
        dateFrom: dateStart || undefined,
        dateTo: dateEnd || undefined,
      };
      const res = await api.saveConnection(body);
      if (res.ok && res.data?.success) {
        const intg = res.data.data;
        setActiveIntegrationId(intg.integrationId);
        setSaveStatus('saved');
        setSaveMsg(res.data.updated
          ? 'Connection updated (existing connection for this URL was updated)'
          : 'Connection saved successfully');
        // Refresh saved connections list
        const connRes = await api.getSavedConnections();
        if (connRes.ok && connRes.data?.data) {
          setSavedConnections(connRes.data.data.filter(c => c.status === 'active'));
        }
        return intg.integrationId;
      } else {
        setSaveStatus('error');
        setSaveMsg(res.data?.error || 'Failed to save');
        return null;
      }
    } catch {
      setSaveStatus('error');
      setSaveMsg('Network error while saving');
      return null;
    }
  };

  // Auto-save the connection once a push succeeds, so every successful sync becomes a
  // reusable entry in "My Connections". Idempotent via the dedup on save-connection
  // (same source+destination updates the existing row instead of duplicating). Fires once
  // per push (tracked by pushRunId) and skips a total failure (0 written + failures).
  const autoSavedPushRef = useRef(null);
  useEffect(() => {
    if (pushStatus !== 'done' || !pushResult) return;
    if (pushResult.status === 'cancelled') return;           // a stopped push isn't a saved success
    const wrote = (pushResult.created || 0) + (pushResult.updated || 0);
    const failed = pushResult.failed || 0;
    if (wrote === 0 && failed > 0) return;                 // total failure -> don't save
    if (srcTestStatus !== 'connected' || destTestStatus !== 'connected') return;
    const key = pushResult.pushRunId || `${selectedSource}->${selectedDest}`;
    if (autoSavedPushRef.current === key) return;          // already auto-saved this push
    autoSavedPushRef.current = key;
    handleSaveConnection();
  }, [pushStatus, pushResult]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resume the wizard exactly where you left off — whether you bounced to the Mapping
  // Canvas (one-shot 'synapseWizardResume') or simply navigated away / refreshed and came
  // back (persistent WIZARD_STATE_KEY). Restores selections, mappings, fetched data AND an
  // in-flight push (re-attaching to its run-status poll). Runs once on mount.
  useEffect(() => {
    let raw = null, oneShot = false;
    try {
      raw = sessionStorage.getItem('synapseWizardResume');
      if (raw) oneShot = true;
      else raw = sessionStorage.getItem(WIZARD_STATE_KEY);
    } catch { /* ignore */ }
    if (!raw) { setHydrated(true); return; }
    if (oneShot) { try { sessionStorage.removeItem('synapseWizardResume'); } catch { /* ignore */ } }
    try {
      const s = JSON.parse(raw);
      if (s.selectedSource) setSelectedSource(s.selectedSource);
      if (s.selectedDest) setSelectedDest(s.selectedDest);
      setSrcCreds(s.srcCreds || {});
      setDestCreds(s.destCreds || {});
      setSrcConnectionData(s.srcConnectionData || null);
      setDestConnectionData(s.destConnectionData || null);
      setSrcTestStatus(s.srcTestStatus || 'idle');
      setDestTestStatus(s.destTestStatus || 'idle');
      if (s.selectedEntity) setSelectedEntity(s.selectedEntity);
      if (s.selectedProject) setSelectedProject(s.selectedProject);
      setSrcFields(s.srcFields || []);
      setDestFields(s.destFields || []);
      setMappings(s.mappings || []);
      if (s.fetchResult) setFetchResult(s.fetchResult);
      if (s.fetchStatus) setFetchStatus(s.fetchStatus);
      if (s.matchKey) setMatchKey(s.matchKey);
      if (s.connectionName) setConnectionName(s.connectionName);
      if (s.dateStart) setDateStart(s.dateStart);
      if (s.dateEnd) setDateEnd(s.dateEnd);
      if (s.selectedPgTable) setSelectedPgTable(s.selectedPgTable);
      if (typeof s.createNewTable === 'boolean') setCreateNewTable(s.createNewTable);
      if (s.newTableName) setNewTableName(s.newTableName);
      if (s.activeIntegrationId) setActiveIntegrationId(s.activeIntegrationId);
      // Push progress — so a return mid-push shows where it's at.
      if (s.pushResult) setPushResult(s.pushResult);
      if (s.pushError) setPushError(s.pushError);
      if (s.pushProgress) setPushProgress(s.pushProgress);
      if (s.pushStatus) setPushStatus(s.pushStatus);
      if (s.wizardStep) setWizardStep(s.wizardStep);
      // If a push was still in flight when we left, re-attach to its progress poll so it
      // resumes updating instead of sitting frozen.
      if (s.pushStatus === 'polling' && s.pushResult?.pushRunId) {
        pollRunStatus(s.pushResult.pushRunId);
      }
    } catch { /* ignore a corrupt snapshot */ }
    setHydrated(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Continuously persist the wizard session so navigating away / refreshing can resume it.
  // Gated on `hydrated` so the initial empty render never clobbers a saved snapshot before
  // the restore effect above has applied it (both run in one batched update on mount).
  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify({
        wizardStep, selectedSource, selectedDest, selectedEntity, selectedProject,
        srcCreds, destCreds, srcConnectionData, destConnectionData,
        srcTestStatus, destTestStatus, srcFields, destFields, mappings,
        fetchResult, fetchStatus, matchKey, connectionName, dateStart, dateEnd,
        selectedPgTable, createNewTable, newTableName, activeIntegrationId,
        pushStatus, pushResult, pushError, pushProgress,
      }));
    } catch { /* sessionStorage full / serialization issue — non-fatal */ }
  }, [
    hydrated,
    wizardStep, selectedSource, selectedDest, selectedEntity, selectedProject,
    srcCreds, destCreds, srcConnectionData, destConnectionData,
    srcTestStatus, destTestStatus, srcFields, destFields, mappings,
    fetchResult, fetchStatus, matchKey, connectionName, dateStart, dateEnd,
    selectedPgTable, createNewTable, newTableName, activeIntegrationId,
    pushStatus, pushResult, pushError, pushProgress,
  ]);

  // Clear the saved session and reset the wizard to a clean Step 1.
  const startOver = () => {
    try {
      sessionStorage.removeItem(WIZARD_STATE_KEY);
      sessionStorage.removeItem('synapseWizardResume');
    } catch { /* ignore */ }
    setSelectedSource(null); setSelectedDest(null);
    setSrcCreds({}); setDestCreds({});
    setSrcConnectionData(null); setDestConnectionData(null);
    setSrcTestStatus('idle'); setDestTestStatus('idle');
    setSrcTestMsg(''); setDestTestMsg('');
    setSelectedEntity(null); setSelectedProject('');
    setSrcFields([]); setDestFields([]); setMappings([]);
    setFetchResult(null); setFetchStatus('idle'); setFetchError('');
    setMatchKey(''); setConnectionName(''); setActiveIntegrationId(null);
    setSelectedPgTable(''); setCreateNewTable(false); setNewTableName('');
    setPushStatus('idle'); setPushResult(null); setPushError(''); setPushProgress(null);
    setWizardStep(1);
  };

  // ─── Hand off the current mapping to the Mapping Canvas ──
  const openInCanvas = async () => {
    let id = activeIntegrationId;
    if (!id) id = await handleSaveConnection(); // persist first so Canvas has a target
    // Snapshot the wizard so "Back to Wizard" returns to this exact stage.
    try {
      sessionStorage.setItem('synapseWizardResume', JSON.stringify({
        wizardStep, selectedSource, selectedDest, selectedEntity, selectedProject,
        srcCreds, destCreds, srcConnectionData, destConnectionData,
        srcTestStatus, destTestStatus, srcFields, destFields, mappings, fetchResult,
        activeIntegrationId: id || activeIntegrationId || null,
      }));
    } catch { /* ignore */ }
    navigate('/canvas', { state: { integrationId: id || null, srcFields, destFields, mappings } });
  };

  // ─── Delete saved connection ───────────────────────────
  const handleDeleteConnection = async () => {
    if (deleteStatus === 'idle') {
      setDeleteStatus('confirming');
      return;
    }
    if (deleteStatus !== 'confirming' || !activeIntegrationId) return;

    setDeleteStatus('deleting');
    try {
      const res = await api.deleteIntegration(activeIntegrationId);
      if (res.ok && res.data?.success) {
        setDeleteStatus('deleted');
        setActiveIntegrationId(null);
        setSaveStatus('idle');
        setSaveMsg('Connection deleted');
        // Clear loaded credential fields
        setSrcCreds({});
        setDestCreds({});
        setSrcTestStatus('idle');
        setSrcTestMsg('');
        setDestTestStatus('idle');
        setDestTestMsg('');
        // Refresh saved connections list
        const connRes = await api.getSavedConnections();
        if (connRes.ok && connRes.data?.data) {
          setSavedConnections(connRes.data.data.filter(c => c.status === 'active'));
        }
        // Don't strand the user on the now-deleted connection — take them to the
        // (refreshed) connections list where it's gone, after a brief confirmation.
        setTimeout(() => { setDeleteStatus('idle'); navigate('/connected'); }, 1000);
      } else {
        setDeleteStatus('idle');
        setSaveMsg(res.data?.error || 'Failed to delete');
        setSaveStatus('error');
      }
    } catch {
      setDeleteStatus('idle');
      setSaveMsg('Network error while deleting');
      setSaveStatus('error');
    }
  };

  // ─── Step 3: Load entities + projects when entering ─────
  useEffect(() => {
    if (wizardStep !== 3) return;

    if (selectedSource === 'Jira') {
      const loadProjects = async () => {
        const { endpointUrl, email, apiToken } = srcCreds;
        const result = await api.discoverProjects({ endpointUrl, email, apiToken });
        if (result.ok && result.data?.success) {
          setProjects(result.data.data || []);
          if (result.data.data?.length === 1) setSelectedProject(result.data.data[0].key);
        }
      };
      loadProjects();
    } else if (isSpSource(selectedSource)) {
      // Discover lists on the SP site — each list is an "entity"
      const loadLists = async () => {
        setEntitiesLoading(true);
        const result = await api.discoverSpLists({
          siteId: srcConnectionData?.siteId,
          tenantId: srcCreds.tenantId, clientId: srcCreds.clientId, clientSecret: srcCreds.clientSecret,
        });
        if (result.ok && result.data?.success) {
          const lists = (result.data.data?.lists || [])
            .filter(l => l.template === 'genericList')
            .map(l => ({ id: l.id, name: l.name, fieldCount: null, available: true }));
          setEntities(lists);
          setProjects([{ key: srcConnectionData?.siteDisplayName || 'Site', name: srcConnectionData?.siteDisplayName || 'SharePoint Site' }]);
          setSelectedProject(srcConnectionData?.siteDisplayName || 'Site');
          // Auto-select the list from siteUrl if listName was provided
          const listName = srcCreds.listName;
          if (listName) {
            const match = lists.find(l => l.name.toLowerCase() === listName.toLowerCase());
            if (match) setSelectedEntity(match.id);
          }
        }
        setEntitiesLoading(false);
        // DB destination tables are loaded by a separate effect (works for ALL sources).
      };
      loadLists();
    } else if (isDbSource(selectedSource)) {
      // DB source (DB->DB migration): list the real tables so the operator picks which
      // one to migrate, instead of a single generic "table" entity. Mirrors the
      // destination table picker, using the same listTables handler.
      const loadDbTables = async () => {
        const cfg = connectorMeta[selectedSource]?.runtimeConfig;
        // For a DB source the connection details live in srcCreds (the form). srcConnectionData
        // only holds the runtime test result {ok,message}, so don't use it here.
        const dbConn = srcCreds;
        if (!cfg?.handlers?.listTables || !dbConn.host || !dbConn.database) return;
        setEntitiesLoading(true);
        const dbResult = await api.call(cfg.handlers.listTables, {
          host: dbConn.host, port: Number(dbConn.port) || cfg.defaultPort,
          database: dbConn.database, username: dbConn.username, password: dbConn.password,
          schema: cfg.hasSchema ? (srcCreds.schema || cfg.defaultSchema) : undefined,
        });
        if (dbResult.ok && dbResult.data?.success) {
          const tables = (dbResult.data.data?.tables || []).map((t) => ({
            id: t.name, name: t.name, fieldCount: t.columnCount ?? null, available: true,
          }));
          setEntities(tables);
          setProjects([{ key: 'db', name: `${selectedSource} (${dbConn.database})` }]);
          setSelectedProject('db');
          if (srcCreds.table) { const m = tables.find((t) => t.name === srcCreds.table); if (m) setSelectedEntity(m.id); }
        }
        setEntitiesLoading(false);
      };
      loadDbTables();
    } else if (isRuntimeSource(selectedSource)) {
      // Generic-runtime source. Prefer the template's design-time entities; if it
      // has none (Flat File / Webhook / MQ define them at runtime), ask the runtime.
      const meta = connectorMeta[selectedSource];
      const applyEnts = (ents) => {
        setEntities(ents);
        setProjects([{ key: 'api', name: selectedSource }]);
        setSelectedProject('api');
        const def = ents.find((e) => e.defaultOn) || ents[0];
        if (def) setSelectedEntity(def.id);
      };
      const staticEnts = (meta?.entities || []).map((e) => ({
        id: e.key, name: e.name, fieldCount: (e.fields || []).length, available: true, defaultOn: e.defaultOn,
      }));
      if (staticEnts.length) {
        applyEnts(staticEnts);
      } else {
        setEntitiesLoading(true);
        runtimeClient.discoverEntities(meta?.connectorId, meta?.latestVersionId, srcCreds)
          .then((res) => {
            const disc = (res.ok && res.data?.success ? res.data.data : []) || [];
            applyEnts(disc.map((e) => ({ id: e.key, name: e.name, fieldCount: e.fieldCount ?? 0, available: true, defaultOn: true })));
          })
          .catch(() => { /* leave empty; user sees "no entities" */ })
          .finally(() => setEntitiesLoading(false));
      }
    }
  }, [wizardStep]);

  useEffect(() => {
    if (wizardStep !== 3 || !selectedProject) return;
    if (selectedSource !== 'Jira') return; // SP lists already loaded above
    const loadEntities = async () => {
      setEntitiesLoading(true);
      const { endpointUrl, email, apiToken } = srcCreds;
      const result = await api.discoverEntities({ endpointUrl, email, apiToken, projectKey: selectedProject });
      if (result.ok && result.data?.success) {
        setEntities(result.data.data?.entities || []);
        const issues = result.data.data?.entities?.find(e => e.id === 'issues');
        if (issues?.available) setSelectedEntity('issues');
      }
      setEntitiesLoading(false);
    };
    loadEntities();
  }, [wizardStep, selectedProject]);

  // ─── Step 3: Load destination SharePoint lists (any source → SP) ──
  useEffect(() => {
    if (wizardStep !== 3 || !isSpSource(selectedDest)) return;
    if (!destConnectionData?.siteId) return;
    (async () => {
      setSpDestListsLoading(true);
      const res = await api.discoverSpLists({
        siteId: destConnectionData.siteId,
        tenantId: destCreds.tenantId, clientId: destCreds.clientId, clientSecret: destCreds.clientSecret,
      });
      if (res.ok && res.data?.success) {
        setSpDestLists((res.data.data?.lists || []).filter((l) => l.template === 'genericList'));
      }
      setSpDestListsLoading(false);
    })();
  }, [wizardStep, selectedDest]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Step 3: Load destination DB tables (any source → DB) ──
  useEffect(() => {
    if (wizardStep !== 3 || !isDbDest(selectedDest)) return;
    const dbCfg = destConnectionData || destCreds;
    if (!dbCfg.host || !dbCfg.database) return;
    const cfg = connectorMeta[selectedDest]?.runtimeConfig;
    if (!cfg?.handlers?.listTables) return;
    (async () => {
      setPgTablesLoading(true);
      const dbResult = await api.call(cfg.handlers.listTables, {
        host: dbCfg.host, port: Number(dbCfg.port) || cfg.defaultPort,
        database: dbCfg.database, username: dbCfg.username, password: dbCfg.password,
        schema: cfg.hasSchema ? (destCreds.schema || cfg.defaultSchema) : undefined,
      });
      if (dbResult.ok && dbResult.data?.success) {
        const tables = dbResult.data.data?.tables || [];
        setPgTables(tables);
        if (destCreds.table) {
          const match = tables.find((t) => t.name === destCreds.table);
          if (match) setSelectedPgTable(match.name);
          else { setCreateNewTable(true); setNewTableName(destCreds.table); }
        }
      }
      setPgTablesLoading(false);
    })();
  }, [wizardStep, selectedDest]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Step 4: Load fields when entering ──────────────────
  useEffect(() => {
    if (wizardStep !== 4) return;
    const loadFields = async () => {
      setFieldsLoading(true);

      if (isRuntimeSource(selectedSource)) {
        // Generic-runtime source: prefer the entity's static field defs; if none
        // (Flat File / Webhook / MQ), infer from the runtime (parses the uploaded
        // file / last event / a peeked message).
        const meta = connectorMeta[selectedSource];
        const srcEnt = (meta?.entities || []).find((e) => e.key === selectedEntity);
        let sf = (srcEnt?.fields || []).map((f) => ({ name: f.name, displayName: f.displayName || f.name, type: f.type || 'string', required: !!f.required }));
        if (!sf.length) {
          const fres = await runtimeClient.discoverFields(meta?.connectorId, meta?.latestVersionId, srcCreds, selectedEntity);
          if (fres.ok && fres.data?.success) {
            sf = (fres.data.data || []).map((f) => ({ name: f.name, displayName: f.displayName || f.name, type: f.type || 'string', required: !!f.required }));
          }
        }
        setSrcFields(sf);

        if (isRest(selectedDest)) {
          const destEnt = (connectorMeta[selectedDest]?.entities || [])[0];
          setDestFields((destEnt?.fields || []).map((f) => ({ name: f.name, displayName: f.displayName || f.name, type: f.type || 'string', required: !!f.required })));
        } else if (isDbDest(selectedDest)) {
          // DB destination. If an EXISTING table is selected, show its real columns;
          // otherwise (new table) derive columns from the source (auto-created on push).
          const cfg = connectorMeta[selectedDest]?.runtimeConfig;
          const dbCfg = destConnectionData || destCreds;
          const targetTable = createNewTable ? newTableName : (selectedPgTable || destCreds.table);
          let loaded = false;
          if (!createNewTable && targetTable && cfg?.handlers?.columns && dbCfg.host && dbCfg.database) {
            const colRes = await api.call(cfg.handlers.columns, {
              host: dbCfg.host, port: Number(dbCfg.port) || cfg.defaultPort,
              database: dbCfg.database, username: dbCfg.username, password: dbCfg.password,
              schema: cfg.hasSchema ? (destCreds.schema || cfg.defaultSchema) : undefined,
              table: targetTable,
            });
            const cols = colRes.ok && colRes.data?.success && colRes.data.data?.exists ? (colRes.data.data.columns || []) : [];
            if (cols.length) {
              setDestFields(cols.map((c) => ({ name: c.name || c.columnName, displayName: c.displayName || c.name || c.columnName, type: c.type || c.dataType || 'string', required: !!c.required })));
              loaded = true;
            }
          }
          if (!loaded) {
            setDestFields(sf.map((f) => {
              const col = f.name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '').replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
              return { name: col, displayName: col, type: f.type, required: false };
            }));
          }
        } else if (isSpSource(selectedDest)) {
          if (spDestCreateNew) {
            // New list: mirror source fields into SP-SAFE column names (SharePoint internal
            // names can't contain spaces/symbols, e.g. "Incident ID" -> "IncidentID"), so the
            // created column and the written field match. Original name kept as the label.
            setDestFields(sf.map((f) => ({ name: spSafeColName(f.name), displayName: f.displayName || f.name, type: f.type || 'text', required: false })));
          } else {
            const destResult = await api.getSharePointListFields({ siteUrl: destCreds.siteUrl, listName: destCreds.listName, siteId: destConnectionData?.siteId });
            if (destResult.ok && destResult.data?.success) {
              setDestFields((destResult.data.data?.spFields || []).map((f) => ({ name: f.name, displayName: f.displayName || f.name, type: f.type || 'text', required: f.required || false })));
            }
          }
        }
        setFieldsLoading(false);
        return;
      }

      if (selectedSource === 'Jira' && selectedDest === 'SharePoint') {
        // Original Jira → SP flow
        const { endpointUrl, email, apiToken } = srcCreds;
        const { siteUrl, listName } = destCreds;
        const srcResult = await api.getEntityFields({ endpointUrl, email, apiToken, projectKey: selectedProject, entity: selectedEntity });
        const sf = (srcResult.ok && srcResult.data?.success) ? (srcResult.data.data?.fields || []) : [];
        setSrcFields(sf);
        if (spDestCreateNew) {
          // New list: there's no existing list to read columns from, so mirror the
          // source fields (SP-safe names) into the destination. Auto-Map then matches
          // them 1:1, and ensure-list creates these columns when we push.
          setDestFields(sf.map((f) => ({ name: spSafeColName(f.name), displayName: f.displayName || f.name, type: f.type || 'text', required: false })));
        } else {
          const destResult = await api.getSharePointListFields({ siteUrl, listName, siteId: destConnectionData?.siteId });
          if (destResult.ok && destResult.data?.success) {
            setDestFields((destResult.data.data?.spFields || []).map(f => ({
              name: f.name, displayName: f.displayName || f.name, type: f.type || 'text', required: f.required || false,
            })));
          }
        }
      } else if (selectedSource === 'Jira' && isDbDest(selectedDest)) {
        // Jira → relational DB. Source = Jira issue fields. Dest = an existing table's
        // columns (if one is chosen) or columns derived from the source fields
        // (snake_case) for a new table — the backend auto-creates/evolves it on push.
        const { endpointUrl, email, apiToken } = srcCreds;
        const srcResult = await api.getEntityFields({ endpointUrl, email, apiToken, projectKey: selectedProject, entity: selectedEntity });
        const sf = (srcResult.ok && srcResult.data?.success) ? (srcResult.data.data?.fields || []) : [];
        setSrcFields(sf);

        const cfg = connectorMeta[selectedDest]?.runtimeConfig;
        const dbConn = destConnectionData || destCreds;
        const targetTable = createNewTable ? newTableName : (selectedPgTable || destCreds.table);
        let loaded = false;
        if (!createNewTable && targetTable && cfg?.handlers?.columns && dbConn.host && dbConn.database) {
          const colRes = await api.call(cfg.handlers.columns, {
            host: dbConn.host, port: Number(dbConn.port) || cfg.defaultPort,
            database: dbConn.database, username: dbConn.username, password: dbConn.password,
            schema: cfg.hasSchema ? (destCreds.schema || cfg.defaultSchema) : undefined,
            table: targetTable,
          });
          const cols = colRes.ok && colRes.data?.success && colRes.data.data?.exists ? (colRes.data.data.columns || []) : [];
          if (cols.length) {
            setDestFields(cols.map((c) => ({ name: c.name || c.columnName, displayName: c.displayName || c.name || c.columnName, type: c.type || c.dataType || 'string', required: !!c.required })));
            loaded = true;
          }
        }
        if (!loaded) {
          // New table: derive snake_case columns from the Jira fields. Auto-Map matches
          // them 1:1 (normalised names), and the backend creates the table on push.
          // Jira object/array fields (status, assignee, labels, …) are auto-mapped to a
          // SCALAR (e.g. status.name), so land them in TEXT columns — typing them as
          // json/jsonb would reject the extracted string ("invalid input syntax for json").
          setDestFields(sf.map((f) => {
            const col = f.name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '').replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
            const type = (f.type === 'object' || f.type === 'array') ? 'string' : (f.type || 'string');
            return { name: col, displayName: col, type, required: false };
          }));
        }
      } else if (isSpSource(selectedSource) && (isDbDest(selectedDest))) {
        // SP → DB flow: source = SP list fields, dest = DB table columns (or empty for auto-create)
        const srcResult = await api.getSpListFields({
          siteId: srcConnectionData?.siteId, listId: selectedEntity,
          tenantId: srcCreds.tenantId, clientId: srcCreds.clientId, clientSecret: srcCreds.clientSecret,
        });
        if (srcResult.ok && srcResult.data?.success) {
          setSrcFields(srcResult.data.data?.fields || []);
        }

        // Try to load existing DB table columns (if table exists)
        const dbCfg = destConnectionData || destCreds;
        if (dbCfg.host && dbCfg.database && destCreds.table) {
          const cfg = connectorMeta[selectedDest]?.runtimeConfig;
          const colApiFn = (body) => api.call(cfg?.handlers?.columns, body);
          const destResult = await colApiFn({
            host: dbCfg.host, port: Number(dbCfg.port) || cfg.defaultPort,
            database: dbCfg.database, username: dbCfg.username, password: dbCfg.password,
            schema: cfg.hasSchema ? (destCreds.schema || cfg.defaultSchema) : undefined,
            table: destCreds.table,
          });
          if (destResult.ok && destResult.data?.success && destResult.data.data?.exists) {
            setDestFields(destResult.data.data.columns || []);
          } else {
            // Table doesn't exist yet — generate dest fields from source (auto-map)
            const spFields = srcResult?.data?.data?.fields || [];
            const autoDestFields = [
              { name: 'sp_item_id', displayName: 'sp_item_id', type: 'varchar', required: true },
              ...spFields.map(f => {
                const pgName = f.name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '').replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
                return { name: pgName, displayName: pgName, type: mapSpTypeToPgType(f.type), required: false };
              }),
              { name: 'sp_created_at', displayName: 'sp_created_at', type: 'timestamptz', required: false },
              { name: 'sp_modified_at', displayName: 'sp_modified_at', type: 'timestamptz', required: false },
            ];
            setDestFields(autoDestFields);
          }
        } else {
          // No table specified — generate from source
          const spFields = srcResult?.data?.data?.fields || [];
          const autoDestFields = [
            { name: 'sp_item_id', displayName: 'sp_item_id', type: 'varchar', required: true },
            ...spFields.map(f => {
              const pgName = f.name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '').replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_');
              return { name: pgName, displayName: pgName, type: mapSpTypeToPgType(f.type), required: false };
            }),
            { name: 'sp_created_at', displayName: 'sp_created_at', type: 'timestamptz', required: false },
            { name: 'sp_modified_at', displayName: 'sp_modified_at', type: 'timestamptz', required: false },
          ];
          setDestFields(autoDestFields);
        }
      } else if (isSpSource(selectedSource) && isSpSource(selectedDest)) {
        // SP → SP: load the SOURCE list's fields.
        const srcResult = await api.getSpListFields({
          siteId: srcConnectionData?.siteId, listId: selectedEntity,
          tenantId: srcCreds.tenantId, clientId: srcCreds.clientId, clientSecret: srcCreds.clientSecret,
        });
        const sf = (srcResult.ok && srcResult.data?.success) ? (srcResult.data.data?.fields || []) : [];
        setSrcFields(sf);
        if (spDestCreateNew) {
          // New list: SP-safe column names (no spaces/symbols), so the created column and the
          // written field match — e.g. "Incident ID" -> "IncidentID". Label keeps the original.
          setDestFields(sf.map((f) => ({ name: spSafeColName(f.name), displayName: f.displayName || f.name, type: f.type || 'text', required: false })));
        } else {
          const destResult = await api.getSharePointListFields({ siteUrl: destCreds.siteUrl, listName: destCreds.listName, siteId: destConnectionData?.siteId });
          if (destResult.ok && destResult.data?.success) {
            setDestFields((destResult.data.data?.spFields || []).map((f) => ({
              name: f.name, displayName: f.displayName || f.name, type: f.type || 'text', required: f.required || false,
            })));
          }
        }
      } else {
        // Fallback: try original Jira fields + SP columns
        const { endpointUrl, email, apiToken } = srcCreds;
        const { siteUrl, listName } = destCreds;
        const [srcResult, destResult] = await Promise.all([
          api.getEntityFields({ endpointUrl, email, apiToken, projectKey: selectedProject, entity: selectedEntity }),
          api.getSharePointListFields({ siteUrl, listName, siteId: destConnectionData?.siteId }),
        ]);
        if (srcResult.ok && srcResult.data?.success) setSrcFields(srcResult.data.data?.fields || []);
        if (destResult.ok && destResult.data?.success) {
          setDestFields((destResult.data.data?.spFields || []).map(f => ({
            name: f.name, displayName: f.displayName || f.name, type: f.type || 'text', required: f.required || false,
          })));
        }
      }

      setFieldsLoading(false);
    };
    loadFields();
  }, [wizardStep]);

  // ─── Identity / match key ───────────────────────────────
  // The starred mapping's destination column is the identity key used to dedupe &
  // upsert on every destination type (DB, SharePoint, REST). It reuses the existing
  // `matchKey` state so there's a single source of truth. When unset, the FIRST
  // mapping's destination acts as the key (preserving the old default); `__append__`
  // means "no key — insert every row as new".
  const effectiveKey = useMemo(() => {
    if (matchKey === '__append__') return '';
    if (matchKey) return matchKey;
    return mappings[0]?.destinations?.[0] || '';
  }, [matchKey, mappings]);

  const setMappingKey = useCallback((index) => {
    const dest = mappings[index]?.destinations?.[0];
    if (!dest) return;
    // Clicking the current key clears it (→ append mode); otherwise make it the key.
    setMatchKey((prev) => {
      const current = prev === '__append__' ? '' : (prev || mappings[0]?.destinations?.[0] || '');
      return current === dest ? '__append__' : dest;
    });
  }, [mappings]);

  // ─── Auto-map ───────────────────────────────────────────
  const handleAutoMap = useCallback(() => {
    const newMappings = autoMapFields(srcFields, destFields);
    setMappings(newMappings);
    setExpandedMapping(-1);
    // Default the identity key to the first mapped column (the old "first acts as id"
    // behaviour, now shown explicitly with a ★ and overridable per row).
    setMatchKey(newMappings[0]?.destinations?.[0] || '');
  }, [srcFields, destFields]);

  // ─── Mapping CRUD ───────────────────────────────────────
  const updateMapping = useCallback((index, updated) => {
    setMappings(prev => prev.map((m, i) => i === index ? updated : m));
  }, []);

  const removeMapping = useCallback((index) => {
    setMappings(prev => prev.filter((_, i) => i !== index));
    setExpandedMapping(-1);
  }, []);

  const addNewMapping = useCallback(() => {
    const newMapping = {
      id: `m${Date.now()}`,
      sources: [],
      destinations: [],
      srcTypes: [],
      destTypes: [],
      transform: 'DIRECT',
      preset: null,
      expression: '',
    };
    setMappings(prev => [...prev, newMapping]);
    setExpandedMapping(mappings.length);
  }, [mappings.length]);

  // Flush any new columns typed into mapping rows ("+ New column…") into the
  // destination pane so they show up on the right. The columns are physically
  // created at push time (ensure-list for SharePoint, dbMappings for databases);
  // this reflects them in the UI now so the mapping is visibly complete.
  const applyMappedColumns = useCallback(() => {
    setDestFields(prev => {
      const existing = new Set(prev.map(f => f.name));
      const seen = new Set();
      const additions = [];
      mappings.forEach(m => (m.destinations || []).forEach((d, j) => {
        const name = (d || '').trim();
        if (!name || existing.has(name) || seen.has(name)) return;
        seen.add(name);
        additions.push({ name, displayName: name, type: (m.destTypes || [])[j] || 'string', required: false, isNew: true });
      }));
      return additions.length ? [...prev, ...additions] : prev;
    });
  }, [mappings]);

  // ─── Filtered field lists for Step 4 ────────────────────
  const filteredSrc = useMemo(() => {
    if (!srcSearch) return srcFields;
    const q = srcSearch.toLowerCase();
    return srcFields.filter(f => f.name.toLowerCase().includes(q));
  }, [srcFields, srcSearch]);

  const filteredDest = useMemo(() => {
    if (!destSearch) return destFields;
    const q = destSearch.toLowerCase();
    return destFields.filter(f => f.name.toLowerCase().includes(q) || (f.displayName || '').toLowerCase().includes(q));
  }, [destFields, destSearch]);

  // Which fields are mapped?
  const mappedSrcNames = useMemo(() => new Set(mappings.flatMap(m => m.sources)), [mappings]);
  const mappedDestNames = useMemo(() => new Set(mappings.flatMap(m => m.destinations)), [mappings]);

  // Mapped destination columns that aren't yet shown in the right pane — the ones
  // "Apply changes" will flush in.
  const pendingNewCols = useMemo(() => {
    const existing = new Set(destFields.map(f => f.name));
    return [...mappedDestNames].filter(name => name && !existing.has(name));
  }, [mappedDestNames, destFields]);

  // Validation
  const requiredUnmapped = useMemo(() =>
    destFields.filter(f => f.required && !mappedDestNames.has(f.name)),
  [destFields, mappedDestNames]);

  const statusStyle = (status) => {
    if (status === 'connected') return { color: 'var(--success)', borderColor: 'var(--success)' };
    if (status === 'error') return { color: 'var(--error)', borderColor: 'var(--error)' };
    return undefined;
  };
  const statusLabel = (status) => {
    if (status === 'testing') return 'Testing...';
    if (status === 'connected') return '\u2713 Connected';
    if (status === 'error') return '\u2717 Failed';
    return '\u26A1 Test Connection';
  };

  const renderCredFields = (fields, creds, onChange) =>
    fields.map((f) =>
      f.type === 'password' ? (
        <PasswordField key={f.key} label={f.label} value={creds[f.key] || ''} onChange={(val) => onChange(f.key, val)} placeholder={f.placeholder} />
      ) : (
        <div className="form-group" key={f.key}>
          <label>{f.label}</label>
          <input type="text" value={creds[f.key] || ''} onChange={(e) => onChange(f.key, e.target.value)} placeholder={f.placeholder} />
        </div>
      )
    );

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Connection Wizard</div>
          <div className="page-subtitle">Build a new integration in 6 steps</div>
        </div>
      </div>

      {/* Stepper */}
      <div className="stepper" style={{ flexShrink: 0 }}>
        {stepLabels.map((label, i) => {
          const stepNum = i + 1;
          let cls = 'step';
          if (stepNum === wizardStep) cls += ' active';
          if (stepNum < wizardStep) cls += ' completed';
          return (
            <div key={stepNum} className={cls}>
              {stepNum > 1 && <div className="step-line"></div>}
              <div className="step-circle">
                {stepNum}
                <div className="step-label">{label}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Navigation — always visible below stepper */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8,
        padding: '10px 16px', marginTop: 20, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline" onClick={goBack} disabled={wizardStep === 1}>&larr; Back</button>
          <button className="btn btn-outline" onClick={startOver}
            title="Clear this wizard session and start a new connection"
            style={{ color: 'var(--text-dim)' }}>Start over</button>
        </div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-dim)' }}>
          Step {wizardStep} of 6: <strong>{stepLabels[wizardStep - 1]}</strong>
        </div>
        <button className="btn btn-primary" onClick={goNext}
          disabled={
            (wizardStep === 1 && (!selectedSource || !selectedDest)) ||
            (wizardStep === 2 && (srcTestStatus !== 'connected' || destTestStatus !== 'connected')) ||
            (wizardStep === 3 && !selectedEntity) ||
            (wizardStep === 3 && isSpSource(selectedDest) && !destCreds.listName) ||
            (wizardStep === 5 && fetchStatus !== 'done') ||
            (wizardStep === 6 && (pushStatus === 'pushing' || pushStatus === 'polling'))
          }>
          {wizardStep === 5 && fetchStatus !== 'done' ? 'Fetch First' :
           wizardStep === 6 ? (pushStatus === 'idle' ? `\u25B6 Push to ${selectedDest || 'Destination'}` : pushStatus === 'done' ? 'Done' : 'Pushing...') :
           'Next \u2192'}
        </button>
      </div>

      <div className="page-body" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Wizard content */}
      <div className="wizard-content" style={{ marginTop: 16, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>

        {/* ── Step 1: Select Systems ── */}
        {wizardStep === 1 && (
          <div className="wizard-step active" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Saved Connections */}
            {savedConnections.length > 0 && (
              <div className="card" style={{ marginBottom: 20, padding: 16, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: '1.1rem' }}>&#128279;</span>
                  <span style={{ fontWeight: 700, fontSize: '.95rem' }}>My Connections</span>
                  <span className="badge badge-success" style={{ fontSize: '.7rem' }}>{savedConnections.length} saved</span>
                  <input value={connSearch} onChange={(e) => setConnSearch(e.target.value)} placeholder="Search connections..."
                    style={{ marginLeft: 'auto', maxWidth: 240, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: '.82rem' }} />
                </div>
                <div style={{ display: 'flex', alignItems: 'stretch', gap: 6 }}>
                  <button
                    type="button"
                    className="conn-strip-arrow"
                    title="Scroll left"
                    aria-label="Scroll connections left"
                    disabled={!connScroll.left}
                    onClick={() => scrollConnStrip(-1)}
                  >&#8249;</button>
                  <div ref={connStripRef} className="conn-strip" onScroll={updateConnScroll} style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 2, flex: 1 }}>
                  {savedConnections.filter((intg) => {
                    const q = connSearch.trim().toLowerCase();
                    if (!q) return true;
                    const fm = intg.fieldMappings || {};
                    return [intg.name, fm.sourceType, fm.destType, fm.projectKey, fm.listName, fm.siteUrl, fm.endpointUrl].filter(Boolean).join(' ').toLowerCase().includes(q);
                  }).map((intg) => {
                    const fm = intg.fieldMappings || {};
                    return (
                      <div
                        key={intg.integrationId}
                        className="card"
                        data-conn-card
                        style={{
                          padding: '12px 14px', cursor: 'pointer', transition: 'all .15s',
                          border: '1px solid var(--border)', borderRadius: 8, flex: '0 0 240px',
                        }}
                        onClick={() => applySavedConnection(intg)}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; e.currentTarget.style.background = 'var(--primary-dim)'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = ''; }}
                      >
                        <div style={{ fontWeight: 600, fontSize: '.88rem', marginBottom: 4 }}>{intg.name}</div>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-secondary)', marginBottom: 4 }}>
                          {fm.sourceType || 'Jira'} <span style={{ color: 'var(--text-dim)' }}>&rarr;</span> {fm.destType || 'SharePoint'}
                        </div>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-dim)' }}>
                          {fm.projectKey && <span className="badge badge-primary" style={{ marginRight: 4, fontSize: '.62rem' }}>{fm.projectKey}</span>}
                          {fm.listName && <span>{fm.listName}</span>}
                        </div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-dim)', marginTop: 4 }}>
                          {hostnameOf(fm.siteUrl || fm.endpointUrl)}
                        </div>
                      </div>
                    );
                  })}
                  </div>
                  <button
                    type="button"
                    className="conn-strip-arrow"
                    title="Scroll right"
                    aria-label="Scroll connections right"
                    disabled={!connScroll.right}
                    onClick={() => scrollConnStrip(1)}
                  >&#8250;</button>
                </div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 8 }}>
                  Click a saved connection to auto-fill credentials and skip to Step 2. You can still change the project.
                </div>
              </div>
            )}
            {savedLoading && (
              <div style={{ marginBottom: 16, fontSize: '.82rem', color: 'var(--text-dim)' }}>Loading saved connections...</div>
            )}

            <div className="grid-2" style={{ gap: 24, flex: 1, minHeight: 240, gridTemplateRows: 'minmax(0, 1fr)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.95rem', flexShrink: 0 }}>&#9664; Source System</div>
                <input value={srcSysSearch} onChange={(e) => setSrcSysSearch(e.target.value)} placeholder="Search source systems..."
                  style={{ width: '100%', marginBottom: 10, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: '.82rem', flexShrink: 0 }} />
                <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                    {sourceCards.filter((c) => c.label.toLowerCase().includes(srcSysSearch.trim().toLowerCase())).map((c, i) => (
                      <div key={i} className="card connector-card"
                        style={{ padding: 14, borderColor: selectedSource === c.label ? 'var(--primary)' : undefined, borderWidth: selectedSource === c.label ? 2 : undefined }}
                        onClick={() => handleSourceSelect(c.label)}>
                        <div className="conn-icon"><ConnIcon icon={c.icon} size={26} /></div>
                        <div className="conn-label" style={{ fontSize: '.78rem' }}>{c.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.95rem', flexShrink: 0 }}>Destination System &#9654;</div>
                <input value={destSysSearch} onChange={(e) => setDestSysSearch(e.target.value)} placeholder="Search destination systems..."
                  style={{ width: '100%', marginBottom: 10, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: '.82rem', flexShrink: 0 }} />
                <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                    {destCards.filter((c) => c.label.toLowerCase().includes(destSysSearch.trim().toLowerCase())).map((c, i) => (
                      <div key={i} className="card connector-card"
                        style={{ padding: 14, borderColor: selectedDest === c.label ? 'var(--primary)' : undefined, borderWidth: selectedDest === c.label ? 2 : undefined }}
                        onClick={() => handleDestSelect(c.label)}>
                        <div className="conn-icon"><ConnIcon icon={c.icon} size={26} /></div>
                        <div className="conn-label" style={{ fontSize: '.78rem' }}>{c.label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            {(!selectedSource || !selectedDest) && (
              <div style={{ color: 'var(--text-dim)', fontSize: '.85rem', marginTop: 16, textAlign: 'center' }}>
                Select both a source and destination system to continue
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: Credentials ── */}
        {wizardStep === 2 && (
          <div className="wizard-step active">
            <div className="card" style={{ marginBottom: 16, padding: '12px 16px' }}>
              <label style={{ fontWeight: 600, fontSize: '.85rem' }}>Connection name</label>
              <input
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder={selectedSource && selectedDest ? `${selectedSource} → ${selectedDest}` : 'Name this integration'}
                style={{ width: '100%', marginTop: 6, padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: '.9rem' }}
              />
              <div style={{ fontSize: '.74rem', color: 'var(--text-dim)', marginTop: 4 }}>One name for this source → destination pipeline.</div>
            </div>
            <div className="grid-2" style={{ gap: 24 }}>
              <div className="card">
                <div style={{ fontWeight: 600, marginBottom: 12 }}>Source Credentials ({selectedSource})</div>
                {renderCredFields(getFields(selectedSource), srcCreds, handleSrcCredChange)}
                {isFlatFile(selectedSource) && (
                  <div className="form-group" style={{ marginTop: 8 }}>
                    <label>Upload file (CSV / TSV / JSON / XLSX)</label>
                    <input type="file" accept=".csv,.tsv,.json,.xlsx,.xls" onChange={(e) => handleFileUpload(e.target.files?.[0])} />
                    {srcCreds.fileContent && <div style={{ fontSize: '.72rem', color: 'var(--success)', marginTop: 4 }}>✓ File loaded ({srcCreds.fileFormat})</div>}
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                  <button className="btn btn-outline btn-sm" onClick={testSourceConnection} disabled={srcTestStatus === 'testing'} style={statusStyle(srcTestStatus)}>
                    {statusLabel(srcTestStatus)}
                  </button>
                  {srcTestMsg && <span style={{ fontSize: '.8rem', color: srcTestStatus === 'connected' ? 'var(--success)' : 'var(--error)', flex: 1 }}>{srcTestMsg}</span>}
                </div>
              </div>
              <div className="card">
                <div style={{ fontWeight: 600, marginBottom: 12 }}>Destination Credentials ({selectedDest})</div>
                {renderCredFields(getFields(selectedDest), destCreds, handleDestCredChange)}
                {isSpSource(selectedDest) && (
                  <div style={{ fontSize: '.76rem', color: 'var(--text-dim)', margin: '6px 0' }}>
                    You'll pick (or create) the destination list in the next step.
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                  <button className="btn btn-outline btn-sm" onClick={testDestConnection} disabled={destTestStatus === 'testing'} style={statusStyle(destTestStatus)}>
                    {statusLabel(destTestStatus)}
                  </button>
                  {destTestMsg && <span style={{ fontSize: '.8rem', color: destTestStatus === 'connected' ? 'var(--success)' : 'var(--error)', flex: 1 }}>{destTestMsg}</span>}
                </div>
              </div>
            </div>

            {/* ── Save / Delete connection bar ── */}
            <div className="card" style={{ marginTop: 16, padding: '12px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                {/* Save button */}
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSaveConnection}
                  disabled={saveStatus === 'saving' || srcTestStatus !== 'connected' || destTestStatus !== 'connected'}
                  style={{ minWidth: 140 }}
                >
                  {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : 'Save Connection'}
                </button>

                {/* Delete button — only show when a saved connection is loaded */}
                {activeIntegrationId && (
                  <button
                    className="btn btn-sm"
                    onClick={handleDeleteConnection}
                    disabled={deleteStatus === 'deleting'}
                    style={{
                      minWidth: 140,
                      background: deleteStatus === 'confirming' ? 'var(--error)' : 'transparent',
                      color: deleteStatus === 'confirming' ? '#fff' : 'var(--error)',
                      border: '1px solid var(--error)',
                    }}
                  >
                    {deleteStatus === 'deleting' ? 'Deleting...'
                      : deleteStatus === 'confirming' ? 'Click again to confirm'
                      : deleteStatus === 'deleted' ? 'Deleted'
                      : 'Delete Saved Connection'}
                  </button>
                )}

                {/* Status message */}
                {saveMsg && (
                  <span style={{
                    fontSize: '.8rem', flex: 1,
                    color: saveStatus === 'saved' || deleteStatus === 'deleted' ? 'var(--success)' : 'var(--error)',
                  }}>
                    {saveMsg}
                  </span>
                )}
              </div>
              <div style={{ fontSize: '.75rem', color: 'var(--text-dim)', marginTop: 6 }}>
                Save stores source and destination connection details. Same source URL will update the existing connection.
              </div>
            </div>

            {(srcTestStatus !== 'connected' || destTestStatus !== 'connected') && (
              <div style={{ color: 'var(--text-dim)', fontSize: '.85rem', marginTop: 16, textAlign: 'center' }}>
                Both connections must be tested successfully before proceeding
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Source Entity + Destination Table ── */}
        {wizardStep === 3 && (
          <div className="wizard-step active">
            <div className="entity-header-bar">
              <div>
                <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: 4 }}>
                  {isSpSource(selectedSource) ? 'Select Source List & Destination Table' : 'Choose what to sync'}
                </div>
                <div className="conn-summary">
                  <strong>{selectedSource}</strong> ({srcCreds.siteUrl || srcCreds.endpointUrl})
                  &nbsp;&rarr;&nbsp;
                  <strong>{selectedDest}</strong> ({destCreds.database || destCreds.listName || ''})
                </div>
              </div>
            </div>

            {/* Jira project selector (unchanged) */}
            {selectedSource === 'Jira' && projects.length > 1 && (
              <div className="form-group" style={{ maxWidth: 400, marginBottom: 16 }}>
                <label>Select Project</label>
                <select value={selectedProject} onChange={e => setSelectedProject(e.target.value)}>
                  <option value="">Choose a project...</option>
                  {projects.map(p => <option key={p.key} value={p.key}>{p.key} &mdash; {p.name}</option>)}
                </select>
              </div>
            )}
            {selectedSource === 'Jira' && projects.length === 1 && (
              <div style={{ marginBottom: 12, fontSize: '.85rem', color: 'var(--text-secondary)' }}>
                Project: <strong style={{ color: 'var(--text)' }}>{projects[0].key} &mdash; {projects[0].name}</strong>
              </div>
            )}

            {entitiesLoading ? (
              <div className="wizard-loader">
                <div className="loader-spinner"></div>
                <div className="loader-text">Loading {isSpSource(selectedSource) ? 'lists' : 'entities'} from {selectedSource}...</div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: (isDbDest(selectedDest) || isSpSource(selectedDest)) ? '1fr 1fr' : '1fr', gap: 20 }}>

                {/* ── LEFT: Source list/entity picker ── */}
                <div className="card" style={{ padding: 16 }}>
                  <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: 10 }}>
                    {isSpSource(selectedSource) ? `SharePoint Lists (${entities.length})` : `${selectedSource} Entities`}
                  </div>

                  {/* Search bar */}
                  <input
                    type="text"
                    placeholder={`Search ${isSpSource(selectedSource) ? 'lists' : 'entities'}...`}
                    value={entitySearch}
                    onChange={e => setEntitySearch(e.target.value)}
                    style={{ width: '100%', padding: '7px 12px', borderRadius: 6, border: '1px solid var(--border)', marginBottom: 10, fontSize: '.85rem' }}
                  />

                  {/* Scrollable list */}
                  <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                    {entities
                      .filter(ent => !entitySearch || ent.name.toLowerCase().includes(entitySearch.toLowerCase()))
                      .map(ent => (
                        <div
                          key={ent.id}
                          onClick={() => ent.available !== false && setSelectedEntity(ent.id)}
                          style={{
                            padding: '10px 14px',
                            cursor: ent.available !== false ? 'pointer' : 'default',
                            opacity: ent.available === false ? 0.4 : 1,
                            background: selectedEntity === ent.id ? 'var(--primary-dim)' : 'transparent',
                            borderBottom: '1px solid var(--border)',
                            borderLeft: selectedEntity === ent.id ? '3px solid var(--primary)' : '3px solid transparent',
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: selectedEntity === ent.id ? 700 : 500, fontSize: '.88rem' }}>{ent.name}</div>
                            <div style={{ fontSize: '.72rem', color: 'var(--text-dim)' }}>
                              {connectorMeta[selectedSource]?.entityDescriptions?.[ent.id] || (isSpSource(selectedSource) ? 'SharePoint List' : '')}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {ent.fieldCount && <span className="badge badge-neutral" style={{ fontSize: '.68rem' }}>{ent.fieldCount} cols</span>}
                            {selectedEntity === ent.id && <span style={{ color: 'var(--primary)', fontWeight: 700 }}>&#10003;</span>}
                          </div>
                        </div>
                      ))}
                    {entities.filter(ent => !entitySearch || ent.name.toLowerCase().includes(entitySearch.toLowerCase())).length === 0 && (
                      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: '.85rem' }}>
                        No matches for "{entitySearch}"
                      </div>
                    )}
                  </div>
                  {selectedEntity && (
                    <div style={{ marginTop: 8, fontSize: '.78rem', color: 'var(--success)', fontWeight: 600 }}>
                      &#10003; Selected: {entities.find(e => e.id === selectedEntity)?.name}
                    </div>
                  )}
                </div>

                {/* ── RIGHT: Destination table picker (PostgreSQL / MySQL) ── */}
                {(isDbDest(selectedDest)) && (
                  <div className="card" style={{ padding: 16 }}>
                    <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: 10 }}>
                      {selectedDest} Destination Table
                    </div>

                    {/* Toggle: existing vs new */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                      <button
                        className={`btn btn-sm ${!createNewTable ? 'btn-primary' : ''}`}
                        style={createNewTable ? { background: 'var(--bg-main)', border: '1px solid var(--border)' } : {}}
                        onClick={() => { setCreateNewTable(false); setNewTableName(''); }}
                      >
                        Existing Table ({pgTables.length})
                      </button>
                      <button
                        className={`btn btn-sm ${createNewTable ? 'btn-primary' : ''}`}
                        style={!createNewTable ? { background: 'var(--bg-main)', border: '1px solid var(--border)' } : {}}
                        onClick={() => { setCreateNewTable(true); setSelectedPgTable(''); }}
                      >
                        + Create New
                      </button>
                    </div>

                    {!createNewTable ? (
                      <>
                        {pgTablesLoading ? (
                          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)' }}>Loading tables...</div>
                        ) : (
                          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                            {pgTables.map(t => (
                              <div
                                key={t.name}
                                onClick={() => setSelectedPgTable(t.name)}
                                style={{
                                  padding: '10px 14px',
                                  cursor: 'pointer',
                                  background: selectedPgTable === t.name ? 'var(--primary-dim)' : 'transparent',
                                  borderBottom: '1px solid var(--border)',
                                  borderLeft: selectedPgTable === t.name ? '3px solid var(--primary)' : '3px solid transparent',
                                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                }}
                              >
                                <div>
                                  <div style={{ fontWeight: selectedPgTable === t.name ? 700 : 500, fontSize: '.88rem', fontFamily: 'monospace' }}>{t.name}</div>
                                </div>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <span className="badge badge-neutral" style={{ fontSize: '.68rem' }}>{t.columnCount} cols</span>
                                  {selectedPgTable === t.name && <span style={{ color: 'var(--primary)', fontWeight: 700 }}>&#10003;</span>}
                                </div>
                              </div>
                            ))}
                            {pgTables.length === 0 && (
                              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: '.85rem' }}>
                                No tables found in schema "{destCreds.schema || 'public'}"
                              </div>
                            )}
                          </div>
                        )}
                        {selectedPgTable && (
                          <div style={{ marginTop: 8, fontSize: '.78rem', color: 'var(--success)', fontWeight: 600 }}>
                            &#10003; Target: {destCreds.schema || 'public'}.{selectedPgTable}
                          </div>
                        )}
                      </>
                    ) : (
                      <div>
                        <div style={{ marginBottom: 8, fontSize: '.82rem', color: 'var(--text-secondary)' }}>
                          Enter a name for the new table. It will be auto-created with columns derived from the source.
                        </div>
                        <input
                          type="text"
                          placeholder="e.g. sp_invoice"
                          value={newTableName}
                          onChange={e => setNewTableName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: 'monospace', fontSize: '.9rem' }}
                        />
                        {newTableName && (
                          <div style={{ marginTop: 8, fontSize: '.78rem', color: 'var(--info)' }}>
                            Will create: <strong>{destCreds.schema || 'public'}.{newTableName}</strong> with columns from the selected source list
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ marginTop: 14, padding: '8px 12px', background: 'var(--info-dim)', border: '1px solid var(--info)', borderRadius: 6, fontSize: '.75rem', color: 'var(--info)' }}>
                      <strong>Smart Sync:</strong> Only changed columns are updated. If 100 rows are pushed and only 2 rows have changes in specific columns, only those 2 columns on those 2 rows are updated.
                    </div>
                  </div>
                )}

                {/* ── RIGHT: Destination list picker (SharePoint) ── */}
                {isSpSource(selectedDest) && (
                  <div className="card" style={{ padding: 16 }}>
                    <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: 10 }}>SharePoint Destination List</div>
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                      <button className={`btn btn-sm ${!spDestCreateNew ? 'btn-primary' : ''}`}
                        style={spDestCreateNew ? { background: 'var(--bg-main)', border: '1px solid var(--border)' } : {}}
                        onClick={() => { setSpDestCreateNew(false); setSpNewListName(''); }}>
                        Existing List ({spDestLists.length})
                      </button>
                      <button className={`btn btn-sm ${spDestCreateNew ? 'btn-primary' : ''}`}
                        style={!spDestCreateNew ? { background: 'var(--bg-main)', border: '1px solid var(--border)' } : {}}
                        onClick={() => { setSpDestCreateNew(true); updateDestCred('listName', ''); setDestConnectionData((d) => ({ ...(d || {}), listId: undefined })); }}>
                        + Create New
                      </button>
                    </div>
                    {!spDestCreateNew ? (
                      spDestListsLoading ? (
                        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)' }}>Loading lists...</div>
                      ) : (
                        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                          {spDestLists.map((l) => (
                            <div key={l.id}
                              onClick={() => { updateDestCred('listName', l.name); setDestConnectionData((d) => ({ ...(d || {}), listId: l.id })); }}
                              style={{ padding: '10px 14px', cursor: 'pointer', background: (destCreds.listName === l.name) ? 'var(--primary-dim)' : 'transparent', borderBottom: '1px solid var(--border)', borderLeft: (destCreds.listName === l.name) ? '3px solid var(--primary)' : '3px solid transparent', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div style={{ fontWeight: destCreds.listName === l.name ? 700 : 500, fontSize: '.88rem' }}>{l.name}</div>
                              {destCreds.listName === l.name && <span style={{ color: 'var(--primary)', fontWeight: 700 }}>&#10003;</span>}
                            </div>
                          ))}
                          {spDestLists.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: '.85rem' }}>No lists found on this site</div>}
                        </div>
                      )
                    ) : (
                      <div>
                        <div style={{ marginBottom: 8, fontSize: '.82rem', color: 'var(--text-secondary)' }}>
                          Enter a name for the new list. It will be auto-created with columns from your field mappings.
                        </div>
                        <input type="text" placeholder="e.g. Synced Products" value={spNewListName}
                          onChange={(e) => { setSpNewListName(e.target.value); updateDestCred('listName', e.target.value); }}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)', fontSize: '.9rem' }} />
                        {spNewListName && <div style={{ marginTop: 8, fontSize: '.78rem', color: 'var(--info)' }}>Will create list <strong>{spNewListName}</strong> with columns from the selected source.</div>}
                      </div>
                    )}
                    {destCreds.listName && (
                      <div style={{ marginTop: 8, fontSize: '.78rem', color: 'var(--success)', fontWeight: 600 }}>
                        &#10003; Destination: {destCreds.listName}{spDestCreateNew ? ' (new)' : ''}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Validation messages */}
            {!selectedEntity && entities.length > 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: '.85rem', marginTop: 16, textAlign: 'center' }}>
                {(isDbDest(selectedDest))
                  ? 'Select a source list and destination table to continue'
                  : 'Select an entity to continue'}
              </div>
            )}
          </div>
        )}

        {/* ── Step 4: Mapping ── */}
        {wizardStep === 4 && (
          <div className="wizard-step active">
            {fieldsLoading ? (
              <div className="wizard-loader">
                <div className="loader-spinner"></div>
                <div className="loader-text">Loading fields from {selectedSource} and {selectedDest}...</div>
              </div>
            ) : (
              <>
                <div className="mapper-toolbar">
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn btn-primary btn-sm" onClick={handleAutoMap}>Auto-Map</button>
                    <button className="btn btn-outline btn-sm" onClick={() => { setMappings([]); setExpandedMapping(-1); }}>Clear All</button>
                    <button className="btn btn-outline btn-sm" onClick={applyMappedColumns} disabled={pendingNewCols.length === 0}
                      title={pendingNewCols.length ? `Add ${pendingNewCols.length} new mapped column(s) to ${selectedDest}: ${pendingNewCols.join(', ')}` : 'No new columns to apply — every mapped column already exists on the right'}>
                      &#10003; Apply changes{pendingNewCols.length ? ` (${pendingNewCols.length})` : ''}
                    </button>
                    <button className="btn btn-outline btn-sm" onClick={openInCanvas} title="Open these fields + mappings in the full Mapping Canvas (AI auto-map, transforms)">&#10138; Edit in Mapping Canvas</button>
                  </div>
                  <div className="mapper-stats">
                    <strong>{mappings.length}</strong> mapped &nbsp;|&nbsp;
                    {requiredUnmapped.length > 0
                      ? <span style={{ color: 'var(--error)' }}>{requiredUnmapped.length} required unmapped</span>
                      : <span style={{ color: 'var(--success)' }}>All required columns mapped</span>
                    }
                    &nbsp;|&nbsp; {destFields.length - mappedDestNames.size} SP columns unmapped
                  </div>
                </div>

                {mappings.length > 0 && (
                  <div style={{ margin: '8px 0', padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 6, fontSize: '.78rem', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: 'var(--text-dim)' }}>
                    <span style={{ color: '#f59e0b', fontSize: '1rem' }}>★</span>
                    {effectiveKey
                      ? <span>Identity key: <code style={{ background: 'var(--bg-card)', padding: '1px 5px', borderRadius: 3 }}>{effectiveKey}</code> — records are deduped &amp; upserted by this column. Click the ★ on any mapping row to change it.</span>
                      : <span>No identity key set — every row is inserted as new. Click the ☆ on a mapping row to dedupe/upsert by that column.</span>}
                  </div>
                )}

                {isDbDest(selectedDest) && (
                  <div style={{ margin: '8px 0', padding: '10px 12px', background: 'var(--bg-main)', borderRadius: 6, fontSize: '.8rem', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600 }}>Match records by:</span>
                    <select value={matchKey === '__append__' ? '__append__' : effectiveKey} onChange={(e) => setMatchKey(e.target.value)} style={{ minWidth: 220 }}>
                      <option value="__append__">Append every row (no matching — each row is new)</option>
                      {mappings.flatMap((m) => m.destinations || []).filter((d, i, a) => d && a.indexOf(d) === i).map((d) => (
                        <option key={d} value={d}>Match by “{d}” (update if exists, else insert)</option>
                      ))}
                    </select>
                    <span style={{ color: 'var(--text-dim)', fontSize: '.74rem' }}>
                      New tables get an auto-increment <code>id</code> primary key automatically.
                    </span>
                  </div>
                )}

                <div className="mapper-layout">
                  {/* Left: Source fields */}
                  <div className="mapper-col">
                    <div className="mapper-col-header">
                      <span className="col-title">
                        <span style={{ color: 'var(--primary)' }}>{selectedSource}</span> Fields
                      </span>
                      <span className="col-count">{srcFields.length}</span>
                    </div>
                    <div className="mapper-search">
                      <input placeholder="Search fields..." value={srcSearch} onChange={e => setSrcSearch(e.target.value)} />
                    </div>
                    <div className="mapper-list">
                      {filteredSrc.map(f => (
                        <div key={f.name} className={`field-item${mappedSrcNames.has(f.name) ? ' mapped' : ''}`}
                          title={`${f.name} (${f.type})`}>
                          <span className="map-indicator"></span>
                          <span className="field-name">{f.name}</span>
                          <span className="field-type-tag">{f.type}</span>
                        </div>
                      ))}
                      {filteredSrc.length === 0 && <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: '.82rem' }}>No fields match</div>}
                    </div>
                  </div>

                  {/* Center: Mapping rows */}
                  <div className="mapper-col">
                    <div className="mapper-col-header">
                      <span className="col-title">Mappings</span>
                      <span className="col-count">{mappings.length}</span>
                    </div>
                    <div className="mapping-rows">
                      {mappings.length === 0 && (
                        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: '.85rem' }}>
                          <div style={{ fontSize: '2rem', marginBottom: 8 }}>&#8621;</div>
                          Click <strong>Auto-Map</strong> to match fields automatically,<br />or add mappings manually below.
                        </div>
                      )}
                      {mappings.map((m, i) => (
                        <MappingRow
                          key={m.id}
                          mapping={m}
                          index={i}
                          srcFields={srcFields}
                          destFields={destFields}
                          allowNewDest={isSpSource(selectedDest) || (isDbDest(selectedDest) && createNewTable)}
                          isKey={!!effectiveKey && (m.destinations || []).includes(effectiveKey)}
                          onSetKey={() => setMappingKey(i)}
                          onUpdate={(updated) => updateMapping(i, updated)}
                          onRemove={() => removeMapping(i)}
                          expanded={expandedMapping === i}
                          onToggle={() => setExpandedMapping(expandedMapping === i ? -1 : i)}
                        />
                      ))}
                    </div>
                    <div className="add-mapping-area">
                      <button className="add-mapping-btn" onClick={addNewMapping}>
                        + Add Manual Mapping
                      </button>
                    </div>
                  </div>

                  {/* Right: Destination columns */}
                  <div className="mapper-col">
                    <div className="mapper-col-header">
                      <span className="col-title">
                        <span style={{ color: 'var(--success)' }}>{selectedDest}</span> Columns
                      </span>
                      <span className="col-count">{destFields.length}</span>
                    </div>
                    <div className="mapper-search">
                      <input placeholder="Search columns..." value={destSearch} onChange={e => setDestSearch(e.target.value)} />
                    </div>
                    <div className="mapper-list">
                      {filteredDest.map(f => (
                        <div key={f.name} className={`field-item${mappedDestNames.has(f.name) ? ' mapped' : ''}`}
                          title={`${f.name} (${f.type})${f.required ? ' - Required' : ''}`}>
                          <span className="map-indicator"></span>
                          <span className="field-name">{f.displayName || f.name}</span>
                          <span className="field-type-tag">{f.type}</span>
                          {f.isNew && <span className="field-type-tag" style={{ background: 'var(--primary-dim)', color: 'var(--primary)' }} title="Will be created on push">new</span>}
                          {f.required && <span className="field-required">*</span>}
                        </div>
                      ))}
                      {filteredDest.length === 0 && <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: '.82rem' }}>No columns match</div>}
                    </div>
                  </div>
                </div>

                {/* Validation summary */}
                {mappings.length > 0 && (
                  <div className={`mapping-validation ${requiredUnmapped.length > 0 ? 'error' : 'valid'}`}>
                    <span className="val-icon">{requiredUnmapped.length > 0 ? '\u26A0' : '\u2713'}</span>
                    <div className="val-text">
                      <strong>{mappings.length} field{mappings.length !== 1 ? 's' : ''} mapped</strong>
                      {requiredUnmapped.length > 0
                        ? `Required columns not mapped: ${requiredUnmapped.map(f => f.displayName || f.name).join(', ')}`
                        : `${destFields.length - mappedDestNames.size} destination columns unmapped (will be left empty). ${srcFields.length - mappedSrcNames.size} source fields unused.`
                      }
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── Step 5: Fetch & Review ── */}
        {wizardStep === 5 && (
          <div className="wizard-step active">
            <div style={{ fontWeight: 600, marginBottom: 16, fontSize: '1rem' }}>Fetch {selectedSource} Data</div>

            <div className="grid-2" style={{ gap: 24 }}>
              {/* Left: Config */}
              <div className="card" style={{ padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.9rem' }}>Fetch Configuration</div>
                <div className="form-group">
                  <label>Project</label>
                  <input type="text" value={selectedProject} readOnly style={{ background: 'var(--bg-main)' }} />
                </div>
                <div className="form-group">
                  <label>{isSpSource(selectedSource) ? 'List' : 'Entity'}</label>
                  <input type="text" value={isSpSource(selectedSource) ? (entities.find(e => e.id === selectedEntity)?.name || selectedEntity) : (selectedEntity || '')} readOnly style={{ background: 'var(--bg-main)' }} />
                </div>
                {selectedSource !== 'SharePoint' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group">
                      <label>Date Start</label>
                      <input type="date" value={dateStart} onChange={e => setDateStart(e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label>Date End</label>
                      <input type="date" value={dateEnd} onChange={e => setDateEnd(e.target.value)} />
                    </div>
                  </div>
                )}
                {isSpSource(selectedSource) && (
                  <div style={{ padding: '8px 12px', background: 'var(--info-dim)', border: '1px solid var(--info)', borderRadius: 6, fontSize: '.78rem', color: 'var(--info)', marginBottom: 8 }}>
                    All items from the SharePoint list will be fetched (delta query).
                  </div>
                )}
                <div className="form-group" style={{ marginTop: 4 }}>
                  <label style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>
                    {mappings.length} field mappings configured &middot; {selectedSource} &rarr; {destCreds.table || destCreds.listName || selectedDest}
                  </label>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleFetchData}
                  disabled={fetchStatus === 'fetching'}
                  style={{ marginTop: 8, width: '100%' }}
                >
                  {fetchStatus === 'fetching' ? 'Fetching...' : fetchStatus === 'done' ? 'Re-fetch' : `Fetch ${selectedSource} Data`}
                </button>
                {fetchError && (
                  <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--error-dim)', border: '1px solid var(--error)', borderRadius: 6, fontSize: '.82rem', color: 'var(--error)' }}>
                    {fetchError}
                  </div>
                )}
              </div>

              {/* Right: Results */}
              <div className="card" style={{ padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.9rem' }}>Fetch Results</div>
                {fetchStatus === 'idle' && (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
                    <div style={{ fontSize: '2rem', marginBottom: 8 }}>&#128269;</div>
                    <div style={{ fontSize: '.88rem' }}>Configure date range and click Fetch to pull Jira issues.</div>
                  </div>
                )}
                {fetchStatus === 'fetching' && (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
                    <div style={{ fontSize: '2rem', marginBottom: 8, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>&#9696;</div>
                    <div style={{ fontSize: '.88rem', marginTop: 8 }}>Pulling issues from {selectedProject}...</div>
                  </div>
                )}
                {fetchStatus === 'done' && fetchResult && (
                  <div>
                    <div style={{ padding: '10px 14px', background: 'var(--success-dim)', border: '1px solid var(--success)', borderRadius: 8, marginBottom: 12 }}>
                      <div style={{ fontWeight: 700, color: 'var(--success)', fontSize: '.88rem' }}>
                        &#9989; Fetched {fetchResult.totalCount} {isSpSource(selectedSource) ? 'items' : selectedSource === 'Jira' ? 'issues' : 'records'}
                      </div>
                      <div style={{ fontSize: '.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                        Run ID: <span style={{ fontFamily: 'monospace' }}>{fetchResult.runId}</span>
                      </div>
                    </div>
                    <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>
                      Preview (first {Math.min(5, fetchResult.tickets.length)} of {fetchResult.totalCount})
                    </div>
                    <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.78rem' }}>
                        <thead>
                          <tr style={{ background: 'var(--bg-main)' }}>
                            {isSpSource(selectedSource) ? (
                              <>
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Item ID</th>
                                {srcFields.slice(0, 3).map(f => (
                                  <th key={f.name} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{f.displayName || f.name}</th>
                                ))}
                              </>
                            ) : selectedSource === 'Jira' ? (
                              <>
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Key</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Summary</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Status</th>
                              </>
                            ) : (
                              // Generic source (REST/DB/…): columns from the actual record keys.
                              <>
                                {Object.keys(fetchResult.tickets[0] || {}).slice(0, 5).map((c) => (
                                  <th key={c} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>{c}</th>
                                ))}
                              </>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {fetchResult.tickets.slice(0, 5).map((t, i) => (
                            <tr key={i}>
                              {isSpSource(selectedSource) ? (
                                <>
                                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                                    {t.spItemId || t.id || '--'}
                                  </td>
                                  {srcFields.slice(0, 3).map(f => (
                                    <td key={f.name} style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                                      {String(t.fields?.[f.name] ?? '').substring(0, 50)}
                                    </td>
                                  ))}
                                </>
                              ) : selectedSource === 'Jira' ? (
                                <>
                                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                                    {t.key || t.issueKey || '--'}
                                  </td>
                                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                                    {(t.fields?.summary || t.summary || '').substring(0, 60)}
                                  </td>
                                  <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                                    {t.fields?.status?.name || t.status || '--'}
                                  </td>
                                </>
                              ) : (
                                // Generic source: show the same record keys as the header.
                                <>
                                  {Object.keys(fetchResult.tickets[0] || {}).slice(0, 5).map((c) => (
                                    <td key={c} style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                                      {String(t[c] ?? '').substring(0, 50)}
                                    </td>
                                  ))}
                                </>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ marginTop: 12, fontSize: '.82rem', color: 'var(--text-secondary)' }}>
                      {(isDbDest(selectedDest)) ? (
                        <>Click <strong>Next</strong> to push {fetchResult.totalCount} records to <strong>{destCreds.table || 'auto-generated table'}</strong> in {selectedDest}. Table is auto-created if it doesn't exist. Existing rows updated by {mappings[0]?.destinations?.[0] || 'key'}.</>
                      ) : (
                        <>Click <strong>Next</strong> to push these {fetchResult.totalCount} records to <strong>{destCreds.listName || destCreds.table || selectedDest}</strong>. Existing records are updated by {mappings[0]?.destinations?.[0] || 'key'}; new ones are created.</>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 6: Push & Sync ── */}
        {wizardStep === 6 && (
          <div className="wizard-step active">
            <div style={{ fontWeight: 600, marginBottom: 16, fontSize: '1rem' }}>Push to {selectedDest}</div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Config + Status row */}
              <div style={{ display: 'grid', gridTemplateColumns: pushStatus !== 'idle' || !fetchResult?.tickets?.length ? '1fr 1fr' : '1fr', gap: 16 }}>
              <div className="card" style={{ padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.9rem' }}>Push Configuration</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Source:</span> <strong>{selectedProject || selectedSource}</strong> ({fetchResult?.totalCount || 0} records)</div>
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Destination:</span> <strong>{destCreds.table || destCreds.listName || selectedDest}</strong> ({selectedDest})</div>
                  {destCreds.siteUrl && <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Site:</span> <span style={{ fontSize: '.82rem', wordBreak: 'break-all' }}>{destCreds.siteUrl}</span></div>}
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Mappings:</span> {mappings.length} fields</div>
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Mode:</span> {matchKey === '__append__'
                    ? <><strong>Append</strong> (every row inserted as new)</>
                    : <><strong>Upsert</strong> (update by {matchKey || mappings[0]?.destinations?.[0] || 'key'}, create if new)</>}</div>
                  {dateStart && dateEnd && <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Date Range:</span> {dateStart} &rarr; {dateEnd}</div>}
                </div>
                <div style={{ marginTop: 14, padding: '8px 12px', background: 'var(--info-dim)', border: '1px solid var(--info)', borderRadius: 6, fontSize: '.78rem', color: 'var(--info)' }}>
                  {matchKey === '__append__'
                    ? <><strong>Append:</strong> Every record is inserted as a new row (no matching). The auto-increment <code style={{ background: 'var(--bg-main)', padding: '1px 4px', borderRadius: 3 }}>id</code> keeps rows unique.</>
                    : <><strong>Dedup:</strong> Each record is matched by the <code style={{ background: 'var(--bg-main)', padding: '1px 4px', borderRadius: 3 }}>{matchKey || mappings[0]?.destinations?.[0] || 'key'}</code> column. If a row with the same key already exists in {selectedDest}, it is <strong>updated</strong>; otherwise a new row is created. No duplicates.</>}
                </div>
              </div>

              {/* Middle: Transformation Preview */}
              {fetchResult?.tickets?.length > 0 && pushStatus === 'idle' && (
                <div className="card" style={{ padding: 20, gridColumn: '1 / -1', marginBottom: 0 }}>
                  <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.9rem' }}>
                    Transformation Preview &mdash; What goes to SharePoint
                  </div>
                  <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 10 }}>
                    Showing transformed output for the first {Math.min(3, fetchResult.tickets.length)} of {fetchResult.totalCount} records using your {mappings.length} mapping rules.
                  </div>
                  <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.76rem' }}>
                      <thead>
                        <tr style={{ background: 'var(--bg-main)', position: 'sticky', top: 0 }}>
                          <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>#</th>
                          {mappings.map((m, i) => (
                            <th key={i} style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                              <span title={`${m.sources.join('+')} \u2192 ${m.destinations.join('+')}`}>
                                {m.destinations[0] || '?'}
                              </span>
                              <div style={{ fontSize: '.65rem', color: m.transform === 'DIRECT' ? 'var(--success)' : m.transform === 'EXPRESSION' ? 'var(--warning)' : 'var(--info)', fontWeight: 400 }}>
                                {m.transform === 'DIRECT' ? 'Direct' : m.preset ? m.preset : 'JS Expr'}
                              </div>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {fetchResult.tickets.slice(0, 3).map((ticket, rowIdx) => {
                          // Use the SAME evaluator as the push so preview == what's written
                          // (includes sum/avg/min/max/count + type casts).
                          const applyTransform = (m, t) => {
                            try {
                              const v = computeMappedValue(m, t);
                              return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
                            } catch (e) { return `ERR: ${e.message}`; }
                          };

                          return (
                            <tr key={rowIdx} style={{ borderBottom: '1px solid var(--border)' }}>
                              <td style={{ padding: '4px 8px', fontFamily: 'monospace', color: 'var(--text-dim)' }}>
                                {ticket.key || ticket.issueKey || rowIdx + 1}
                              </td>
                              {mappings.map((m, colIdx) => {
                                const val = applyTransform(m, ticket);
                                const truncated = String(val).length > 40 ? String(val).substring(0, 40) + '...' : val;
                                return (
                                  <td key={colIdx} style={{ padding: '4px 8px', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={String(val)}>
                                    {truncated || <span style={{ color: 'var(--text-dim)' }}>(empty)</span>}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 6 }}>
                    Note: The actual push uses the server-side 35-field mapper for all columns. This preview shows your custom mapping transforms.
                  </div>
                </div>
              )}

              {/* DDL Preview — Database destination schema diff */}
              {ddlPreview && ddlPreview.requiresApproval && ddlStatus !== 'applied' && (
                <div className="card" style={{ padding: 20, gridColumn: '1 / -1', border: '2px solid var(--warning)', background: 'var(--bg-main)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.9rem', color: 'var(--warning)' }}>
                    &#9888; Schema Changes Required — DDL Preview
                  </div>
                  <div style={{ fontSize: '.82rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
                    The target table is missing {ddlPreview.missingColumns.length} column(s) needed by your field mapping.
                    Review the ALTER statements below and approve to proceed.
                  </div>
                  <div style={{ background: '#1a1d2e', color: '#e2e4f0', padding: 14, borderRadius: 8, fontFamily: 'monospace', fontSize: '.78rem', whiteSpace: 'pre-wrap', marginBottom: 12, maxHeight: 240, overflow: 'auto' }}>
                    {ddlPreview.ddlStatements.join('\n')}
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button
                      className="btn btn-primary"
                      disabled={ddlStatus === 'applying'}
                      onClick={async () => {
                        setDdlStatus('applying');
                        setDdlError('');
                        try {
                          const res = await api.post('/api/hub/apply-ddl', {
                            connection: ddlPreview._connection,
                            ddlStatements: ddlPreview.ddlStatements,
                          });
                          if (res.data?.success) {
                            setDdlStatus('applied');
                          } else {
                            setDdlStatus('error');
                            setDdlError(res.data?.error || 'Failed to apply DDL');
                          }
                        } catch (err) {
                          setDdlStatus('error');
                          setDdlError(err.message || 'Network error');
                        }
                      }}
                    >
                      {ddlStatus === 'applying' ? 'Applying...' : '✓ Approve & Apply DDL'}
                    </button>
                    <button
                      className="btn"
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                      onClick={() => { setDdlPreview(null); setDdlStatus('idle'); }}
                    >
                      ✗ Reject
                    </button>
                  </div>
                  {ddlError && (
                    <div style={{ marginTop: 8, padding: '6px 10px', background: 'var(--error-dim)', color: 'var(--error)', borderRadius: 4, fontSize: '.78rem' }}>
                      {ddlError}
                    </div>
                  )}
                </div>
              )}
              {ddlStatus === 'applied' && (
                <div className="card" style={{ padding: 16, gridColumn: '1 / -1', border: '2px solid var(--success)', background: 'var(--bg-main)' }}>
                  <span style={{ color: 'var(--success)', fontWeight: 600, fontSize: '.9rem' }}>
                    &#10003; DDL applied successfully — {ddlPreview?.ddlStatements?.length || 0} statement(s) executed.
                  </span>
                </div>
              )}

              {/* Right: Push status */}
              <div className="card" style={{ padding: 20, gridColumn: pushStatus === 'idle' && fetchResult?.tickets?.length > 0 ? '1 / -1' : undefined }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.9rem' }}>Push Status</div>

                {pushStatus === 'idle' && (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
                    <div style={{ fontSize: '2rem', marginBottom: 8 }}>&#128640;</div>
                    <div style={{ fontSize: '.88rem' }}>Ready to push {fetchResult?.totalCount || 0} records.</div>
                    <div style={{ fontSize: '.78rem', marginTop: 4 }}>Click <strong>Push to {selectedDest}</strong> below to start.</div>
                    <button
                      className="btn btn-primary"
                      onClick={handlePush}
                      style={{ marginTop: 16 }}
                    >
                      &#9654; Push to {selectedDest}
                    </button>
                  </div>
                )}

                {(pushStatus === 'pushing' || pushStatus === 'polling') && (
                  <div style={{ textAlign: 'center', padding: '30px 20px' }}>
                    <div style={{ fontSize: '2rem', marginBottom: 8, animation: 'spin 1.5s linear infinite', display: 'inline-block' }}>&#9696;</div>
                    <div style={{ fontSize: '.9rem', fontWeight: 600, marginTop: 8, color: 'var(--primary)' }}>
                      {pushStatus === 'pushing' ? 'Starting push...' : 'Pushing to SharePoint...'}
                    </div>
                    {pushResult && (
                      <div style={{ fontSize: '.82rem', color: 'var(--text-secondary)', marginTop: 8 }}>
                        {pushResult.total} records queued
                        {pushProgress && (
                          <span> &middot; {(pushProgress.createdCount || 0) + (pushProgress.updatedCount || 0)} processed</span>
                        )}
                      </div>
                    )}
                    {pushResult?.total > 0 && (() => {
                      const p = pushProgress || {};
                      const processed = (p.createdCount ?? p.created_count ?? 0) + (p.updatedCount ?? p.updated_count ?? 0) + (p.failedCount ?? p.failed_count ?? 0) + (p.skippedCount ?? p.skipped_count ?? 0);
                      const pct = Math.min(100, Math.round((processed / pushResult.total) * 100));
                      return (
                        <div style={{ marginTop: 14, maxWidth: 360, marginLeft: 'auto', marginRight: 'auto' }}>
                          <div style={{ height: 9, background: 'var(--bg-main)', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--primary)', borderRadius: 6, transition: 'width .3s ease' }} />
                          </div>
                          <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 5 }}>{processed} / {pushResult.total} records &middot; {pct}%</div>
                        </div>
                      );
                    })()}
                    <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginTop: 8 }}>
                      Push Run: <span style={{ fontFamily: 'monospace' }}>{pushResult?.pushRunId || '...'}</span>
                    </div>
                    {pushResult?.pushRunId && (
                      <div style={{ marginTop: 16 }}>
                        <button className="btn btn-outline" onClick={handleStopPush} disabled={stopping}
                          style={{ borderColor: 'var(--error)', color: 'var(--error)' }}>
                          {stopping ? 'Stopping…' : '⏹ Stop push'}
                        </button>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 6 }}>
                          Stops sending the rest. Records already sent are kept (no duplicates).
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {pushStatus === 'done' && pushResult && (
                  <div>
                    {(() => {
                      const cancelled = pushResult.status === 'cancelled';
                      const ok = pushResult.status === 'success';
                      const accent = ok ? 'var(--success)' : cancelled ? 'var(--info)' : 'var(--error)';
                      const bg = ok ? 'var(--success-dim)' : cancelled ? 'var(--info-dim)' : 'var(--error-dim)';
                      const label = ok ? '\u2705 Push Complete' : cancelled ? '\u23F9 Push Stopped' : '\u274C Push Had Errors';
                      return (
                        <div style={{ padding: '12px 16px', background: bg, border: `1px solid ${accent}`, borderRadius: 8, marginBottom: 16 }}>
                          <div style={{ fontWeight: 700, color: accent, fontSize: '.9rem' }}>{label}</div>
                        </div>
                      );
                    })()}
                    <div style={{ display: 'grid', gridTemplateColumns: pushResult.skipped != null ? '1fr 1fr 1fr 1fr' : '1fr 1fr 1fr', gap: 12 }}>
                      <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6, textAlign: 'center' }}>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', fontWeight: 600 }}>Inserted</div>
                        <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--success)' }}>{pushResult.created || pushResult.inserted || 0}</div>
                      </div>
                      <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6, textAlign: 'center' }}>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', fontWeight: 600 }}>Updated</div>
                        <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--primary)' }}>{pushResult.updated || 0}</div>
                      </div>
                      {pushResult.skipped != null && (
                        <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6, textAlign: 'center' }}>
                          <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', fontWeight: 600 }}>Unchanged</div>
                          <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--text-dim)' }}>{pushResult.skipped}</div>
                        </div>
                      )}
                      <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6, textAlign: 'center' }}>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', fontWeight: 600 }}>Failed</div>
                        <div style={{ fontSize: '1.3rem', fontWeight: 800, color: pushResult.failed > 0 ? 'var(--error)' : 'var(--text-dim)' }}>{pushResult.failed || 0}</div>
                      </div>
                    </div>

                    {/* Surface why rows failed (first few errors) so failures aren't opaque */}
                    {pushResult.failed > 0 && (pushResult.errors || []).length > 0 && (
                      <div style={{ marginTop: 12, border: '1px solid var(--error)', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ padding: '8px 14px', background: 'var(--bg-main)', fontWeight: 600, fontSize: '.78rem', color: 'var(--error)', borderBottom: '1px solid var(--border)' }}>
                          Why rows failed (first {(pushResult.errors || []).length})
                        </div>
                        <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                          {(pushResult.errors || []).map((e, i) => (
                            <div key={i} style={{ padding: '5px 14px', borderBottom: '1px solid var(--border)', fontSize: '.74rem', fontFamily: 'monospace', color: 'var(--text-secondary)' }}>{e}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Column-level diff stats (PG smart upsert) */}
                    {pushResult.columnChanges && pushResult.columnChanges.length > 0 && (
                      <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ padding: '8px 14px', background: 'var(--bg-main)', fontWeight: 600, fontSize: '.78rem', borderBottom: '1px solid var(--border)' }}>
                          Column-Level Changes ({pushResult.totalColumnsChanged || 0} cell updates across {pushResult.updated || 0} rows)
                        </div>
                        <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                          {pushResult.columnChanges.map(c => (
                            <div key={c.column} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 14px', borderBottom: '1px solid var(--border)', fontSize: '.78rem' }}>
                              <span style={{ fontFamily: 'monospace' }}>{c.column}</span>
                              <span style={{ fontWeight: 600, color: 'var(--primary)' }}>{c.count} row{c.count !== 1 ? 's' : ''} changed</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {pushResult.skipped > 0 && (!pushResult.columnChanges || pushResult.columnChanges.length === 0) && pushResult.updated === 0 && (
                      <div style={{ marginTop: 12, padding: '8px 14px', background: 'var(--info-dim)', border: '1px solid var(--info)', borderRadius: 6, fontSize: '.78rem', color: 'var(--info)' }}>
                        All {pushResult.skipped} existing records are identical — no updates needed.
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
                      <button className="btn btn-outline" onClick={() => navigate('/connected')}>View Connected</button>
                      <button className="btn btn-outline" onClick={() => { setPushStatus('idle'); setPushResult(null); setQuickView(null); }}>Push Again</button>
                      {pushResult?.listUrl && (
                        <a className="btn btn-outline" href={pushResult.listUrl} target="_blank" rel="noopener noreferrer"
                          style={{ textDecoration: 'none' }} title={pushResult.listUrl}>
                          &#128279; Open list in SharePoint
                        </a>
                      )}
                      {(isDbDest(selectedDest)) && destCreds.table && (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={handleQuickView}
                          disabled={quickViewLoading}
                          style={{ marginLeft: 'auto' }}
                        >
                          {quickViewLoading ? 'Loading...' : quickView ? 'Refresh View' : '\uD83D\uDD0D Quick View DB'}
                        </button>
                      )}
                    </div>

                    {/* Quick View — SELECT * preview */}
                    {quickViewError && (
                      <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--error-dim)', border: '1px solid var(--error)', borderRadius: 6, fontSize: '.82rem', color: 'var(--error)' }}>
                        {quickViewError}
                      </div>
                    )}
                    {quickView && (
                      <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                        <div style={{ padding: '10px 16px', background: 'var(--bg-main)', fontWeight: 600, fontSize: '.85rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span>
                            <span style={{ fontFamily: 'monospace' }}>{quickView.table}</span>
                            {' '}&mdash; {quickView.rowCount} of {quickView.totalCount} rows
                          </span>
                          <span style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>SELECT * LIMIT 50</span>
                        </div>
                        <div style={{ maxHeight: 400, overflow: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.74rem' }}>
                            <thead>
                              <tr style={{ background: 'var(--bg-main)', position: 'sticky', top: 0, zIndex: 1 }}>
                                {quickView.columns.map(col => (
                                  <th key={col} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '.72rem' }}>
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {quickView.rows.map((row, ri) => (
                                <tr key={ri} style={{ borderBottom: '1px solid var(--border)' }}
                                  onMouseEnter={e => e.currentTarget.style.background = 'var(--primary-dim)'}
                                  onMouseLeave={e => e.currentTarget.style.background = ''}
                                >
                                  {quickView.columns.map(col => {
                                    const val = row[col];
                                    const display = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
                                    const truncated = display.length > 60 ? display.substring(0, 60) + '...' : display;
                                    return (
                                      <td key={col} title={display} style={{ padding: '5px 10px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {val == null ? <span style={{ color: 'var(--text-dim)', fontStyle: 'italic' }}>null</span> : truncated}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {pushError && (
                  <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--error-dim)', border: '1px solid var(--error)', borderRadius: 6, fontSize: '.82rem', color: 'var(--error)' }}>
                    {pushError}
                  </div>
                )}
              </div>
              </div>{/* close Config + Status row grid */}
            </div>{/* close flex column */}
          </div>
        )}
      </div>

      </div>
    </div>
  );
}
