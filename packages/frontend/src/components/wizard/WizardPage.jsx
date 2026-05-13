import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';

/* ─── Static Data ──────────────────────────────────────��── */
const sourceCards = [
  { icon: '\u{1F3E2}', label: 'Dynamics 365' },
  { icon: '\u{1F4CB}', label: 'Jira' },
  { icon: '\u{1F4DD}', label: 'TARA' },
  { icon: '\u{1F5C3}', label: 'PostgreSQL' },
  { icon: '\u{1F4CA}', label: 'Excel' },
  { icon: '\u{1F465}', label: 'Keka' },
];
const destCards = [
  { icon: '\u2699', label: 'TFS' },
  { icon: '\u{1F4C1}', label: 'SharePoint' },
  { icon: '\u{1F4C5}', label: 'Holiday Tracker' },
  { icon: '\u{1F517}', label: 'Ahrefs' },
  { icon: '\u{1F50D}', label: 'GSC' },
  { icon: '\u{1F4E2}', label: 'Google Adwords' },
];
const stepLabels = ['Select Systems', 'Credentials', 'Entities', 'Mapping', 'Fetch & Review', 'Push to SharePoint'];
const credentialFields = {
  Jira: [
    { key: 'connectionName', label: 'Connection Name', type: 'text', placeholder: 'e.g. Jira Production' },
    { key: 'endpointUrl', label: 'API Base URL', type: 'text', placeholder: 'https://yourorg.atlassian.net' },
    { key: 'apiToken', label: 'API Token', type: 'password', placeholder: 'Your Jira API token' },
    { key: 'email', label: 'Email / Username', type: 'text', placeholder: 'admin@yourorg.com' },
  ],
  SharePoint: [
    { key: 'connectionName', label: 'Connection Name', type: 'text', placeholder: 'e.g. SharePoint Production' },
    { key: 'siteUrl', label: 'Site URL', type: 'text', placeholder: 'https://yourorg.sharepoint.com/sites/projects' },
    { key: 'listName', label: 'List Name', type: 'text', placeholder: 'e.g. JiraData' },
  ],
};
const genericCredFields = [
  { key: 'connectionName', label: 'Connection Name', type: 'text', placeholder: 'Connection name' },
  { key: 'endpoint', label: 'Endpoint URL', type: 'text', placeholder: 'https://...' },
  { key: 'apiKey', label: 'API Key / Token', type: 'password', placeholder: 'Your API key' },
  { key: 'username', label: 'Username', type: 'text', placeholder: 'Username or email' },
];

const entityDescriptions = {
  issues: 'Bugs, stories, tasks, epics \u2014 the core Jira work items',
  projects: 'Project metadata, lead, category',
  users: 'Team members, assignees, reporters',
  sprints: 'Sprint names, dates, goals',
  components: 'Project components / modules',
  comments: 'Issue comments and discussions',
  attachments: 'Files attached to issues',
  worklogs: 'Time tracking entries',
};

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

  // Step 4 — Mapping
  const [srcFields, setSrcFields] = useState([]);
  const [destFields, setDestFields] = useState([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [mappings, setMappings] = useState([]);
  const [expandedMapping, setExpandedMapping] = useState(-1);
  const [srcSearch, setSrcSearch] = useState('');
  const [destSearch, setDestSearch] = useState('');

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

  const updateSrcCred = (key, val) => setSrcCreds(prev => ({ ...prev, [key]: val }));
  const updateDestCred = (key, val) => setDestCreds(prev => ({ ...prev, [key]: val }));
  const getFields = (system) => credentialFields[system] || genericCredFields;

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

  // ─── Apply a saved connection ──────────────────────────
  const applySavedConnection = async (intg) => {
    const fm = intg.fieldMappings || {};

    // Auto-select source + dest systems
    setSelectedSource('Jira');
    setSelectedDest('SharePoint');

    // Fill Jira creds from integration
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

    // Fill SharePoint creds from integration
    // Use fm.siteUrl (SharePoint URL), NOT fm.endpointUrl (Jira URL)
    if (fm.siteUrl || fm.listName) {
      setDestCreds({
        connectionName: intg.name + ' (SP)',
        siteUrl: fm.siteUrl || '',
        listName: fm.listName || '',
      });
      setDestTestStatus('idle');
      if (fm.siteUrl) {
        setDestTestMsg('SharePoint details loaded from saved connection');
      }
    }

    // Pre-select project
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
    if (wizardStep === 5 && fetchStatus !== 'done') return; // must fetch before push
    if (wizardStep === 6) { handlePushToSharePoint(); return; } // Step 6 button triggers push
    setWizardStep(prev => Math.min(6, prev + 1));
  };

  // ─── Step 5: Fetch Jira data ───────────────────────────
  const handleFetchJira = async () => {
    setFetchStatus('fetching');
    setFetchError('');
    setFetchResult(null);
    try {
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
      } else {
        setFetchError(result.data?.error || 'Fetch failed');
        setFetchStatus('error');
      }
    } catch (err) {
      setFetchError('Network error during fetch');
      setFetchStatus('error');
    }
  };

  // ─── Step 6: Push to SharePoint ────────────────────────
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
        upsertMode: true,   // Always upsert — update existing by IssueKey, create new
        forceNew: false,
        siteId: destConnectionData?.siteId,
        listId: destConnectionData?.listId,
      });
      if (result.ok && result.data?.success) {
        const d = result.data.data;
        setPushResult({ pushRunId: d.pushRunId, total: d.total, status: 'running' });
        setPushStatus('polling');
        // Poll for completion
        pollPushProgress(d.pushRunId);
      } else if (result.status === 409) {
        // Already pushed — offer upsert
        const prev = result.data?.previousPush;
        setPushError(`Already pushed to "${prev?.listName}" (${prev?.recordCount} records on ${new Date(prev?.pushedAt).toLocaleDateString()}). Re-running with upsert...`);
        // Auto-retry with upsert + forceNew
        const retry = await api.pushToSharePoint({
          siteUrl, listName,
          runId: fetchResult.runId,
          source: 'api_token',
          upsertMode: true,
          forceNew: true,
          siteId: destConnectionData?.siteId,
          listId: destConnectionData?.listId,
        });
        if (retry.ok && retry.data?.success) {
          const d = retry.data.data;
          setPushError('');
          setPushResult({ pushRunId: d.pushRunId, total: d.total, status: 'running' });
          setPushStatus('polling');
          pollPushProgress(d.pushRunId);
        } else {
          setPushError(retry.data?.error || 'Push failed after retry');
          setPushStatus('error');
        }
      } else {
        setPushError(result.data?.error || 'Push failed');
        setPushStatus('error');
      }
    } catch (err) {
      setPushError('Network error during push');
      setPushStatus('error');
    }
  };

  const pollPushProgress = (pushRunId) => {
    let attempts = 0;
    const maxAttempts = 60; // 60 * 3s = 3 min max
    const poll = async () => {
      attempts++;
      // Query the DB-backed push run endpoint
      const res = await fetch(`http://localhost:4000/api/sharepoint/runs/${pushRunId}`, {
        headers: { 'Content-Type': 'application/json' },
      }).then(r => r.json()).catch(() => null);

      if (!res?.success || !res?.data) {
        if (attempts < maxAttempts) setTimeout(poll, 3000);
        return;
      }
      const run = res.data;
      setPushProgress(run);

      if (run.status === 'success' || run.status === 'error') {
        setPushResult(prev => ({
          ...prev,
          status: run.status,
          created: run.createdCount ?? run.created_count ?? 0,
          updated: run.updatedCount ?? run.updated_count ?? 0,
          failed: run.failedCount ?? run.failed_count ?? 0,
        }));
        setPushStatus('done');
        return;
      }
      // Keep polling if still running
      if (attempts < maxAttempts) setTimeout(poll, 3000);
    };
    setTimeout(poll, 3000); // initial delay for backend to start processing
  };

  // ─── Credential handlers ────────────────────────────────
  const handleSrcCredChange = (key, val) => {
    updateSrcCred(key, val);
    if (srcTestStatus !== 'idle') { setSrcTestStatus('idle'); setSrcTestMsg(''); }
  };
  const handleDestCredChange = (key, val) => {
    updateDestCred(key, val);
    if (destTestStatus !== 'idle') { setDestTestStatus('idle'); setDestTestMsg(''); }
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
      } else { setSrcTestStatus('error'); setSrcTestMsg(`${selectedSource} not yet supported.`); }
    } catch { setSrcTestStatus('error'); setSrcTestMsg('Connection failed.'); }
  };

  const testDestConnection = async () => {
    setDestTestStatus('testing'); setDestTestMsg('');
    try {
      if (selectedDest === 'SharePoint') {
        const { siteUrl, listName } = destCreds;
        if (!siteUrl || !listName) { setDestTestStatus('error'); setDestTestMsg('Please fill in Site URL and List Name'); return; }
        const result = await api.testSharePointConnection({ siteUrl, listName });
        if (result.ok && result.data?.success) {
          setDestTestStatus('connected');
          setDestTestMsg(`Connected to "${result.data.data?.siteDisplayName}" \u2014 list "${result.data.data?.listName}" (${result.data.data?.listColumnCount} columns)`);
          setDestConnectionData(result.data.data);
        } else { setDestTestStatus('error'); setDestTestMsg(result.data?.error || 'Connection failed'); }
      } else { setDestTestStatus('error'); setDestTestMsg(`${selectedDest} not yet supported.`); }
    } catch { setDestTestStatus('error'); setDestTestMsg('Connection failed.'); }
  };

  const handleSourceSelect = (label) => {
    setSelectedSource(label); setSrcCreds({}); setSrcTestStatus('idle'); setSrcTestMsg(''); setSrcConnectionData(null);
    setActiveIntegrationId(null); setSaveStatus('idle'); setSaveMsg(''); setDeleteStatus('idle');
  };
  const handleDestSelect = (label) => {
    setSelectedDest(label); setDestCreds({}); setDestTestStatus('idle'); setDestTestMsg(''); setDestConnectionData(null);
  };

  // ─── Save connection (upsert by endpoint URL) ──────────
  const handleSaveConnection = async () => {
    if (!srcCreds.endpointUrl || !srcCreds.email || !srcCreds.apiToken) {
      setSaveMsg('Fill in all Jira credential fields first');
      setSaveStatus('error');
      return;
    }
    setSaveStatus('saving');
    setSaveMsg('');
    try {
      const body = {
        name: srcCreds.connectionName || 'Jira Integration',
        endpointUrl: srcCreds.endpointUrl,
        email: srcCreds.email,
        apiToken: srcCreds.apiToken,
        projectKey: selectedProject || undefined,
        siteUrl: destCreds.siteUrl || undefined,
        listName: destCreds.listName || undefined,
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
      } else {
        setSaveStatus('error');
        setSaveMsg(res.data?.error || 'Failed to save');
      }
    } catch {
      setSaveStatus('error');
      setSaveMsg('Network error while saving');
    }
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
    if (selectedSource !== 'Jira') return;

    const loadProjects = async () => {
      const { endpointUrl, email, apiToken } = srcCreds;
      const result = await api.discoverProjects({ endpointUrl, email, apiToken });
      if (result.ok && result.data?.success) {
        setProjects(result.data.data || []);
        if (result.data.data?.length === 1) setSelectedProject(result.data.data[0].key);
      }
    };
    loadProjects();
  }, [wizardStep]);

  useEffect(() => {
    if (wizardStep !== 3 || !selectedProject) return;
    const loadEntities = async () => {
      setEntitiesLoading(true);
      const { endpointUrl, email, apiToken } = srcCreds;
      const result = await api.discoverEntities({ endpointUrl, email, apiToken, projectKey: selectedProject });
      if (result.ok && result.data?.success) {
        setEntities(result.data.data?.entities || []);
        // Auto-select Issues if available
        const issues = result.data.data?.entities?.find(e => e.id === 'issues');
        if (issues?.available) setSelectedEntity('issues');
      }
      setEntitiesLoading(false);
    };
    loadEntities();
  }, [wizardStep, selectedProject]);

  // ─── Step 4: Load fields when entering ──────────────────
  useEffect(() => {
    if (wizardStep !== 4) return;
    const loadFields = async () => {
      setFieldsLoading(true);
      const { endpointUrl, email, apiToken } = srcCreds;
      const { siteUrl, listName } = destCreds;

      // Fetch both in parallel
      const [srcResult, destResult] = await Promise.all([
        api.getEntityFields({ endpointUrl, email, apiToken, projectKey: selectedProject, entity: selectedEntity }),
        api.getSharePointListFields({ siteUrl, listName, siteId: destConnectionData?.siteId }),
      ]);

      if (srcResult.ok && srcResult.data?.success) {
        setSrcFields(srcResult.data.data?.fields || []);
      }
      if (destResult.ok && destResult.data?.success) {
        const spf = (destResult.data.data?.spFields || []).map(f => ({
          name: f.name,
          displayName: f.displayName || f.name,
          type: f.type || 'text',
          required: f.required || false,
        }));
        setDestFields(spf);
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
           wizardStep === 6 ? (pushStatus === 'idle' ? '\u25B6 Push to SharePoint' : pushStatus === 'done' ? 'Done' : 'Pushing...') :
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
                        <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>
                          {fm.projectKey && <span className="badge badge-primary" style={{ marginRight: 4, fontSize: '.65rem' }}>{fm.projectKey}</span>}
                          {fm.listName && <span>&rarr; {fm.listName}</span>}
                        </div>
                        <div style={{ fontSize: '.7rem', color: 'var(--text-dim)', marginTop: 4 }}>
                          {fm.endpointUrl ? new URL(fm.endpointUrl).hostname : ''}
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
                  disabled={saveStatus === 'saving' || !srcCreds.endpointUrl || !srcCreds.email || !srcCreds.apiToken}
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
                Save stores both Jira and SharePoint details. Same Jira URL will update the existing connection instead of creating a duplicate.
              </div>
            </div>

            {(srcTestStatus !== 'connected' || destTestStatus !== 'connected') && (
              <div style={{ color: 'var(--text-dim)', fontSize: '.85rem', marginTop: 16, textAlign: 'center' }}>
                Both connections must be tested successfully before proceeding
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Entities ── */}
        {wizardStep === 3 && (
          <div className="wizard-step active">
            <div className="entity-header-bar">
              <div>
                <div style={{ fontWeight: 600, fontSize: '1rem', marginBottom: 4 }}>Choose what to sync</div>
                <div className="conn-summary">
                  <strong>{srcCreds.connectionName || selectedSource}</strong> ({srcCreds.endpointUrl})
                  &nbsp;&rarr;&nbsp;
                  <strong>{destCreds.connectionName || selectedDest}</strong> ({destCreds.listName})
                  {destConnectionData?.listColumnCount ? ` \u2014 ${destConnectionData.listColumnCount} columns` : ''}
                </div>
              </div>
            </div>

            {/* Project selector */}
            {projects.length > 1 && (
              <div className="form-group" style={{ maxWidth: 400, marginBottom: 16 }}>
                <label>Select Project</label>
                <select value={selectedProject} onChange={e => setSelectedProject(e.target.value)}>
                  <option value="">Choose a project...</option>
                  {projects.map(p => <option key={p.key} value={p.key}>{p.key} \u2014 {p.name}</option>)}
                </select>
              </div>
            )}
            {projects.length === 1 && (
              <div style={{ marginBottom: 12, fontSize: '.85rem', color: 'var(--text-secondary)' }}>
                Project: <strong style={{ color: 'var(--text)' }}>{projects[0].key} \u2014 {projects[0].name}</strong>
              </div>
            )}

            {entitiesLoading ? (
              <div className="wizard-loader">
                <div className="loader-spinner"></div>
                <div className="loader-text">Loading entities from {selectedSource}...</div>
              </div>
            ) : entities.length > 0 ? (
              <div className="entity-list">
                {entities.map(ent => (
                  <div
                    key={ent.id}
                    className={`entity-card${selectedEntity === ent.id ? ' selected' : ''}${!ent.available ? ' disabled' : ''}`}
                    onClick={() => ent.available && setSelectedEntity(ent.id)}
                  >
                    <div className="entity-radio"></div>
                    <div className="entity-info">
                      <div className="entity-name">{ent.name}</div>
                      <div className="entity-desc">{entityDescriptions[ent.id] || ''}</div>
                    </div>
                    <div className="entity-badges">
                      <span className="badge badge-neutral">{ent.fieldCount} fields</span>
                      {ent.id === 'issues' && <span className="badge badge-primary">Recommended</span>}
                      {!ent.available && <span className="badge badge-warning">Unavailable</span>}
                    </div>
                  </div>
                ))}
              </div>
            ) : !selectedProject ? (
              <div style={{ color: 'var(--text-dim)', textAlign: 'center', padding: 40 }}>
                Select a project above to discover available entities
              </div>
            ) : null}

            {!selectedEntity && entities.length > 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: '.85rem', marginTop: 16, textAlign: 'center' }}>
                Select an entity to continue
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
            <div style={{ fontWeight: 600, marginBottom: 16, fontSize: '1rem' }}>Fetch Jira Data</div>

            <div className="grid-2" style={{ gap: 24 }}>
              {/* Left: Config */}
              <div className="card" style={{ padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.9rem' }}>Fetch Configuration</div>
                <div className="form-group">
                  <label>Project</label>
                  <input type="text" value={selectedProject} readOnly style={{ background: 'var(--bg-main)' }} />
                </div>
                <div className="form-group">
                  <label>Entity</label>
                  <input type="text" value={selectedEntity || ''} readOnly style={{ background: 'var(--bg-main)' }} />
                </div>
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
                <div className="form-group" style={{ marginTop: 4 }}>
                  <label style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>
                    {mappings.length} field mappings configured &middot; {selectedProject} &rarr; {destCreds.listName}
                  </label>
                </div>
                <button
                  className="btn btn-primary"
                  onClick={handleFetchJira}
                  disabled={fetchStatus === 'fetching'}
                  style={{ marginTop: 8, width: '100%' }}
                >
                  {fetchStatus === 'fetching' ? 'Fetching...' : fetchStatus === 'done' ? 'Re-fetch' : 'Fetch Jira Issues'}
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
                        &#9989; Fetched {fetchResult.totalCount} issues
                      </div>
                      <div style={{ fontSize: '.78rem', color: 'var(--text-secondary)', marginTop: 2 }}>
                        Run ID: <span style={{ fontFamily: 'monospace' }}>{fetchResult.runId}</span>
                      </div>
                    </div>
                    {/* Preview first few tickets */}
                    <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>
                      Preview (first {Math.min(5, fetchResult.tickets.length)} of {fetchResult.totalCount})
                    </div>
                    <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '.78rem' }}>
                        <thead>
                          <tr style={{ background: 'var(--bg-main)' }}>
                            <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Key</th>
                            <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Summary</th>
                            <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fetchResult.tickets.slice(0, 5).map((t, i) => (
                            <tr key={i}>
                              <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                                {t.key || t.issueKey || '--'}
                              </td>
                              <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)' }}>
                                {(t.fields?.summary || t.summary || '').substring(0, 60)}
                              </td>
                              <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}>
                                {t.fields?.status?.name || t.status || '--'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ marginTop: 12, fontSize: '.82rem', color: 'var(--text-secondary)' }}>
                      Click <strong>Next</strong> to push these {fetchResult.totalCount} issues to <strong>{destCreds.listName}</strong> on SharePoint.
                      Existing records will be updated by IssueKey; new ones will be created.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 6: Push to SharePoint ── */}
        {wizardStep === 6 && (
          <div className="wizard-step active">
            <div style={{ fontWeight: 600, marginBottom: 16, fontSize: '1rem' }}>Push to SharePoint</div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Config + Status row */}
              <div style={{ display: 'grid', gridTemplateColumns: pushStatus !== 'idle' || !fetchResult?.tickets?.length ? '1fr 1fr' : '1fr', gap: 16 }}>
              <div className="card" style={{ padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.9rem' }}>Push Configuration</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Source:</span> <strong>{selectedProject}</strong> ({fetchResult?.totalCount || 0} issues)</div>
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Destination:</span> <strong>{destCreds.listName}</strong></div>
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Site:</span> <span style={{ fontSize: '.82rem', wordBreak: 'break-all' }}>{destCreds.siteUrl}</span></div>
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Mappings:</span> {mappings.length} fields</div>
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Mode:</span> <strong>Upsert</strong> (update by IssueKey, create if new)</div>
                  <div><span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Date Range:</span> {dateStart} &rarr; {dateEnd}</div>
                </div>
                <div style={{ marginTop: 14, padding: '8px 12px', background: 'var(--info-dim)', border: '1px solid var(--info)', borderRadius: 6, fontSize: '.78rem', color: 'var(--info)' }}>
                  <strong>Dedup:</strong> Each issue is matched by <code style={{ background: 'var(--bg-main)', padding: '1px 4px', borderRadius: 3 }}>IssueKey</code> column.
                  If a record exists in SharePoint with the same IssueKey, it will be <strong>updated</strong>. Otherwise, a new row is created. No duplicates.
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

              {/* Right: Push status */}
              <div className="card" style={{ padding: 20, gridColumn: pushStatus === 'idle' && fetchResult?.tickets?.length > 0 ? '1 / -1' : undefined }}>
                <div style={{ fontWeight: 600, marginBottom: 12, fontSize: '.9rem' }}>Push Status</div>

                {pushStatus === 'idle' && (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-dim)' }}>
                    <div style={{ fontSize: '2rem', marginBottom: 8 }}>&#128640;</div>
                    <div style={{ fontSize: '.88rem' }}>Ready to push {fetchResult?.totalCount || 0} records.</div>
                    <div style={{ fontSize: '.78rem', marginTop: 4 }}>Click <strong>Push to SharePoint</strong> below to start.</div>
                    <button
                      className="btn btn-primary"
                      onClick={handlePushToSharePoint}
                      style={{ marginTop: 16 }}
                    >
                      &#9654; Push to SharePoint
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
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                      <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6, textAlign: 'center' }}>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', fontWeight: 600 }}>Created</div>
                        <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--success)' }}>{pushResult.created || 0}</div>
                      </div>
                      <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6, textAlign: 'center' }}>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', fontWeight: 600 }}>Updated</div>
                        <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--primary)' }}>{pushResult.updated || 0}</div>
                      </div>
                      <div style={{ padding: 12, background: 'var(--bg-main)', borderRadius: 6, textAlign: 'center' }}>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', fontWeight: 600 }}>Failed</div>
                        <div style={{ fontSize: '1.3rem', fontWeight: 800, color: pushResult.failed > 0 ? 'var(--error)' : 'var(--text-dim)' }}>{pushResult.failed || 0}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                      <button className="btn btn-outline" onClick={() => navigate('/connected')}>View Connected</button>
                      <button className="btn btn-outline" onClick={() => { setPushStatus('idle'); setPushResult(null); }}>Push Again</button>
                    </div>
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
