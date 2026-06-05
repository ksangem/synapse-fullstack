import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { runtimeClient } from '../../services/runtimeClient';

/* ─── Static Data ──────────────────────────────────────��── */
const stepLabels = ['Select Systems', 'Credentials', 'Entities', 'Mapping', 'Fetch & Review', 'Push & Sync'];
const DEFAULT_ICON = '\u{1F50C}'; // fallback card icon for registry connectors without one
/* Connector cards, credential field schemas, DB engine config, and entity
   descriptions are loaded at runtime from the connector registry
   (`/api/connectors`) into component state — see the connector-metadata effect
   inside WizardPage. `isDbDest` / `getFields` / `dbCfg` are registry-driven. */

const PRESET_TRANSFORMS = [
  { value: 'dateFormat', label: 'Date Format (YYYY-MM-DD)', desc: 'Extracts date portion' },
  { value: 'uppercase', label: 'Uppercase', desc: 'Converts text to UPPER CASE' },
  { value: 'lowercase', label: 'Lowercase', desc: 'Converts text to lower case' },
  { value: 'trim', label: 'Trim Whitespace', desc: 'Removes leading/trailing spaces' },
  { value: 'joinArray', label: 'Join Array \u2192 String', desc: 'Joins array items with comma' },
  { value: 'extractNumber', label: 'Extract Number', desc: 'Extracts first number from text' },
  { value: 'boolean', label: 'Boolean (truthy check)', desc: 'Returns true/false' },
];

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

function MappingRow({ mapping, index, srcFields, destFields, onUpdate, onRemove, expanded, onToggle }) {
  const color = PAIR_COLORS[index % PAIR_COLORS.length];
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
  if (mapping.transform === 'DIRECT') {
    previewOutput = JSON.stringify(sampleSource[mapping.sources[0]]);
  } else if (mapping.transform === 'PRESET') {
    previewOutput = JSON.stringify(runPresetTransform(mapping.preset, sampleSource[mapping.sources[0]]));
  } else if (mapping.transform === 'EXPRESSION' && mapping.expression) {
    const { result, error } = evaluateExpression(mapping.expression, sampleSource);
    if (error) previewError = error;
    else previewOutput = JSON.stringify(result);
  }

  return (
    <div className={`mapping-row${expanded ? ' expanded' : ''}${hasMismatch ? ' has-warning' : ''}`}>
      <div className="mapping-row-header" onClick={onToggle}>
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
  const getFields = (label) => connectorMeta[label]?.credFields || [];
  const dbCfg = (label) => connectorMeta[label]?.runtimeConfig || null;
  const isDbDest = (label) => connectorMeta[label]?.runtimeConfig?.runtimeKind === 'database';
  const isRest = (label) => GENERIC_RUNTIME_KINDS.includes(connectorMeta[label]?.runtimeConfig?.runtimeKind);
  // Recognize a SharePoint connector by runtime kind (covers the built-in AND clones like "sp1").
  const isSpSource = (label) => connectorMeta[label]?.runtimeConfig?.runtimeKind === 'sharepoint';
  const isFlatFile = (label) => connectorMeta[label]?.runtimeConfig?.runtimeKind === 'flatfile';
  const connectorIdOf = (label) => connectorMeta[label]?.connectorId;
  const versionIdOf = (label) => connectorMeta[label]?.latestVersionId;

  // ─── Load saved connections on mount ───────────────────
  useEffect(() => {
    (async () => {
      setSavedLoading(true);
      const res = await api.getSavedConnections();
      if (res.ok && res.data?.data) {
        setSavedConnections(res.data.data.filter(c => c.status === 'active'));
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
      if (fm.siteUrl || fm.listName) {
        setDestCreds({
          connectionName: intg.name + ' (SP)',
          siteUrl: fm.siteUrl || '',
          listName: fm.listName || '',
        });
        setDestTestStatus('idle');
        if (fm.siteUrl) setDestTestMsg('SharePoint details loaded from saved connection');
      }
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
    // Sync PG table selection to destCreds before moving to step 4.
    // (Skipped for REST sources, which don't run the SharePoint table-discovery step —
    //  they use the Target Table from the destination credential form, defaulting on push.)
    if (wizardStep === 3 && isDbDest(selectedDest) && !isRest(selectedSource)) {
      const tbl = createNewTable ? newTableName : selectedPgTable;
      if (!tbl) return; // must pick a table
      setDestCreds(prev => ({ ...prev, table: tbl }));
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
      } else if (isRest(selectedSource)) {
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
  const handlePush = async () => {
    // REST source → its own dispatch (the SP/DB push paths fetch from SharePoint).
    if (isRest(selectedSource)) {
      if (isRest(selectedDest)) return handleRestPush();
      if (isDbDest(selectedDest)) return handleRestToDbPush();
      setPushError(`Pushing a REST source into ${selectedDest} isn't supported yet — use a database or REST destination.`);
      setPushStatus('error');
      return;
    }
    // Kind/engine-based dispatch (NOT display-label) — so a cloned DB connector
    // like "pg-prod" routes correctly instead of falling through to SharePoint.
    if (isDbDest(selectedDest)) {
      const engine = dbCfg(selectedDest)?.engine;
      if (engine === 'mysql') handlePushToMysql();
      else if (engine === 'sqlserver') handlePushToMssql();
      else handlePushToPg();
    } else {
      handlePushToSharePoint();
    }
  };

  // Map the fetched source records to destination shape using the wizard mappings
  // (direct field copy — consistent with the existing SP→DB push path).
  const mapRecordsToDest = () => (fetchResult?.tickets || []).map((rec) => {
    const out = {};
    for (const m of mappings) {
      const src = m.sources?.[0];
      const dest = m.destinations?.[0];
      if (src && dest) out[dest] = rec[src];
    }
    return out;
  });

  const handleRestPush = async () => {
    if (!fetchResult?.tickets?.length) { setPushError('No data fetched. Go back and fetch first.'); return; }
    setPushStatus('pushing'); setPushError(''); setPushResult(null);
    try {
      const destMeta = connectorMeta[selectedDest];
      const entity = (destMeta?.entities || [])[0]?.key;
      const records = mapRecordsToDest();
      const result = await runtimeClient.push(destMeta.connectorId, destMeta.latestVersionId, entity, destCreds, records);
      if (result.ok && result.data?.success) {
        const d = result.data.data;
        setPushResult({ pushRunId: 'rest-' + Date.now(), total: records.length, status: 'success', created: d.created, updated: 0, failed: d.failed, errors: d.errors });
        setPushStatus('done');
      } else { setPushError(result.data?.error || 'Push failed'); setPushStatus('error'); }
    } catch { setPushError('Network error during push'); setPushStatus('error'); }
  };

  const handleRestToDbPush = async () => {
    if (!fetchResult?.tickets?.length) { setPushError('No data fetched. Go back and fetch first.'); return; }
    setPushStatus('pushing'); setPushError(''); setPushResult(null);
    try {
      const cfg = dbCfg(selectedDest);
      const dbMappings = mappings.map((m) => ({ from: m.sources?.[0], to: m.destinations?.[0], type: m.srcTypes?.[0] || 'string' })).filter((m) => m.from && m.to);
      const result = await api.call('/api/connectors/runtime/push-to-db', {
        engine: cfg.engine,
        conn: {
          host: destCreds.host, port: Number(destCreds.port) || cfg.defaultPort, database: destCreds.database,
          username: destCreds.username, password: destCreds.password,
          schema: cfg.hasSchema ? (destCreds.schema || cfg.defaultSchema) : undefined,
        },
        table: destCreds.table || 'rest_data',
        records: fetchResult.tickets,
        mappings: dbMappings,
        naturalKey: matchKey === '__append__' ? '' : (matchKey || undefined),
      });
      if (result.ok && result.data?.success) {
        const d = result.data.data;
        setPushResult({ pushRunId: 'restdb-' + Date.now(), total: fetchResult.tickets.length, status: 'success', created: d.inserted, updated: d.updated, failed: d.failed, tableCreated: d.tableCreated, errors: d.errors, autoPrimaryKey: d.autoPrimaryKey });
        setPushStatus('done');
      } else { setPushError(result.data?.error || 'Push failed'); setPushStatus('error'); }
    } catch { setPushError('Network error during push'); setPushStatus('error'); }
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

  const handlePushToPg = async () => {
    if (!fetchResult?.tickets?.length) { setPushError('No data fetched. Go back and fetch first.'); return; }
    setPushStatus('pushing');
    setPushError('');
    setPushResult(null);
    try {
      const pgCfg = destConnectionData || destCreds;
      const targetTable = destCreds.table || 'sp_data';
      const targetSchema = destCreds.schema || 'public';

      // Build mappings from wizard mappings
      const dbMappings = mappings.map(m => ({
        from: m.sources[0] || '',
        to: m.destinations[0] || '',
        type: mapSpTypeToPgType(m.srcTypes?.[0] || 'text'),
      }));

      const result = await api.pushToPg({
        spConfig: {
          siteId: srcConnectionData?.siteId,
          listId: selectedEntity,
          tenantId: srcCreds.tenantId, clientId: srcCreds.clientId, clientSecret: srcCreds.clientSecret,
        },
        pgConfig: {
          host: pgCfg.host, port: Number(pgCfg.port) || 5432,
          database: pgCfg.database, username: pgCfg.username, password: pgCfg.password,
        },
        targetSchema,
        targetTable,
        mappings: dbMappings,
      });

      if (result.ok && result.data?.success) {
        const d = result.data.data;
        setPushResult({
          pushRunId: 'pg-' + Date.now(),
          total: d.total,
          status: 'success',
          created: d.inserted,
          updated: d.updated,
          skipped: d.skipped || 0,
          failed: d.errors,
          tableCreated: d.tableCreated,
          totalColumnsChanged: d.totalColumnsChanged || 0,
          columnChanges: d.columnChanges || [],
        });
        setPushStatus('done');
      } else {
        setPushError(result.data?.error || 'Push failed');
        setPushStatus('error');
      }
    } catch (err) {
      setPushError('Network error during push');
      setPushStatus('error');
    }
  };

  const handlePushToMysql = async () => {
    if (!fetchResult?.tickets?.length) { setPushError('No data fetched. Go back and fetch first.'); return; }
    setPushStatus('pushing');
    setPushError('');
    setPushResult(null);
    try {
      const mysqlCfg = destConnectionData || destCreds;
      const targetTable = destCreds.table || 'sp_data';

      const dbMappings = mappings.map(m => ({
        from: m.sources[0] || '',
        to: m.destinations[0] || '',
        type: mapSpTypeToPgType(m.srcTypes?.[0] || 'text'),
      }));

      const result = await api.pushToMysql({
        spConfig: {
          siteId: srcConnectionData?.siteId,
          listId: selectedEntity,
          tenantId: srcCreds.tenantId, clientId: srcCreds.clientId, clientSecret: srcCreds.clientSecret,
        },
        mysqlConfig: {
          host: mysqlCfg.host, port: Number(mysqlCfg.port) || 3306,
          database: mysqlCfg.database, username: mysqlCfg.username, password: mysqlCfg.password,
        },
        targetTable,
        mappings: dbMappings,
      });

      if (result.ok && result.data?.success) {
        const d = result.data.data;
        setPushResult({
          pushRunId: 'mysql-' + Date.now(),
          total: d.total,
          status: 'success',
          created: d.inserted,
          updated: d.updated,
          skipped: d.skipped || 0,
          failed: d.errors,
          tableCreated: d.tableCreated,
          totalColumnsChanged: d.totalColumnsChanged || 0,
          columnChanges: d.columnChanges || [],
        });
        setPushStatus('done');
      } else {
        setPushError(result.data?.error || 'Push failed');
        setPushStatus('error');
      }
    } catch (err) {
      setPushError('Network error during push');
      setPushStatus('error');
    }
  };

  const handlePushToMssql = async () => {
    if (!fetchResult?.tickets?.length) { setPushError('No data fetched. Go back and fetch first.'); return; }
    setPushStatus('pushing');
    setPushError('');
    setPushResult(null);
    try {
      const mssqlCfg = destConnectionData || destCreds;
      const targetTable = destCreds.table || 'sp_data';
      const targetSchema = destCreds.schema || 'dbo';

      const dbMappings = mappings.map(m => ({
        from: m.sources[0] || '',
        to: m.destinations[0] || '',
        type: mapSpTypeToPgType(m.srcTypes?.[0] || 'text'),
      }));

      const result = await api.pushToMssql({
        spConfig: {
          siteId: srcConnectionData?.siteId,
          listId: selectedEntity,
          tenantId: srcCreds.tenantId, clientId: srcCreds.clientId, clientSecret: srcCreds.clientSecret,
        },
        mssqlConfig: {
          host: mssqlCfg.host, port: Number(mssqlCfg.port) || 1433,
          database: mssqlCfg.database, username: mssqlCfg.username, password: mssqlCfg.password,
        },
        targetSchema,
        targetTable,
        mappings: dbMappings,
      });

      if (result.ok && result.data?.success) {
        const d = result.data.data;
        setPushResult({
          pushRunId: 'mssql-' + Date.now(),
          total: d.total,
          status: 'success',
          created: d.inserted,
          updated: d.updated,
          skipped: d.skipped || 0,
          failed: d.errors,
          tableCreated: d.tableCreated,
          totalColumnsChanged: d.totalColumnsChanged || 0,
          columnChanges: d.columnChanges || [],
        });
        setPushStatus('done');
      } else {
        setPushError(result.data?.error || 'Push failed');
        setPushStatus('error');
      }
    } catch (err) {
      setPushError('Network error during push');
      setPushStatus('error');
    }
  };

  const handlePushToSharePoint = async () => {
    if (!fetchResult?.runId) { setPushError('No Jira data fetched. Go back and fetch first.'); return; }
    setPushStatus('pushing');
    setPushError('');
    setPushResult(null);
    try {
      const { siteUrl, listName } = destCreds;
      const result = await api.pushToSharePoint({
        siteUrl, listName,
        runId: fetchResult.runId,
        source: 'api_token',
        upsertMode: true,
        forceNew: false,
        siteId: destConnectionData?.siteId,
        listId: destConnectionData?.listId,
      });
      if (result.ok && result.data?.success) {
        const d = result.data.data;
        setPushResult({ pushRunId: d.pushRunId, total: d.total, status: 'running' });
        setPushStatus('polling');
        pollPushProgress(d.pushRunId);
      } else if (result.status === 409) {
        const prev = result.data?.previousPush;
        setPushError(`Already pushed. Re-running with upsert...`);
        const retry = await api.pushToSharePoint({
          siteUrl, listName, runId: fetchResult.runId, source: 'api_token',
          upsertMode: true, forceNew: true,
          siteId: destConnectionData?.siteId, listId: destConnectionData?.listId,
        });
        if (retry.ok && retry.data?.success) {
          const d = retry.data.data;
          setPushError('');
          setPushResult({ pushRunId: d.pushRunId, total: d.total, status: 'running' });
          setPushStatus('polling');
          pollPushProgress(d.pushRunId);
        } else { setPushError(retry.data?.error || 'Push failed'); setPushStatus('error'); }
      } else { setPushError(result.data?.error || 'Push failed'); setPushStatus('error'); }
    } catch (err) { setPushError('Network error during push'); setPushStatus('error'); }
  };

  const pollPushProgress = (pushRunId) => {
    let attempts = 0;
    const maxAttempts = 60;
    const poll = async () => {
      attempts++;
      const res = await fetch(`http://localhost:4000/api/sharepoint/runs/${pushRunId}`, {
        headers: { 'Content-Type': 'application/json' },
      }).then(r => r.json()).catch(() => null);
      if (!res?.success || !res?.data) { if (attempts < maxAttempts) setTimeout(poll, 3000); return; }
      const run = res.data;
      setPushProgress(run);
      if (run.status === 'success' || run.status === 'error') {
        setPushResult(prev => ({ ...prev, status: run.status,
          created: run.createdCount ?? run.created_count ?? 0,
          updated: run.updatedCount ?? run.updated_count ?? 0,
          failed: run.failedCount ?? run.failed_count ?? 0,
        }));
        setPushStatus('done');
        return;
      }
      if (attempts < maxAttempts) setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000);
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
      } else if (isRest(selectedSource)) {
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
        // SharePoint destination (built-in or clone) \u2014 recognized by runtimeKind.
        const { siteUrl, listName } = destCreds;
        if (!siteUrl || !listName) { setDestTestStatus('error'); setDestTestMsg('Please fill in Site URL and List Name'); return; }
        const result = await api.testSharePointConnection({ siteUrl, listName });
        if (result.ok && result.data?.success) {
          setDestTestStatus('connected');
          setDestTestMsg(`Connected to "${result.data.data?.siteDisplayName}" \u2014 list "${result.data.data?.listName}" (${result.data.data?.listColumnCount} columns)`);
          setDestConnectionData(result.data.data);
        } else { setDestTestStatus('error'); setDestTestMsg(result.data?.error || 'Connection failed'); }
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
        name: srcCreds.connectionName || `${selectedSource} → ${selectedDest}`,
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
        // DB dest fields
        pgHost: destCreds.host || undefined,
        pgPort: destCreds.port || undefined,
        pgDatabase: destCreds.database || undefined,
        pgSchema: destCreds.schema || undefined,
        pgTable: destCreds.table || undefined,
        pgUsername: destCreds.username || undefined,
        pgPassword: destCreds.password || undefined,
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

  // Resume the wizard where you left off after a round-trip to the Mapping Canvas.
  useEffect(() => {
    let raw = null;
    try { raw = sessionStorage.getItem('synapseWizardResume'); } catch { /* ignore */ }
    if (!raw) return;
    try { sessionStorage.removeItem('synapseWizardResume'); } catch { /* ignore */ }
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
      if (s.activeIntegrationId) setActiveIntegrationId(s.activeIntegrationId);
      if (s.wizardStep) setWizardStep(s.wizardStep);
    } catch { /* ignore a corrupt snapshot */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
        setTimeout(() => setDeleteStatus('idle'), 2000);
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
    } else if (isRest(selectedSource)) {
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

      if (isRest(selectedSource)) {
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
        } else if (selectedDest === 'SharePoint') {
          const destResult = await api.getSharePointListFields({ siteUrl: destCreds.siteUrl, listName: destCreds.listName, siteId: destConnectionData?.siteId });
          if (destResult.ok && destResult.data?.success) {
            setDestFields((destResult.data.data?.spFields || []).map((f) => ({ name: f.name, displayName: f.displayName || f.name, type: f.type || 'text', required: f.required || false })));
          }
        }
        setFieldsLoading(false);
        return;
      }

      if (selectedSource === 'Jira' && selectedDest === 'SharePoint') {
        // Original Jira → SP flow
        const { endpointUrl, email, apiToken } = srcCreds;
        const { siteUrl, listName } = destCreds;
        const [srcResult, destResult] = await Promise.all([
          api.getEntityFields({ endpointUrl, email, apiToken, projectKey: selectedProject, entity: selectedEntity }),
          api.getSharePointListFields({ siteUrl, listName, siteId: destConnectionData?.siteId }),
        ]);
        if (srcResult.ok && srcResult.data?.success) setSrcFields(srcResult.data.data?.fields || []);
        if (destResult.ok && destResult.data?.success) {
          const spf = (destResult.data.data?.spFields || []).map(f => ({
            name: f.name, displayName: f.displayName || f.name, type: f.type || 'text', required: f.required || false,
          }));
          setDestFields(spf);
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

  // ─── Auto-map ───────────────────────────────────────────
  const handleAutoMap = useCallback(() => {
    const newMappings = autoMapFields(srcFields, destFields);
    setMappings(newMappings);
    setExpandedMapping(-1);
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
      <div className="stepper">
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
        padding: '10px 16px', marginTop: 20,
      }}>
        <button className="btn btn-outline" onClick={goBack} disabled={wizardStep === 1}>&larr; Back</button>
        <div style={{ fontSize: '.82rem', color: 'var(--text-dim)' }}>
          Step {wizardStep} of 6: <strong>{stepLabels[wizardStep - 1]}</strong>
        </div>
        <button className="btn btn-primary" onClick={goNext}
          disabled={
            (wizardStep === 1 && (!selectedSource || !selectedDest)) ||
            (wizardStep === 2 && (srcTestStatus !== 'connected' || destTestStatus !== 'connected')) ||
            (wizardStep === 3 && !selectedEntity) ||
            (wizardStep === 5 && fetchStatus !== 'done') ||
            (wizardStep === 6 && (pushStatus === 'pushing' || pushStatus === 'polling'))
          }>
          {wizardStep === 5 && fetchStatus !== 'done' ? 'Fetch First' :
           wizardStep === 6 ? (pushStatus === 'idle' ? `\u25B6 Push to ${selectedDest || 'Destination'}` : pushStatus === 'done' ? 'Done' : 'Pushing...') :
           'Next \u2192'}
        </button>
      </div>

      {/* Wizard content */}
      <div className="wizard-content" style={{ marginTop: 16 }}>

        {/* ── Step 1: Select Systems ── */}
        {wizardStep === 1 && (
          <div className="wizard-step active">
            {/* Saved Connections */}
            {savedConnections.length > 0 && (
              <div className="card" style={{ marginBottom: 20, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: '1.1rem' }}>&#128279;</span>
                  <span style={{ fontWeight: 700, fontSize: '.95rem' }}>My Connections</span>
                  <span className="badge badge-success" style={{ fontSize: '.7rem' }}>{savedConnections.length} saved</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                  {savedConnections.map((intg) => {
                    const fm = intg.fieldMappings || {};
                    return (
                      <div
                        key={intg.integrationId}
                        className="card"
                        style={{
                          padding: '12px 14px', cursor: 'pointer', transition: 'all .15s',
                          border: '1px solid var(--border)', borderRadius: 8,
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
                <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 8 }}>
                  Click a saved connection to auto-fill credentials and skip to Step 2. You can still change the project.
                </div>
              </div>
            )}
            {savedLoading && (
              <div style={{ marginBottom: 16, fontSize: '.82rem', color: 'var(--text-dim)' }}>Loading saved connections...</div>
            )}

            <div className="grid-2" style={{ gap: 24 }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.95rem' }}>&#9664; Source System</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                  {sourceCards.map((c, i) => (
                    <div key={i} className="card connector-card"
                      style={{ padding: 14, borderColor: selectedSource === c.label ? 'var(--primary)' : undefined, borderWidth: selectedSource === c.label ? 2 : undefined }}
                      onClick={() => handleSourceSelect(c.label)}>
                      <div className="conn-icon" style={{ fontSize: '1.6rem' }}>{c.icon}</div>
                      <div className="conn-label" style={{ fontSize: '.78rem' }}>{c.label}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.95rem' }}>Destination System &#9654;</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
                  {destCards.map((c, i) => (
                    <div key={i} className="card connector-card"
                      style={{ padding: 14, borderColor: selectedDest === c.label ? 'var(--primary)' : undefined, borderWidth: selectedDest === c.label ? 2 : undefined }}
                      onClick={() => handleDestSelect(c.label)}>
                      <div className="conn-icon" style={{ fontSize: '1.6rem' }}>{c.icon}</div>
                      <div className="conn-label" style={{ fontSize: '.78rem' }}>{c.label}</div>
                    </div>
                  ))}
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
                  <strong>{srcCreds.connectionName || selectedSource}</strong> ({srcCreds.siteUrl || srcCreds.endpointUrl})
                  &nbsp;&rarr;&nbsp;
                  <strong>{destCreds.connectionName || selectedDest}</strong> ({destCreds.database || destCreds.listName || ''})
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
              <div style={{ display: 'grid', gridTemplateColumns: (isDbDest(selectedDest)) ? '1fr 1fr' : '1fr', gap: 20 }}>

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

                {isDbDest(selectedDest) && (
                  <div style={{ margin: '8px 0', padding: '10px 12px', background: 'var(--bg-main)', borderRadius: 6, fontSize: '.8rem', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600 }}>Match records by:</span>
                    <select value={matchKey} onChange={(e) => setMatchKey(e.target.value)} style={{ minWidth: 220 }}>
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
                        &#9989; Fetched {fetchResult.totalCount} {isSpSource(selectedSource) ? 'items' : 'issues'}
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
                            ) : (
                              <>
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Key</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Summary</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Status</th>
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
                              ) : (
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
                          // Apply each mapping to this ticket
                          const getNestedValue = (obj, path) => {
                            if (!obj || !path) return '';
                            const parts = path.split('.');
                            let val = obj;
                            for (const p of parts) {
                              if (val == null) return '';
                              if (p === 'fields' || p === 'key' || p === 'id') val = val[p];
                              else val = val.fields?.[p] ?? val[p];
                            }
                            return val;
                          };

                          const applyTransform = (m, ticket) => {
                            try {
                              const srcVal = m.sources.map(s => {
                                const raw = getNestedValue(ticket, s);
                                if (raw && typeof raw === 'object') {
                                  if (raw.name) return raw.name;
                                  if (raw.displayName) return raw.displayName;
                                  if (Array.isArray(raw)) return raw.map(v => typeof v === 'object' ? (v.name || JSON.stringify(v)) : v).join(', ');
                                  return JSON.stringify(raw);
                                }
                                return raw ?? '';
                              });

                              if (m.transform === 'DIRECT') return String(srcVal[0] ?? '');
                              if (m.preset === 'dateFormat') return String(srcVal[0] ?? '').substring(0, 10);
                              if (m.preset === 'uppercase') return String(srcVal[0] ?? '').toUpperCase();
                              if (m.preset === 'lowercase') return String(srcVal[0] ?? '').toLowerCase();
                              if (m.preset === 'trim') return String(srcVal[0] ?? '').trim();
                              if (m.preset === 'joinArray') return Array.isArray(srcVal[0]) ? srcVal[0].join(', ') : String(srcVal[0] ?? '');
                              if (m.preset === 'extractNumber') { const n = String(srcVal[0] ?? '').match(/\d+/); return n ? n[0] : ''; }
                              if (m.preset === 'boolean') return srcVal[0] ? 'true' : 'false';
                              if (m.transform === 'EXPRESSION' && m.expression) {
                                const source = {};
                                m.sources.forEach((s, i) => { source[s] = srcVal[i]; });
                                const fn = new Function('source', m.expression);
                                return String(fn(source) ?? '');
                              }
                              return String(srcVal.join(', '));
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
                    <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginTop: 4 }}>
                      Push Run: <span style={{ fontFamily: 'monospace' }}>{pushResult?.pushRunId || '...'}</span>
                    </div>
                  </div>
                )}

                {pushStatus === 'done' && pushResult && (
                  <div>
                    <div style={{
                      padding: '12px 16px',
                      background: pushResult.status === 'success' ? 'var(--success-dim)' : 'var(--error-dim)',
                      border: `1px solid ${pushResult.status === 'success' ? 'var(--success)' : 'var(--error)'}`,
                      borderRadius: 8, marginBottom: 16,
                    }}>
                      <div style={{ fontWeight: 700, color: pushResult.status === 'success' ? 'var(--success)' : 'var(--error)', fontSize: '.9rem' }}>
                        {pushResult.status === 'success' ? '\u2705 Push Complete' : '\u274C Push Had Errors'}
                      </div>
                    </div>
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
  );
}
