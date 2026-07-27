import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { runtimeClient } from '../../services/runtimeClient';
import JoinsPanel from '../mapping/JoinsPanel';
import PresetConfigFields from '../mapping/PresetConfigFields';
import SessionRecorder from './SessionRecorder';
import Button from '../ui/Button';
import Card from '../ui/Card';
import {
  PAIR_COLORS, PRESET_GROUPS, PRESET_TRANSFORMS, PRESET_OUTPUT_TYPE,
  computeMappedValue, defaultPresetConfig, presetConfigSpec, presetIssue, sampleFor,
} from '../mapping/mappingUtils';
import { clickable } from '../../utils/clickable';


/* Wizard system picker card.

   The previous markup was a `<div onClick>`: not focusable, not reachable by
   keyboard, and it signalled selection with `borderWidth: 2` — which reflows the
   card by a pixel and nudges every neighbour in the grid. `blocked` (a connector
   kind the bus cannot run) was expressed only as inline opacity, so it still read
   as clickable. Both are now states the shared card owns. */
function SystemCard({ label, icon, selected, blocked, onSelect }) {
  return (
    <Card
      interactive
      className="ucard--pick"
      selected={selected}
      disabled={!!blocked}
      onOpen={() => { if (!blocked) onSelect(); }}
      ariaLabel={blocked ? `${label} — ${blocked}` : label}
      tooltip={blocked || label}
    >
      <div className="ucard-pick-icon" aria-hidden="true"><ConnIcon icon={icon} size={26} /></div>
      <div className="ucard-pick-label">{label}</div>
      {blocked && <div className="ucard-pick-note">not on bus</div>}
    </Card>
  );
}

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

/* PRESET_TRANSFORMS / PRESET_OUTPUT_TYPE / computeMappedValue now live in
   ../mapping/mappingUtils — the single source of truth shared with the Mapping
   Canvas, and kept in parity with the backend's MappingEngine (which is what
   actually runs the mappings: the Wizard pushes a recipe, not the data). */

function inferMappingOutputType(m) {
  if (m.transform === 'PRESET' && PRESET_OUTPUT_TYPE[m.preset]) return PRESET_OUTPUT_TYPE[m.preset];
  if (m.transform === 'DIRECT') return m.srcTypes?.[0] || 'string';
  return m.srcTypes?.[0] || 'string'; // EXPRESSION: unknown statically \u2192 user can override
}


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
      <label htmlFor="wizardpage-field">{label}</label>
      <div className="password-wrap">
        <input id="wizardpage-field" type={showPw ? 'text' : 'password'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
        <button className="eye-btn" type="button" onClick={togglePw}>&#128065;</button>
      </div>
    </div>
  );
}

function MappingRow({ mapping, index, srcFields, destFields, allowNewDest, isKey, onSetKey, onUpdate, onRemove, expanded, onToggle, targets = [] }) {
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
  const compatible = mapping.sources.every((s) => {
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

  // Preview — the sample is preset-aware (see sampleFor), so e.g. parseDate previews
  // against a date in its configured format rather than a generic "Sample x" string.
  const sampleSource = sampleFor(mapping.sources, srcFields, mapping);

  let previewOutput = '';
  let previewError = '';
  try {
    previewOutput = JSON.stringify(computeMappedValue(mapping, sampleSource));
  } catch (e) {
    previewError = e.message;
  }
  // Advisory: wrong source count / missing required option — a misconfigured preset
  // otherwise just writes empty values with no explanation.
  const configIssue = presetIssue(mapping);

  return (
    <div className={`mapping-row${expanded ? ' expanded' : ''}${hasMismatch ? ' has-warning' : ''}`}>
      <div className="mapping-row-header" {...clickable(onToggle, { label: `${expanded ? 'Collapse' : 'Expand'} mapping ${srcDisplay} to ${destDisplay}` })}
        aria-expanded={expanded}>
        <button
          type="button"
          className="map-key-star"
          title={isKey
            ? 'This column is the identity / match key — records are deduped & upserted by it. Click to clear (append every row instead).'
            : 'Use this mapping as the identity / match key (dedupe & upsert by this column)'}
          onClick={(e) => { e.stopPropagation(); onSetKey(); }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: '0 4px',
            fontSize: 'var(--fs-lg)', lineHeight: 1, color: isKey ? '#f59e0b' : 'var(--text-dim)',
            opacity: isKey ? 1 : 0.55,
          }}
        >{isKey ? '★' : '☆'}</button>
        <div className="map-num" style={{ background: color }}>{index + 1}</div>
        <span className="map-src" title={srcDisplay}>{srcDisplay}</span>
        <span className="map-arrow">&rarr;</span>
        <span className="map-dest" title={destDisplay}>{destDisplay}</span>
        <span className={`map-badge ${badgeClass}`}>{hasMismatch ? '\u26A0 Type' : transformLabel}</span>
        <span className="map-actions">
          <button className="btn btn-ghost btn-xs" title="Remove" aria-label="Remove mapping" onClick={e => { e.stopPropagation(); onRemove(); }}>&times;</button>
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
                      <button className="multi-field-remove" onClick={() => {
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
              <label htmlFor="wizardpage-destination-column-s">Destination Column(s){targets.length > 1 ? ' → target' : ''}</label>
              <div className="multi-field-list">
                {mapping.destinations.map((d, i) => (
                  <span key={i} className="multi-field-chip" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {d}
                    {targets.length > 1 && (
                      <select id="wizardpage-destination-column-s"
                        value={(mapping.routes?.find((r) => r.column === d)?.targetId) || 'primary'}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          const targetId = e.target.value;
                          const others = (mapping.routes || []).filter((r) => r.column !== d);
                          onUpdate({ ...mapping, routes: [...others, { targetId, column: d }] });
                        }}
                        title="Which destination target this column is written to"
                        style={{ fontSize: 'var(--fs-xs)', padding: '0 2px', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', background: 'var(--bg-card)', maxWidth: 110 }}
                      >
                        {targets.map((t) => <option key={t.targetId} value={t.targetId}>{t.label}</option>)}
                      </select>
                    )}
                    {mapping.destinations.length > 1 && (
                      <button className="multi-field-remove" onClick={() => {
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
                    style={{ flex: 1, minWidth: 0, padding: '5px 8px', borderRadius: 'var(--radius)', border: '1px dashed var(--border)', fontSize: 'var(--fs-sm)' }}
                  />
                  <select value={newColType || inferMappingOutputType(mapping)} onChange={(e) => setNewColType(e.target.value)}
                    title="Column type (defaults to the transform's output type)"
                    style={{ padding: '5px 6px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 'var(--fs-sm)' }}>
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
                onClick={() => {
                  const preset = mapping.preset || 'joinArray';
                  onUpdate({ ...mapping, transform: 'PRESET', preset, presetConfig: defaultPresetConfig(preset, mapping.presetConfig) });
                }}>
                Preset
              </button>
              <button className={`transform-mode-btn${mapping.transform === 'EXPRESSION' ? ' active' : ''}`}
                onClick={() => onUpdate({ ...mapping, transform: 'EXPRESSION', expression: mapping.expression || generateExpression(mapping.sources, mapping.srcTypes, mapping.destinations, mapping.destTypes) })}>
                JavaScript
              </button>
            </div>

            {mapping.transform === 'PRESET' && (
              <>
                <select
                  value={mapping.preset || ''}
                  // Switching preset re-seeds the new preset's default options and drops the old
                  // preset's — stale keys would otherwise ride along into presetConfig.
                  onChange={e => onUpdate({ ...mapping, preset: e.target.value, presetConfig: defaultPresetConfig(e.target.value) })}
                  style={{ width: '100%', marginBottom: 8 }}>
                  {Object.entries(PRESET_GROUPS).map(([group, presets]) => (
                    <optgroup key={group} label={group}>
                      {presets.map(p => (
                        <option key={p.value} value={p.value}>{p.label} &mdash; {p.desc}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>

                {presetConfigSpec(mapping.preset) && (
                  <PresetConfigFields
                    preset={mapping.preset}
                    config={mapping.presetConfig}
                    onChange={(presetConfig) => onUpdate({ ...mapping, presetConfig })}
                  />
                )}

                {configIssue && (
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning-on)', marginBottom: 8 }}>
                    &#9888; {configIssue}
                  </div>
                )}
              </>
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
  /* Which way the user is moving through the wizard. The step content enters from
     the side it came from, so Back reads as retreating rather than as another
     forward move. `stepKey` re-mounts the container so the animation re-triggers. */
  const [stepDir, setStepDir] = useState('fwd');
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

  // Which runtimeKinds the BUS can actually run. A connector can be authored, tested and
  // fetched (client-side) for a kind that has NO bus source/destination factory — the whole
  // wizard then succeeds until Push, which 400s with "can't be run on the bus". We gate the
  // pickers on this instead. Starts `enforced:false` so nothing is blocked until the real
  // answer arrives (and stays unblocked if the hub is off / the call fails).
  const [runnableKinds, setRunnableKinds] = useState({ sources: [], destinations: [], enforced: false });

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
  const [cloneStatus, setCloneStatus] = useState('idle'); // idle | cloning | cloned | error
  const [deleteStatus, setDeleteStatus] = useState('idle'); // idle | confirming | deleting | deleted
  const [activeIntegrationId, setActiveIntegrationId] = useState(null); // tracks which saved connection is loaded

  // Step 3 — Entities
  const [entities, setEntities] = useState([]);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [selectedEntity, setSelectedEntity] = useState(null);
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState('');

  // ── Field-level encryption (optional) ──
  // encryptFields holds DESTINATION column names to encrypt before the push. The
  // data key is generated + stored server-side; the UI only toggles + reveals it.
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [encryptFields, setEncryptFields] = useState([]);
  const [revealedKey, setRevealedKey] = useState(null);
  const [revealMsg, setRevealMsg] = useState('');

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
  // Cross-entity joins (enrichment/lookup/aggregate). Each exposes @join.<alias>.<as> fields.
  const [joins, setJoins] = useState([]);
  const [expandedMapping, setExpandedMapping] = useState(-1);
  const [srcSearch, setSrcSearch] = useState('');
  const [destSearch, setDestSearch] = useState('');
  // Which destination column to dedup/upsert by. '' = default (first mapping); '__append__' = no matching (append every row).
  const [matchKey, setMatchKey] = useState('');

  // Multi-target fan-out (Step 3): EXTRA destination targets beyond the primary one
  // configured above. Each extra target reuses the primary connection + credentials and adds
  // another table/list on the same server; per-column routing lives on each mapping (routes).
  // Empty ⇒ legacy single-destination behaviour (no `targets`/`routes` emitted on save).
  // Each extra target: { targetId, label, table, naturalKeyColumn } and OPTIONAL cross-server
  // fields { connectorId, destCredId, host, port, database, schema, siteUrl, advancedOpen }.
  // When connectorId is blank ⇒ same server as the primary (reuse its connection + creds).
  const [extraTargets, setExtraTargets] = useState([]);
  const [targetsPanelOpen, setTargetsPanelOpen] = useState(false);
  const addExtraTarget = () => setExtraTargets((prev) => [...prev, { targetId: `t${Date.now()}${prev.length}`, label: '', table: '', naturalKeyColumn: '', connectorId: '', destCredId: '', host: '', port: '', database: '', schema: '', siteUrl: '', advancedOpen: false }]);
  const updateExtraTarget = (i, patch) => setExtraTargets((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const removeExtraTarget = (i) => setExtraTargets((prev) => prev.filter((_, j) => j !== i));

  // Multi-entity group: tag several saved connections (entities) with a shared groupId so they
  // can be run together via "Run all in group" (POST /run-group). Empty ⇒ ungrouped.
  const [groupId, setGroupId] = useState('');
  // Run order inside the group (parents before children). Kept as a STRING so the
  // number input can be cleared; coerced once on save.
  const [groupOrder, setGroupOrder] = useState('');
  const [groupRunStatus, setGroupRunStatus] = useState('idle'); // idle | running | done | error
  const [groupRunResult, setGroupRunResult] = useState(null);
  // Credentials list for the cross-server target picker (loaded on mount).
  const [credentialsList, setCredentialsList] = useState([]);

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
  const isScrape = (label) => connectorMeta[label]?.runtimeConfig?.runtimeKind === 'scrape';
  const scrapeLoginMethod = (label) => {
    const v = String(connectorMeta[label]?.runtimeConfig?.categoryConfig?.loginMethod ?? '').toLowerCase();
    if (v.includes('password')) return 'password';
    if (v.includes('session') || v.includes('record') || v.includes('2fa')) return 'session';
    return 'none';
  };
  // Can the bus actually RUN this connector on this side? Returns '' when it can, or the
  // reason why not. Fails OPEN: unknown kind, meta not loaded yet, or enforcement off ⇒ ''.
  const notRunnable = (label, side) => {
    if (!runnableKinds.enforced) return '';
    const kind = connectorMeta[label]?.runtimeConfig?.runtimeKind;
    if (!kind) return '';
    const list = side === 'source' ? runnableKinds.sources : runnableKinds.destinations;
    if (list.includes(kind)) return '';
    return `"${label}" (${kind}) can't run as a ${side} on the integration bus yet — you could configure it, but the push would fail. Pick another ${side}.`;
  };

  const connectorIdOf = (label) => connectorMeta[label]?.connectorId;
  const versionIdOf = (label) => connectorMeta[label]?.latestVersionId;
  // Resolve a destination connector id → its label + runtime kind (for the cross-server picker).
  const destLabelById = (id) => (destCards.find((c) => c.connectorId === id)?.label) || '';
  const connectorKindById = (id) => connectorMeta[destLabelById(id)]?.runtimeConfig?.runtimeKind || '';

  // Fan-out targets for the Mapping step's per-column routing selector. Empty unless the user
  // added ≥1 extra destination target (then: primary + each named extra). Drives MappingRow.
  const activeExtraTargets = extraTargets.filter((t) => (t.table || '').trim());
  const routeTargets = activeExtraTargets.length
    ? [
        { targetId: 'primary', label: `Primary (${(createNewTable ? newTableName : selectedPgTable) || destCreds.listName || selectedDest || 'primary'})` },
        ...activeExtraTargets.map((t) => ({ targetId: t.targetId, label: t.label || t.table })),
      ]
    : [];

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

  // ─── Which kinds the bus can run (gates the Step 1 pickers) ──
  useEffect(() => {
    (async () => {
      const r = await api.getRunnableKinds();
      const d = r.ok && r.data?.success ? r.data.data : null;
      // Only enforce when the backend positively reports both lists — any failure leaves the
      // pickers fully open (previous behaviour).
      if (d?.enforced) setRunnableKinds({ sources: d.sources || [], destinations: d.destinations || [], enforced: true });
    })();
  }, []);

  // ─── Load credentials (for the cross-server target picker) ──
  useEffect(() => {
    (async () => {
      const r = await api.getCredentials();
      if (r.ok && r.data?.data) setCredentialsList(r.data.data);
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

    // Restore the entity group tag.
    setGroupId(fm.groupId || '');
    setGroupOrder(fm.groupOrder != null ? String(fm.groupOrder) : '');

    // Restore cross-entity joins.
    setJoins(Array.isArray(fm.joins) ? fm.joins : []);

    // Restore field-level encryption config (the wrapped key stays server-side).
    setEncryptionEnabled(!!fm.encryption?.enabled);
    setEncryptFields(Array.isArray(fm.encryption?.fields) ? fm.encryption.fields : []);
    setRevealedKey(null); setRevealMsg('');

    // Restore the SharePoint source list selection so a re-save keeps it and the
    // server-side run can resolve the list (fixes "List '' not found on this site").
    if (fm.listId) setSelectedEntity(fm.listId);

    // Restore multi-target fan-out (extra targets beyond the primary). The primary target is
    // already represented by the destination config loaded above, so drop it here. A target is
    // "cross-server" when it pinned its own connector (≠ this integration's primary).
    if (Array.isArray(fm.targets) && fm.targets.length > 1) {
      const primaryConnId = intg.destConnectorId;
      setExtraTargets(
        fm.targets
          .filter((t) => t.targetId !== 'primary')
          .map((t) => {
            const cfg = t.config || {};
            const cross = !!t.connectorId && t.connectorId !== primaryConnId;
            return {
              targetId: t.targetId,
              label: t.label || '',
              table: (cfg.pgTable ?? cfg.destTable ?? cfg.listName ?? cfg.destListName ?? '') || '',
              naturalKeyColumn: t.naturalKeyColumn || '',
              connectorId: cross ? t.connectorId : '',
              destCredId: cross ? (cfg.destCredId || '') : '',
              host: cross ? (cfg.pgHost || '') : '', port: cross ? (cfg.pgPort || '') : '',
              database: cross ? (cfg.pgDatabase || '') : '', schema: cross ? (cfg.pgSchema || '') : '',
              siteUrl: cross ? (cfg.siteUrl || '') : '',
              advancedOpen: cross,
            };
          }),
      );
      setTargetsPanelOpen(true);
    } else {
      setExtraTargets([]);
    }

    // Track which integration is loaded
    setActiveIntegrationId(intg.integrationId);
    setSaveStatus('idle');
    setSaveMsg('');
    setDeleteStatus('idle');

    // Move to step 2
    setStepDir('fwd');
    setWizardStep(2);
  };

  // ─── Navigation ──────────────────────────────────────────
  const goBack = () => { setStepDir('back'); setWizardStep(prev => Math.max(1, prev - 1)); };
  /* Why Next is disabled, in words — mirrors the old boolean exactly, but the
     bar can now say what is missing instead of showing a dead button. */
  const nextBlocked = (() => {
    if (wizardStep === 1 && !selectedSource && !selectedDest) return 'Pick a source and a destination';
    if (wizardStep === 1 && !selectedSource) return 'Pick a source system';
    if (wizardStep === 1 && !selectedDest) return 'Pick a destination system';
    if (wizardStep === 2 && srcTestStatus !== 'connected' && destTestStatus !== 'connected') return 'Test both connections';
    if (wizardStep === 2 && srcTestStatus !== 'connected') return 'Test the source connection';
    if (wizardStep === 2 && destTestStatus !== 'connected') return 'Test the destination connection';
    if (wizardStep === 3 && !selectedEntity) return 'Choose an entity';
    if (wizardStep === 3 && isSpSource(selectedDest) && !destCreds.listName) return 'Name the destination list';
    // goNext() also refuses step 3 -> 4 for a DB destination with no table
    // chosen. That condition was missing here, so Next rendered ENABLED and
    // then silently did nothing — the dead button this hint exists to prevent.
    if (wizardStep === 3 && isDbDest(selectedDest)
      && !(createNewTable ? newTableName : selectedPgTable) && !destCreds.table) {
      return createNewTable ? 'Name the new table' : 'Pick a destination table';
    }
    if (wizardStep === 5 && fetchStatus !== 'done') return 'Fetch a preview first';
    if (wizardStep === 6 && (pushStatus === 'pushing' || pushStatus === 'polling')) return 'Push in progress\u2026';
    return null;
  })();

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
    setStepDir('fwd');
    setWizardStep(prev => Math.min(6, prev + 1));
  };

  // ─── Step 5: Fetch source data ─────────────────────────
  // PREFERRED PATH: ask the SERVER to read + map exactly as Push will (preview-integration
  // runs the same source factory, the same entity resolution and the same MappingEngine).
  // The client-side branches below read through a DIFFERENT path — that divergence is what
  // let "preview shows 10 rows / push writes 1 empty row" happen twice. They now serve only
  // as a fallback when the recipe can't be previewed server-side (not saveable yet, hub off,
  // or the endpoint errors), so behaviour is never worse than before.
  const PREVIEW_LIMIT = 50;
  const tryServerPreview = async () => {
    try {
      const id = await handleSaveConnection(); // persists the recipe; returns integrationId
      if (!id) return false;
      const res = await api.previewIntegration(id, PREVIEW_LIMIT);
      if (!res.ok || !res.data?.success) return false;
      const sample = res.data.data?.sample || [];
      if (!sample.length) return false; // fall back rather than show an empty preview
      setFetchResult({
        runId: `preview-${id}`,
        tickets: sample.map((s) => s.raw),
        totalCount: sample.length,
        // Marks this as the authoritative server read, and carries the server's OWN mapped
        // rows so Step 5 reviews what will actually be written — not a client re-computation.
        serverPreview: true,
        previewLimit: PREVIEW_LIMIT,
        mappedSample: sample.map((s) => s.mapped),
      });
      return true;
    } catch { return false; }
  };

  const handleFetchData = async () => {
    setFetchStatus('fetching');
    setFetchError('');
    setFetchResult(null);
    try {
      if (await tryServerPreview()) { setFetchStatus('done'); return; }
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
    } catch {
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
    // (run in the backend quickjs sandbox) — maps server-side. The Wizard persists the
    // recipe and triggers run-integration; the dataset never crosses HTTP, so payload size
    // is irrelevant. This is the ONLY push path — the pre-bus client-side handlers that used
    // to sit here (deliverViaBus / mapRecordsToDest / handleSpDestPush / handleRestPush /
    // handleRestToDbPush / handlePushTo*) were deleted: they were unreachable, and keeping a
    // second write path one call away from the live one invited a bus bypass.
    await pushServerSide();
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
        const srcProbe = result.data?.data || {};
        // data.ok is the CONNECTION result; data.success only means the request
        // was handled. Checking the envelope alone reported "Connected" for a
        // connector that had plainly failed to connect.
        if (result.ok && result.data?.success && srcProbe.ok !== false) {
          const d = srcProbe;
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
        const destProbe = result.data?.data || {};
        if (result.ok && result.data?.success && destProbe.ok !== false) {
          const d = destProbe;
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
      // ── Multi-target fan-out ──────────────────────────────────────────
      // Only when EXTRA targets exist do we emit `targets` + per-mapping `routes`. With none,
      // mappings are saved exactly as today (routes stripped) so legacy integrations are
      // byte-identical and the backend's normalizeTargets keeps the single-dest behaviour.
      const primaryKey = matchKey === '__append__' ? '' : (effectiveKey || '');
      const hasFanout = extraTargets.some((t) => (t.table || '').trim());
      let fanoutTargets;
      // `routes` is destructured purely to DROP it from each mapping (stale fan-out routing).
      // eslint-disable-next-line no-unused-vars
      let mappingsOut = mappings.map(({ routes, ...rest }) => rest);
      if (hasFanout) {
        const dbDest = isDbDest(selectedDest);
        const primaryConfig = dbDest
          ? { destType: selectedDest, pgHost: destCreds.host, pgPort: destCreds.port, pgDatabase: destCreds.database, pgSchema: destCreds.schema, pgTable: (createNewTable ? newTableName : selectedPgTable), naturalKeyColumn: primaryKey }
          : { siteUrl: destCreds.siteUrl, listName: destCreds.listName, naturalKeyColumn: primaryKey };
        const primaryTarget = { targetId: 'primary', label: `Primary (${primaryConfig.pgTable || primaryConfig.listName || selectedDest})`, connectorId: connectorIdOf(selectedDest), naturalKeyColumn: primaryKey, config: primaryConfig };
        // Each extra target: by default reuse the primary connector + credentials (config omits
        // destCredId, so the backend inherits the primary's vaulted cred) — same server, another
        // table/list. When the target picked its OWN connector (cross-server), use that
        // connector + its credential + its connection fields instead.
        const extra = extraTargets.filter((t) => (t.table || '').trim()).map((t) => {
          const xKey = t.naturalKeyColumn || primaryKey;
          const cross = !!t.connectorId;                       // picked a different connector/server
          const xConnId = cross ? t.connectorId : connectorIdOf(selectedDest);
          const xKind = cross ? connectorKindById(t.connectorId) : (dbDest ? 'database' : 'sharepoint');
          let config;
          if (xKind === 'database') {
            config = cross
              ? { destType: destLabelById(t.connectorId), pgHost: t.host, pgPort: t.port, pgDatabase: t.database, pgSchema: t.schema, pgTable: t.table, naturalKeyColumn: xKey, ...(t.destCredId ? { destCredId: t.destCredId } : {}) }
              : { destType: selectedDest, pgHost: destCreds.host, pgPort: destCreds.port, pgDatabase: destCreds.database, pgSchema: destCreds.schema, pgTable: t.table, naturalKeyColumn: xKey };
          } else {
            config = cross
              ? { siteUrl: t.siteUrl || destCreds.siteUrl, listName: t.table, naturalKeyColumn: xKey, ...(t.destCredId ? { destCredId: t.destCredId } : {}) }
              : { siteUrl: destCreds.siteUrl, listName: t.table, naturalKeyColumn: xKey };
          }
          return { targetId: t.targetId, label: t.label || t.table, connectorId: xConnId, naturalKeyColumn: xKey, config };
        });
        fanoutTargets = [primaryTarget, ...extra];
        const validIds = new Set(fanoutTargets.map((t) => t.targetId));
        // Route each destination column to its chosen target (default 'primary').
        mappingsOut = mappings.map((m) => {
          const existing = m.routes || [];
          // The KEY mapping MUST reach EVERY target — each target upserts/merges by its own
          // natural-key column, so a target that never receives the key can't dedup/merge
          // (DB appends duplicates; SharePoint delivery fails with "no natural key"). Force
          // the key mapping to route to all targets using each target's key column name,
          // regardless of the per-column dropdown.
          const isKeyMapping = primaryKey && (m.destinations || []).includes(primaryKey);
          if (isKeyMapping) {
            return { ...m, routes: fanoutTargets.map((t) => ({ targetId: t.targetId, column: t.naturalKeyColumn || primaryKey })) };
          }
          const routes = (m.destinations || []).map((col) => {
            const r = existing.find((x) => x.column === col);
            return { targetId: r && validIds.has(r.targetId) ? r.targetId : 'primary', column: col };
          });
          return { ...m, routes };
        });
      }

      // Cross-entity joins: drop half-filled pull/aggregate rows and incomplete joins so an
      // in-progress panel never trips the backend's validateJoins (which 400s on bad joins).
      const joinsOut = joins
        .map((j) => ({
          ...j,
          pull: (j.pull || []).filter((p) => p.column && p.as),
          aggregate: (j.aggregate || []).filter((a) => a.as && a.fn && (a.fn === 'count' || a.column)),
        }))
        .filter((j) => j.alias && j.entity?.ref && j.entity?.keyColumn && j.on?.localField && (j.pull.length || j.aggregate.length));

      // Read-side credential bag: every srcCreds value as a string, minus uploaded file
      // content (that's a payload, not a secret, and would bloat the credential row).
      const sourceCredsOut = Object.fromEntries(
        Object.entries(srcCreds)
          .filter(([k, v]) => k !== 'fileContent' && v != null && v !== '' && typeof v !== 'object')
          .map(([k, v]) => [k, String(v)]),
      );

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
        // SharePoint SOURCE list (the picked entity id + display name) so the saved
        // connection knows which list to read on a server-side run — without it the
        // backend resolves a blank name and fails with "List '' not found on this site".
        sourceListId: isSpSource(selectedSource) ? (selectedEntity || undefined) : undefined,
        sourceListName: isSpSource(selectedSource) ? (entities.find((e) => e.id === selectedEntity)?.name || undefined) : undefined,
        // Runtime/scrape SOURCE entity (the picked entity key) so a server-side run crawls the
        // RIGHT entity. Without it the scrape/runtime factory defaults to 'page' and returns a
        // single empty record — the Fetch preview works only because the client passes the entity directly.
        sourceEntity: isRuntimeSource(selectedSource) ? (selectedEntity || undefined) : undefined,
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
        mappings: mappingsOut,
        naturalKeyColumn: matchKey === '__append__' ? '' : (effectiveKey || undefined),
        // Jira-only: the saved recipe shouldn't claim a read window for sources that ignore it.
        dateFrom: selectedSource === 'Jira' ? (dateStart || undefined) : undefined,
        dateTo: selectedSource === 'Jira' ? (dateEnd || undefined) : undefined,
        // Fan-out targets — only present when the user added extra destinations.
        ...(hasFanout ? { targets: fanoutTargets } : {}),
        // Entity group tag — only present when the user grouped this connection.
        ...(groupId ? { groupId } : {}),
        // Load order within that group — only sent when the user set one.
        ...(groupId && groupOrder !== '' && Number.isFinite(Number(groupOrder)) ? { groupOrder: Number(groupOrder) } : {}),
        // Cross-entity joins — only present when the user configured at least one complete join.
        ...(joinsOut.length ? { joins: joinsOut } : {}),
        // Field-level encryption — the backend generates/wraps the key; we send only
        // the toggle + which destination columns to encrypt. Sent unconditionally so
        // turning it OFF clears any prior config server-side.
        encryption: { enabled: encryptionEnabled, fields: encryptionEnabled ? encryptFields : [] },
        // Generic READ-side credentials for runtime sources (DB host/user/password, SOAP
        // endpoint, IMAP login…). One opaque bag — the backend encrypts it as `srcCredId`
        // and the runtime picks out the keys it needs, so no per-connector fields are added
        // here. Without this a server-side run builds the source with empty creds and can't
        // connect. `fileContent` is excluded: an uploaded file is data, not a credential.
        ...(isRuntimeSource(selectedSource) ? { sourceCreds: sourceCredsOut } : {}),
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

  // ─── Run ALL entities in this group (serial) ───────────
  // Triggers POST /run-group/:groupId — every ACTIVE saved connection tagged with the same
  // groupId runs one after another. Surfaces per-entity delivered/failed counts.
  const handleRunGroup = async () => {
    if (!groupId) return;
    setGroupRunStatus('running');
    setGroupRunResult(null);
    try {
      const res = await api.runGroup(groupId);
      if (res.ok && res.data?.success) {
        setGroupRunResult(res.data.data);
        setGroupRunStatus('done');
      } else {
        setGroupRunResult({ error: res.data?.error || 'Run all failed' });
        setGroupRunStatus('error');
      }
    } catch {
      setGroupRunResult({ error: 'Network error during group run' });
      setGroupRunStatus('error');
    }
  };

  // ─── Save as new copy (Clone) ──────────────────────────
  // Forks the currently-loaded connection into a brand-new, independent one (new id,
  // status 'draft') and switches the wizard to edit the copy. The ORIGINAL is left
  // untouched. Vault credentials are SHARED by reference (not duplicated), matching the
  // backend clone endpoint — rotating/revoking a cred still affects both. Clones the LAST
  // SAVED state, so Save first if you have pending edits you want carried into the copy.
  const handleCloneConnection = async () => {
    if (!activeIntegrationId) return;
    setCloneStatus('cloning');
    setSaveMsg('');
    try {
      const res = await api.cloneIntegration(activeIntegrationId);
      if (res.ok && res.data?.success && res.data.data) {
        // Load the copy into the wizard (sets the new activeIntegrationId, shared creds, mappings).
        await applySavedConnection(res.data.data);
        setCloneStatus('cloned');
        setSaveStatus('idle');
        setSaveMsg('Saved as a new copy (shared credentials) — you are now editing the copy. The original is unchanged.');
        const connRes = await api.getSavedConnections();
        if (connRes.ok && connRes.data?.data) {
          setSavedConnections(connRes.data.data.filter(c => c.status === 'active'));
        }
      } else {
        setCloneStatus('error');
        setSaveMsg(res.data?.error || 'Failed to clone connection');
      }
    } catch {
      setCloneStatus('error');
      setSaveMsg('Network error while cloning');
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

  // Re-arm the Push button when the RECIPE changes after a completed push. If the user
  // finishes a push, goes back, and edits the mapping / dedup key / source scope / date
  // window / destination, the prior 'done' state would otherwise stick and only offer
  // "Done" — hiding the fact that the new format needs pushing again. Reset to 'idle' so
  // Step 6 shows "▶ Push" once more. Guarded by `hydrated` so restoring a saved 'done'
  // state on resume doesn't immediately clobber itself.
  useEffect(() => {
    if (!hydrated) return;
    if (pushStatus === 'done') {
      setPushStatus('idle');
      setPushResult(null);
      setQuickView(null);
    }
  }, [mappings, matchKey, selectedSource, selectedDest, selectedEntity, selectedProject, dateStart, dateEnd]); // eslint-disable-line react-hooks/exhaustive-deps

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
      if (Array.isArray(s.joins)) setJoins(s.joins);
      if (s.fetchResult) setFetchResult(s.fetchResult);
      if (s.fetchStatus) setFetchStatus(s.fetchStatus);
      if (s.matchKey) setMatchKey(s.matchKey);
      if (s.connectionName) setConnectionName(s.connectionName);
      if (s.dateStart) setDateStart(s.dateStart);
      if (s.dateEnd) setDateEnd(s.dateEnd);
      if (s.selectedPgTable) setSelectedPgTable(s.selectedPgTable);
      if (typeof s.createNewTable === 'boolean') setCreateNewTable(s.createNewTable);
      if (s.newTableName) setNewTableName(s.newTableName);
      if (Array.isArray(s.extraTargets)) setExtraTargets(s.extraTargets);
      if (s.groupId) setGroupId(s.groupId);
      if (s.groupOrder) setGroupOrder(s.groupOrder);
      if (s.activeIntegrationId) setActiveIntegrationId(s.activeIntegrationId);
      // Push progress — so a return mid-push shows where it's at.
      if (s.pushResult) setPushResult(s.pushResult);
      if (s.pushError) setPushError(s.pushError);
      if (s.pushProgress) setPushProgress(s.pushProgress);
      if (s.pushStatus) setPushStatus(s.pushStatus);
      if (s.wizardStep) { setStepDir('fwd'); setWizardStep(s.wizardStep); }
      // If a push was still in flight when we left, re-attach to its progress poll so it
      // resumes updating instead of sitting frozen.
      if (s.pushStatus === 'polling' && s.pushResult?.pushRunId) {
        pollRunStatus(s.pushResult.pushRunId);
      }
    } catch { /* ignore a corrupt snapshot */ }
    setHydrated(true);
  }, []);

  // Continuously persist the wizard session so navigating away / refreshing can resume it.
  // Gated on `hydrated` so the initial empty render never clobbers a saved snapshot before
  // the restore effect above has applied it (both run in one batched update on mount).
  useEffect(() => {
    if (!hydrated) return;
    try {
      sessionStorage.setItem(WIZARD_STATE_KEY, JSON.stringify({
        wizardStep, selectedSource, selectedDest, selectedEntity, selectedProject,
        srcCreds, destCreds, srcConnectionData, destConnectionData,
        srcTestStatus, destTestStatus, srcFields, destFields, mappings, joins,
        fetchResult, fetchStatus, matchKey, connectionName, dateStart, dateEnd,
        selectedPgTable, createNewTable, newTableName, extraTargets, groupId, groupOrder, activeIntegrationId,
        pushStatus, pushResult, pushError, pushProgress,
      }));
    } catch { /* sessionStorage full / serialization issue — non-fatal */ }
  }, [
    hydrated,
    wizardStep, selectedSource, selectedDest, selectedEntity, selectedProject,
    srcCreds, destCreds, srcConnectionData, destConnectionData,
    srcTestStatus, destTestStatus, srcFields, destFields, mappings, joins,
    fetchResult, fetchStatus, matchKey, connectionName, dateStart, dateEnd,
    selectedPgTable, createNewTable, newTableName, extraTargets, groupId, groupOrder, activeIntegrationId,
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
    setSrcFields([]); setDestFields([]); setMappings([]); setJoins([]);
    setFetchResult(null); setFetchStatus('idle'); setFetchError('');
    setMatchKey(''); setConnectionName(''); setActiveIntegrationId(null);
    setSelectedPgTable(''); setCreateNewTable(false); setNewTableName('');
    setExtraTargets([]); setTargetsPanelOpen(false);
    setGroupId(''); setGroupRunStatus('idle'); setGroupRunResult(null);
    setEncryptionEnabled(false); setEncryptFields([]); setRevealedKey(null); setRevealMsg('');
    setPushStatus('idle'); setPushResult(null); setPushError(''); setPushProgress(null);
    setStepDir('back');
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
          // Same as the runtime branch below: a DB source has no Jira "project" — the
          // picked TABLE is the scope. (This used to display as `Source: db`.)
          setProjects([]);
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
        // `selectedProject` is the JIRA project key — runtime connectors have no such scope.
        // It used to be faked as 'api' here, which then surfaced as `Source: api` in Steps 5/6
        // and was persisted as a junk `projectKey`. The ENTITY is the scope for these sources.
        setProjects([]);
        const def = ents.find((e) => e.defaultOn) || ents[0];
        if (def) setSelectedEntity(def.id);
      };
      const staticEnts = (meta?.entities || []).map((e) => ({
        id: e.key, name: e.name, fieldCount: (e.fields || []).length, available: true, defaultOn: e.defaultOn,
      }));
      // Scrape connectors define their REAL entities in the crawl recipe
      // (categoryConfig.entities), surfaced only via discoverEntities. Their design-time
      // entity list is a single "Scraped Page" placeholder that would otherwise shadow the
      // author's recorded entities — so for scrape we always ask the runtime, and fall back
      // to the placeholder only if discovery returns nothing.
      const preferDiscover = isScrape(selectedSource);
      if (staticEnts.length && !preferDiscover) {
        applyEnts(staticEnts);
      } else {
        setEntitiesLoading(true);
        runtimeClient.discoverEntities(meta?.connectorId, meta?.latestVersionId, srcCreds)
          .then((res) => {
            const disc = (res.ok && res.data?.success ? res.data.data : []) || [];
            const mapped = disc.map((e) => ({ id: e.key, name: e.name, fieldCount: e.fieldCount ?? 0, available: true, defaultOn: true }));
            applyEnts(mapped.length ? mapped : staticEnts);
          })
          .catch(() => { if (staticEnts.length) applyEnts(staticEnts); /* else: user sees "no entities" */ })
          .finally(() => setEntitiesLoading(false));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on step-3 entry; source kind/creds are read at trigger time and must NOT re-run this discovery on their change
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads Jira entities on project select; creds/source read at call time, deliberately not reactive deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads mapping fields on entering step 4; source/dest config read at trigger time, deliberately not reactive deps
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

  // Synthetic source fields produced by joins (@join.<alias>.<as>) — selectable in mappings
  // exactly like native source fields. Derived from the joins config, not the source system.
  const joinFields = useMemo(() =>
    joins.flatMap((j) =>
      [...(j.pull || []), ...(j.aggregate || [])]
        .filter((o) => o.as && j.alias)
        .map((o) => ({ name: `@join.${j.alias}.${o.as}`, type: 'join' })),
    ), [joins]);
  // The field list the mapper picker + rows see: native source fields plus join outputs.
  const srcFieldsAll = useMemo(() => [...srcFields, ...joinFields], [srcFields, joinFields]);

  // On-demand: a destination table's real column names — powers the Joins panel's column
  // dropdowns so users pick instead of typing. Returns [] on any miss (panel falls back to
  // free-text, e.g. for a table that doesn't exist yet). Reuses the same handler the
  // destination step uses to read columns.
  const loadDestColumns = useCallback(async (table) => {
    if (!isDbDest(selectedDest) || !table) return [];
    const cfg = connectorMeta[selectedDest]?.runtimeConfig;
    const dbCfg = destConnectionData || destCreds;
    if (!cfg?.handlers?.columns || !dbCfg.host || !dbCfg.database) return [];
    const res = await api.call(cfg.handlers.columns, {
      host: dbCfg.host, port: Number(dbCfg.port) || cfg.defaultPort,
      database: dbCfg.database, username: dbCfg.username, password: dbCfg.password,
      schema: cfg.hasSchema ? (destCreds.schema || cfg.defaultSchema) : undefined,
      table,
    });
    const cols = res.ok && res.data?.success && res.data.data?.exists ? (res.data.data.columns || []) : [];
    return cols.map((c) => c.name || c.columnName).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads dest config at call time; the listed deps cover identity, extra ones would needlessly churn the memo
  }, [selectedDest, destConnectionData, destCreds, connectorMeta]);

  // Generic, side-aware discovery for the Joins panel (works for any adapter).
  // Entities to offer for a side: destination DB tables, or the source's discovered entities/lists.
  const entitiesForSide = useCallback((side) => (
    side === 'dest' ? pgTables.map((t) => t.name) : entities.map((e) => e.name).filter(Boolean)
  ), [pgTables, entities]);

  // Columns of a chosen entity on a side. Dest → DB introspection. Source → the selected entity's
  // already-loaded fields, else a runtime field-discovery call; unknown → [] (panel falls back to typing).
  const loadColumnsForSide = useCallback(async (side, entity) => {
    if (!entity) return [];
    if (side === 'dest') return loadDestColumns(entity);
    const selName = entities.find((e) => e.id === selectedEntity)?.name;
    if (entity === selName) return srcFields.map((f) => f.name);
    if (isSpSource(selectedSource)) {
      // Another SharePoint list: discover its columns by the list's id + the site id.
      const ent = entities.find((e) => e.name === entity || e.id === entity);
      const siteId = srcConnectionData?.siteId;
      if (ent?.id && siteId) {
        const res = await api.call('/api/hub/sp-list-fields', {
          siteId, listId: ent.id,
          tenantId: srcCreds.tenantId, clientId: srcCreds.clientId, clientSecret: srcCreds.clientSecret,
        });
        if (res.ok && res.data?.success) return (res.data.data?.fields || []).map((f) => f.name).filter(Boolean);
      }
      return [];
    }
    if (isRuntimeSource(selectedSource)) {
      const meta = connectorMeta[selectedSource];
      const res = await runtimeClient.discoverFields(meta?.connectorId, meta?.latestVersionId, srcCreds, entity);
      if (res.ok && res.data?.success) return (res.data.data || []).map((f) => f.name).filter(Boolean);
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pure in-scope helpers (isSpSource/isRuntimeSource) omitted deliberately; they change identity each render and would defeat the memo
  }, [pgTables, entities, selectedEntity, srcFields, selectedSource, connectorMeta, srcCreds, srcConnectionData, loadDestColumns]);

  // Generic "where does the value live?" options — reflect THIS connection's actual connectors so
  // the join feature reads naturally for any adapter: PostgreSQL → "table", SharePoint → "list",
  // Keka/REST/others → "entity". `discover` marks a side whose schema we can list (dest DB today).
  const nounForConnector = (label) => (isDbDest(label) ? 'table' : isSpSource(label) ? 'list' : 'entity');
  const joinSides = useMemo(() => [
    { side: 'dest', label: selectedDest || 'Destination', noun: nounForConnector(selectedDest), discover: isDbDest(selectedDest) },
    { side: 'source', label: selectedSource || 'Source', noun: nounForConnector(selectedSource), discover: true },
  ], [selectedSource, selectedDest]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ensure the destination table list exists on the mapping step (it may be empty if a saved
  // connection was opened straight into step 4) — powers the Joins panel's table dropdown.
  useEffect(() => {
    if (wizardStep !== 4 || !isDbDest(selectedDest) || pgTables.length) return;
    const cfg = connectorMeta[selectedDest]?.runtimeConfig;
    const dbCfg = destConnectionData || destCreds;
    if (!cfg?.handlers?.listTables || !dbCfg.host || !dbCfg.database) return;
    (async () => {
      const res = await api.call(cfg.handlers.listTables, {
        host: dbCfg.host, port: Number(dbCfg.port) || cfg.defaultPort,
        database: dbCfg.database, username: dbCfg.username, password: dbCfg.password,
        schema: cfg.hasSchema ? (destCreds.schema || cfg.defaultSchema) : undefined,
      });
      if (res.ok && res.data?.success) setPgTables(res.data.data?.tables || []);
    })();
  }, [wizardStep, selectedDest]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Filtered field lists for Step 4 ────────────────────
  const filteredSrc = useMemo(() => {
    if (!srcSearch) return srcFieldsAll;
    const q = srcSearch.toLowerCase();
    return srcFieldsAll.filter(f => f.name.toLowerCase().includes(q));
  }, [srcFieldsAll, srcSearch]);

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

  // What the source actually reads, for the Step 5/6 summaries. Jira scopes by PROJECT;
  // every other source scopes by the picked entity (SP list / DB table / scrape entity).
  const sourceScopeLabel = useMemo(() => {
    const entityLabel = entities.find((e) => e.id === selectedEntity)?.name || selectedEntity || '';
    if (selectedSource === 'Jira') return [selectedProject, entityLabel].filter(Boolean).join(' / ');
    return entityLabel;
  }, [selectedSource, selectedProject, selectedEntity, entities]);

  // Validation
  const requiredUnmapped = useMemo(() =>
    destFields.filter(f => f.required && !mappedDestNames.has(f.name)),
  [destFields, mappedDestNames]);

  const statusStyle = (status) => {
    if (status === 'connected') return { color: 'var(--success-on)', borderColor: 'var(--success)' };
    if (status === 'error') return { color: 'var(--error-on)', borderColor: 'var(--error)' };
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
          <label htmlFor="wizardpage-field-2">{f.label}</label>
          <input id="wizardpage-field-2" type="text" value={creds[f.key] || ''} onChange={(e) => onChange(f.key, e.target.value)} placeholder={f.placeholder} />
        </div>
      )
    );

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Connection Wizard</h1>
          {/* The subtitle carries the route once it is known — the pipeline being
              built is more useful context than a restatement of the step count. */}
          <div className="page-subtitle">
            {selectedSource && selectedDest
              ? <>Building <strong>{selectedSource}</strong> &rarr; <strong>{selectedDest}</strong></>
              : 'Connect a source system to a destination in six steps'}
          </div>
        </div>
        <button className="btn btn-outline btn-sm" onClick={startOver}
          title="Clear this wizard session and start a new connection">Start over</button>
      </div>

      {/* Progress rail — completed steps are navigable, upcoming ones are not. */}
      <ol className="wiz-rail">
        {stepLabels.map((label, i) => {
          const n = i + 1;
          const state = n === wizardStep ? 'is-current' : n < wizardStep ? 'is-done' : 'is-todo';
          const done = n < wizardStep;
          const Tag = done ? 'button' : 'li';
          return (
            <Tag
              key={n}
              {...(done
                ? { type: 'button', onClick: () => { setStepDir('back'); setWizardStep(n); },
                    'aria-label': `Go back to step ${n}: ${label}` }
                : {})}
              className={`wiz-step ${state}`}
              aria-current={n === wizardStep ? 'step' : undefined}
            >
              <span className="wiz-step-token" aria-hidden="true">{done ? '✓' : n}</span>
              <span className="wiz-step-text">
                <span className="wiz-step-n">Step {n}</span>
                <span className="wiz-step-label">{label}</span>
              </span>
            </Tag>
          );
        })}
      </ol>

      <div className="page-body fit" style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Wizard content */}
      <div
        key={wizardStep}
        className={`wizard-content${stepDir === 'back' ? ' is-back' : ''}`}
        style={{ marginTop: 12, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}
      >

        {/* ── Step 1: Select Systems ── */}
        {wizardStep === 1 && (
          <div className="wizard-step active" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Saved Connections */}
            {savedConnections.length > 0 && (
              <div className="card" style={{ marginBottom: 20, padding: 16, flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <span style={{ fontSize: 'var(--fs-lg)' }}>&#128279;</span>
                  <span style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-md)' }}>My Connections</span>
                  <span className="badge badge-success" style={{ fontSize: 'var(--fs-xs)' }}>{savedConnections.length} saved</span>
                  <input value={connSearch} onChange={(e) => setConnSearch(e.target.value)} aria-label="Search saved connections" placeholder="Search connections..."
                    style={{ marginLeft: 'auto', maxWidth: 240, padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: 'var(--fs-sm)' }} />
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
                  <div className="conn-strip-wrap">
                  <div ref={connStripRef} className="conn-strip" onScroll={updateConnScroll} style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 2, flex: 1 }}>
                  {savedConnections.filter((intg) => {
                    const q = connSearch.trim().toLowerCase();
                    if (!q) return true;
                    const fm = intg.fieldMappings || {};
                    return [intg.name, fm.sourceType, fm.destType, fm.projectKey, fm.listName, fm.siteUrl, fm.endpointUrl].filter(Boolean).join(' ').toLowerCase().includes(q);
                  }).map((intg) => {
                    const fm = intg.fieldMappings || {};
                    // Force-deleting a connector UNLINKS the connections that used it
                    // (sourceConnectorId → null, see ConnectorAuthoringService.deleteConnector).
                    // Such a connection looks perfectly normal here but fails preflight with
                    // "No source connector is configured" only when you finally hit Push.
                    const orphaned = !intg.sourceConnectorId;
                    return (
                      <button
                        key={intg.integrationId}
                        type="button"
                        className={`conn-card${orphaned ? ' is-orphaned' : ''}`}
                        data-conn-card
                        title={orphaned ? 'This connection’s source connector was deleted — re-pick a source in Step 1 to repair it.' : undefined}
                        onClick={() => applySavedConnection(intg)}
                      >
                        <span className="conn-name">{intg.name}</span>
                        {orphaned && (
                          <span className="conn-warn">&#9888; source connector deleted</span>
                        )}
                        <span className="conn-route">
                          {fm.sourceType || 'Jira'} <span style={{ color: 'var(--text-dim)' }}>&rarr;</span> {fm.destType || 'SharePoint'}
                        </span>
                        <span className="conn-meta">
                          {fm.projectKey && <span className="badge badge-primary" style={{ marginRight: 4 }}>{fm.projectKey}</span>}
                          {fm.listName && <span>{fm.listName}</span>}
                        </span>
                        <span className="conn-meta">{hostnameOf(fm.siteUrl || fm.endpointUrl)}</span>
                      </button>
                    );
                  })}
                  </div>
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
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 8 }}>
                  Click a saved connection to auto-fill credentials and skip to Step 2. You can still change the project.
                </div>
              </div>
            )}
            {savedLoading && (
              <div style={{ marginBottom: 16, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>Loading saved connections...</div>
            )}

            <div className="wiz-flow">
              <div className="wiz-flow-col">
                <div className="wiz-col-head">
                  <span className="wiz-col-eyebrow">Source</span>
                  <span className={`wiz-col-value${selectedSource ? '' : ' is-empty'}`}>
                    {selectedSource || 'Not selected'}
                  </span>
                </div>
                <div className="wiz-col-search">
                  <input value={srcSysSearch} onChange={(e) => setSrcSysSearch(e.target.value)}
                    aria-label="Search source systems" placeholder="Search source systems…" />
                </div>
                <div className="wiz-picker-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 10 }}>
                    {sourceCards.filter((c) => c.label.toLowerCase().includes(srcSysSearch.trim().toLowerCase())).map((c, i) => {
                      const blocked = notRunnable(c.label, 'source');
                      return (
                      <SystemCard
                        key={i}
                        label={c.label}
                        icon={c.icon}
                        selected={selectedSource === c.label}
                        blocked={blocked}
                        onSelect={() => handleSourceSelect(c.label)}
                      />
                      );
                    })}
                  </div>
                </div>
              </div>
              {/* The direction of flow, stated once, between the two ends. */}
              <div className="wiz-flow-arrow" aria-hidden="true">
                <span className="wiz-flow-arrow-line" />
                <span className="wiz-flow-arrow-mark">&rarr;</span>
                <span className="wiz-flow-arrow-line" />
              </div>
              <div className="wiz-flow-col">
                <div className="wiz-col-head">
                  <span className="wiz-col-eyebrow">Destination</span>
                  <span className={`wiz-col-value${selectedDest ? '' : ' is-empty'}`}>
                    {selectedDest || 'Not selected'}
                  </span>
                </div>
                <div className="wiz-col-search">
                  <input value={destSysSearch} onChange={(e) => setDestSysSearch(e.target.value)}
                    aria-label="Search destination systems" placeholder="Search destination systems…" />
                </div>
                <div className="wiz-picker-scroll" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: 4 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 10 }}>
                    {destCards.filter((c) => c.label.toLowerCase().includes(destSysSearch.trim().toLowerCase())).map((c, i) => {
                      const blocked = notRunnable(c.label, 'destination');
                      return (
                      <SystemCard
                        key={i}
                        label={c.label}
                        icon={c.icon}
                        selected={selectedDest === c.label}
                        blocked={blocked}
                        onSelect={() => handleDestSelect(c.label)}
                      />
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 2: Credentials ── */}
        {wizardStep === 2 && (
          <div className="wizard-step active">
            <div className="card" style={{ marginBottom: 16, padding: '12px 16px' }}>
              <label style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)' }} htmlFor="wizardpage-connection-name">Connection name</label>
              <input id="wizardpage-connection-name"
                value={connectionName}
                onChange={(e) => setConnectionName(e.target.value)}
                placeholder={selectedSource && selectedDest ? `${selectedSource} → ${selectedDest}` : 'Name this integration'}
                style={{ width: '100%', marginTop: 6, padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text)', fontSize: 'var(--fs-md)' }}
              />
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>One name for this source → destination pipeline.</div>
            </div>
            <div className="grid-2" style={{ gap: 24 }}>
              <div className="card">
                <div style={{ fontWeight: 'var(--fw-semibold)', marginBottom: 12 }}>Source Credentials ({selectedSource})</div>
                {renderCredFields(getFields(selectedSource), srcCreds, handleSrcCredChange)}
                {isFlatFile(selectedSource) && (
                  <div className="form-group" style={{ marginTop: 8 }}>
                    <label htmlFor="wizardpage-upload-file-csv-tsv-json-xlsx">Upload file (CSV / TSV / JSON / XLSX)</label>
                    <input id="wizardpage-upload-file-csv-tsv-json-xlsx" type="file" accept=".csv,.tsv,.json,.xlsx,.xls" onChange={(e) => handleFileUpload(e.target.files?.[0])} />
                    {srcCreds.fileContent && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--success-on)', marginTop: 4 }}>✓ File loaded ({srcCreds.fileFormat})</div>}
                  </div>
                )}
                {/* Web Scraping, "Recorded Session" method: the operator logs in once here and
                    we store THEIR session on this connection (2FA-safe, multi-tenant). */}
                {isScrape(selectedSource) && scrapeLoginMethod(selectedSource) === 'session' && (
                  <SessionRecorder
                    startUrl={srcCreds.targetUrls || connectorMeta[selectedSource]?.runtimeConfig?.categoryConfig?.targetUrls}
                    onCapture={(enc) => handleSrcCredChange('sessionState', enc)}
                  />
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                  <Button className="btn btn-outline btn-sm" onClick={testSourceConnection} loading={srcTestStatus === 'testing'} loadingLabel="Testing" style={statusStyle(srcTestStatus)}>
                    {statusLabel(srcTestStatus)}
                  </Button>
                  {srcTestMsg && <span style={{ fontSize: 'var(--fs-sm)', color: srcTestStatus === 'connected' ? 'var(--success)' : 'var(--error)', flex: 1 }}>{srcTestMsg}</span>}
                </div>
              </div>
              <div className="card">
                <div style={{ fontWeight: 'var(--fw-semibold)', marginBottom: 12 }}>Destination Credentials ({selectedDest})</div>
                {renderCredFields(getFields(selectedDest), destCreds, handleDestCredChange)}
                {isSpSource(selectedDest) && (
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', margin: '6px 0' }}>
                    You'll pick (or create) the destination list in the next step.
                  </div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}>
                  <Button className="btn btn-outline btn-sm" onClick={testDestConnection} loading={destTestStatus === 'testing'} loadingLabel="Testing" style={statusStyle(destTestStatus)}>
                    {statusLabel(destTestStatus)}
                  </Button>
                  {destTestMsg && <span style={{ fontSize: 'var(--fs-sm)', color: destTestStatus === 'connected' ? 'var(--success)' : 'var(--error)', flex: 1 }}>{destTestMsg}</span>}
                </div>
              </div>
            </div>

            {/* ── Save / Delete connection bar ── */}
            <div className="card" style={{ marginTop: 16, padding: '12px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                {/* Save button */}
                <Button
                  className="btn btn-primary btn-sm"
                  onClick={handleSaveConnection}
                  loading={saveStatus === 'saving'}
                  loadingLabel="Saving"
                  disabled={srcTestStatus !== 'connected' || destTestStatus !== 'connected'}
                >
                  {saveStatus === 'saved' ? 'Saved' : 'Save Connection'}
                </Button>

                {/* Save as new copy (Clone) — only when an existing connection is loaded */}
                {activeIntegrationId && (
                  <button
                    className="btn btn-outline btn-sm"
                    onClick={handleCloneConnection}
                    disabled={cloneStatus === 'cloning'}
                    style={{ minWidth: 140 }}
                    title="Create an independent copy (new draft, shared credentials). The original is left unchanged."
                  >
                    {cloneStatus === 'cloning' ? 'Cloning...' : 'Save as New Copy'}
                  </button>
                )}

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
                    fontSize: 'var(--fs-sm)', flex: 1,
                    color: saveStatus === 'saved' || deleteStatus === 'deleted' ? 'var(--success)' : 'var(--error)',
                  }}>
                    {saveMsg}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 6 }}>
                Save stores source and destination connection details. Same source URL will update the existing connection.
                {activeIntegrationId && ' "Save as New Copy" forks this into an independent connection (shares the same vault credentials) and leaves the original unchanged.'}
              </div>
            </div>

            {(srcTestStatus !== 'connected' || destTestStatus !== 'connected') && (
              <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-base)', marginTop: 16, textAlign: 'center' }}>
                Both connections must be tested successfully before proceeding
              </div>
            )}
          </div>
        )}

        {/* ── Step 3: Source Entity + Destination Table ── */}
        {wizardStep === 3 && (
          <div className="wizard-step active">
            <div className="wiz-section">
              <div className="wiz-section-main">
                <div className="wiz-section-eyebrow">Step 3</div>
                <div className="wiz-section-title">
                  {isSpSource(selectedSource) ? 'Select source list & destination table' : 'Choose what to sync'}
                </div>
                <div className="wiz-section-sub">
                  Pick the entity to read and the table it lands in.
                </div>
              </div>
              {/* The endpoint/database is omitted when unknown rather than
                  printed as empty parentheses, which is what "PostgreSQL ()" was. */}
              <div className="wiz-section-aside">
                <span className="wiz-route">
                  <span className="wiz-route-end">
                    <span className="wiz-route-name">{selectedSource}</span>
                    {(srcCreds.siteUrl || srcCreds.endpointUrl || srcCreds.database) && (
                      <span className="wiz-route-sub">{srcCreds.siteUrl || srcCreds.endpointUrl || srcCreds.database}</span>
                    )}
                  </span>
                  <span className="wiz-route-arrow">&rarr;</span>
                  <span className="wiz-route-end">
                    <span className="wiz-route-name">{selectedDest}</span>
                    {(destCreds.database || destCreds.listName) && (
                      <span className="wiz-route-sub">{destCreds.database || destCreds.listName}</span>
                    )}
                  </span>
                </span>
              </div>
            </div>

            {/* Jira project selector (unchanged) */}
            {selectedSource === 'Jira' && projects.length > 1 && (
              <div className="form-group" style={{ maxWidth: 400, marginBottom: 16 }}>
                <label htmlFor="wizardpage-select-project">Select Project</label>
                <select id="wizardpage-select-project" value={selectedProject} onChange={e => setSelectedProject(e.target.value)}>
                  <option value="">Choose a project...</option>
                  {projects.map(p => <option key={p.key} value={p.key}>{p.key} &mdash; {p.name}</option>)}
                </select>
              </div>
            )}
            {selectedSource === 'Jira' && projects.length === 1 && (
              <div style={{ marginBottom: 12, fontSize: 'var(--fs-base)', color: 'var(--text-secondary)' }}>
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
                  <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-md)', marginBottom: 10 }}>
                    {isSpSource(selectedSource) ? `SharePoint Lists (${entities.length})` : `${selectedSource} Entities`}
                  </div>

                  {/* Search bar */}
                  <input
                    type="text"
                    placeholder={`Search ${isSpSource(selectedSource) ? 'lists' : 'entities'}...`}
                    value={entitySearch}
                    onChange={e => setEntitySearch(e.target.value)}
                    style={{ width: '100%', padding: '7px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', marginBottom: 10, fontSize: 'var(--fs-base)' }}
                  />

                  {/* Scrollable list */}
                  <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
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
                            <div style={{ fontWeight: selectedEntity === ent.id ? 700 : 500, fontSize: 'var(--fs-base)' }}>{ent.name}</div>
                            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                              {connectorMeta[selectedSource]?.entityDescriptions?.[ent.id] || (isSpSource(selectedSource) ? 'SharePoint List' : '')}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            {ent.fieldCount && <span className="badge badge-neutral" style={{ fontSize: 'var(--fs-xs)' }}>{ent.fieldCount} cols</span>}
                            {selectedEntity === ent.id && <span style={{ color: 'var(--primary)', fontWeight: 'var(--fw-bold)' }}>&#10003;</span>}
                          </div>
                        </div>
                      ))}
                    {entities.filter(ent => !entitySearch || ent.name.toLowerCase().includes(entitySearch.toLowerCase())).length === 0 && (
                      <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-base)' }}>
                        {entitySearch
                          ? <>No entity matches &ldquo;{entitySearch}&rdquo;</>
                          : 'No entities found. Check the source credentials in Step 2 — a database with no name set returns nothing.'}
                      </div>
                    )}
                  </div>
                  {selectedEntity && (
                    <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--success-on)', fontWeight: 'var(--fw-semibold)' }}>
                      &#10003; Selected: {entities.find(e => e.id === selectedEntity)?.name}
                    </div>
                  )}
                </div>

                {/* ── RIGHT: Destination table picker (PostgreSQL / MySQL) ── */}
                {(isDbDest(selectedDest)) && (
                  <div className="card" style={{ padding: 16 }}>
                    <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-md)', marginBottom: 10 }}>
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
                          <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
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
                                  <div style={{ fontWeight: selectedPgTable === t.name ? 700 : 500, fontSize: 'var(--fs-base)', fontFamily: 'var(--font-mono)' }}>{t.name}</div>
                                </div>
                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <span className="badge badge-neutral" style={{ fontSize: 'var(--fs-xs)' }}>{t.columnCount} cols</span>
                                  {selectedPgTable === t.name && <span style={{ color: 'var(--primary)', fontWeight: 'var(--fw-bold)' }}>&#10003;</span>}
                                </div>
                              </div>
                            ))}
                            {pgTables.length === 0 && (
                              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-base)' }}>
                                No tables found in schema "{destCreds.schema || 'public'}"
                              </div>
                            )}
                          </div>
                        )}
                        {selectedPgTable && (
                          <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--success-on)', fontWeight: 'var(--fw-semibold)' }}>
                            &#10003; Target: {destCreds.schema || 'public'}.{selectedPgTable}
                          </div>
                        )}
                      </>
                    ) : (
                      <div>
                        <div style={{ marginBottom: 8, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
                          Enter a name for the new table. It will be auto-created with columns derived from the source.
                        </div>
                        <input
                          type="text"
                          placeholder="e.g. sp_invoice"
                          value={newTableName}
                          onChange={e => setNewTableName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-md)' }}
                        />
                        {newTableName && (
                          <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--info-on)' }}>
                            Will create: <strong>{destCreds.schema || 'public'}.{newTableName}</strong> with columns from the selected source list
                          </div>
                        )}
                      </div>
                    )}

                    <div style={{ marginTop: 14, padding: '8px 12px', background: 'var(--info-dim)', border: '1px solid var(--info)', borderRadius: 'var(--radius)', fontSize: 'var(--fs-xs)', color: 'var(--info-on)' }}>
                      <strong>Smart Sync:</strong> Only changed columns are updated. If 100 rows are pushed and only 2 rows have changes in specific columns, only those 2 columns on those 2 rows are updated.
                    </div>
                  </div>
                )}

                {/* ── RIGHT: Destination list picker (SharePoint) ── */}
                {isSpSource(selectedDest) && (
                  <div className="card" style={{ padding: 16 }}>
                    <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-md)', marginBottom: 10 }}>SharePoint Destination List</div>
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
                        <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                          {spDestLists.map((l) => (
                            <div key={l.id}
                              onClick={() => { updateDestCred('listName', l.name); setDestConnectionData((d) => ({ ...(d || {}), listId: l.id })); }}
                              style={{ padding: '10px 14px', cursor: 'pointer', background: (destCreds.listName === l.name) ? 'var(--primary-dim)' : 'transparent', borderBottom: '1px solid var(--border)', borderLeft: (destCreds.listName === l.name) ? '3px solid var(--primary)' : '3px solid transparent', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <div style={{ fontWeight: destCreds.listName === l.name ? 700 : 500, fontSize: 'var(--fs-base)' }}>{l.name}</div>
                              {destCreds.listName === l.name && <span style={{ color: 'var(--primary)', fontWeight: 'var(--fw-bold)' }}>&#10003;</span>}
                            </div>
                          ))}
                          {spDestLists.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-base)' }}>No lists found on this site</div>}
                        </div>
                      )
                    ) : (
                      <div>
                        <div style={{ marginBottom: 8, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
                          Enter a name for the new list. It will be auto-created with columns from your field mappings.
                        </div>
                        <input type="text" placeholder="e.g. Synced Products" value={spNewListName}
                          onChange={(e) => { setSpNewListName(e.target.value); updateDestCred('listName', e.target.value); }}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 'var(--fs-md)' }} />
                        {spNewListName && <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--info-on)' }}>Will create list <strong>{spNewListName}</strong> with columns from the selected source.</div>}
                      </div>
                    )}
                    {destCreds.listName && (
                      <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--success-on)', fontWeight: 'var(--fw-semibold)' }}>
                        &#10003; Destination: {destCreds.listName}{spDestCreateNew ? ' (new)' : ''}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Additional destination targets (fan-out) ── */}
            {(isDbDest(selectedDest) || isSpSource(selectedDest)) && (
              <div className="card" style={{ padding: 16, marginTop: 16 }}>
                <div {...clickable(() => setTargetsPanelOpen((o) => !o), { label: `${targetsPanelOpen ? 'Collapse' : 'Expand'} additional destination targets` })}
                  aria-expanded={targetsPanelOpen}
                  style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-md)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ color: 'var(--text-dim)' }}>{targetsPanelOpen ? '▾' : '▸'}</span>
                    Additional destination targets (fan-out)
                    {extraTargets.length > 0 && <span className="badge badge-neutral" style={{ fontSize: 'var(--fs-xs)' }}>{extraTargets.length}</span>}
                  </div>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                    Write each record to more than one {isDbDest(selectedDest) ? 'table' : 'list'} — split columns per target in the Mapping step
                  </span>
                </div>
                {targetsPanelOpen && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 10 }}>
                      By default extra targets reuse the <strong>primary {selectedDest} connection &amp; credentials</strong> (same server, another {isDbDest(selectedDest) ? 'table' : 'list'}); choose which columns go to each via the per-column selector in the Mapping step. Use <strong>Different server</strong> to fan out to another server/connector. For a target <strong>shared across entities</strong>, give it the same name &amp; natural key so rows merge.
                    </div>
                    {extraTargets.map((t, i) => {
                      // Field set depends on the target's connector kind: its own (cross-server) or the primary's.
                      const xIsDb = t.connectorId ? connectorKindById(t.connectorId) === 'database' : isDbDest(selectedDest);
                      const fld = { padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 'var(--fs-sm)', minWidth: 0 };
                      return (
                      <div key={t.targetId} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 8, marginBottom: 8 }}>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span className="badge badge-neutral" style={{ fontSize: 'var(--fs-xs)' }}>{i + 2}</span>
                          <input
                            placeholder={xIsDb ? 'table name' : 'list name'}
                            value={t.table}
                            onChange={(e) => updateExtraTarget(i, { table: xIsDb ? e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') : e.target.value })}
                            style={{ ...fld, flex: '1 1 160px', fontFamily: xIsDb ? 'monospace' : 'inherit' }}
                          />
                          <input
                            placeholder="natural key column (optional)"
                            value={t.naturalKeyColumn}
                            onChange={(e) => updateExtraTarget(i, { naturalKeyColumn: e.target.value })}
                            title="Column to dedup/upsert by for this target. Blank = use the primary key. For a SHARED target across entities, use the same key so rows merge."
                            style={{ ...fld, flex: '1 1 160px' }}
                          />
                          <button className="btn btn-sm btn-outline" onClick={() => updateExtraTarget(i, { advancedOpen: !t.advancedOpen })}
                            title="Send this target to a different server / connector with its own credentials">
                            {t.advancedOpen ? 'Same server' : 'Different server'}
                          </button>
                          <button className="btn btn-sm" style={{ color: 'var(--error-on)', border: '1px solid var(--error)', background: 'transparent' }} onClick={() => removeExtraTarget(i)}>Remove</button>
                        </div>
                        {t.advancedOpen && (
                          <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--border)', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <select value={t.connectorId} onChange={(e) => updateExtraTarget(i, { connectorId: e.target.value })} style={{ ...fld, flex: '1 1 160px' }} title="Destination connector for this target">
                              <option value="">Reuse primary connector</option>
                              {destCards.map((c) => <option key={c.connectorId} value={c.connectorId}>{c.label}</option>)}
                            </select>
                            <select value={t.destCredId} onChange={(e) => updateExtraTarget(i, { destCredId: e.target.value })} style={{ ...fld, flex: '1 1 160px' }} title="Credential for this target's server">
                              <option value="">Credential…</option>
                              {credentialsList.map((c) => <option key={c.credId} value={c.credId}>{c.name || c.credId.slice(0, 8)}</option>)}
                            </select>
                            {xIsDb ? (
                              <>
                                <input placeholder="host" value={t.host} onChange={(e) => updateExtraTarget(i, { host: e.target.value })} style={{ ...fld, flex: '1 1 120px' }} />
                                <input placeholder="port" value={t.port} onChange={(e) => updateExtraTarget(i, { port: e.target.value })} style={{ ...fld, width: 70 }} />
                                <input placeholder="database" value={t.database} onChange={(e) => updateExtraTarget(i, { database: e.target.value })} style={{ ...fld, flex: '1 1 120px' }} />
                                <input placeholder="schema" value={t.schema} onChange={(e) => updateExtraTarget(i, { schema: e.target.value })} style={{ ...fld, flex: '1 1 100px' }} />
                              </>
                            ) : (
                              <input placeholder="site URL" value={t.siteUrl} onChange={(e) => updateExtraTarget(i, { siteUrl: e.target.value })} style={{ ...fld, flex: '1 1 240px' }} />
                            )}
                            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', flexBasis: '100%' }}>Leave the connector blank to reuse the primary server. Pick a connector + credential (and connection details) to fan out to a different server.</span>
                          </div>
                        )}
                      </div>
                      );
                    })}
                    <button className="btn btn-outline btn-sm" onClick={addExtraTarget} style={{ marginTop: 4 }}>
                      + Add target {isDbDest(selectedDest) ? 'table' : 'list'}
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* ── Entity group (multi-entity "Run all") ── */}
            {selectedDest && (
              <div className="card" style={{ padding: 16, marginTop: 16 }}>
                <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-md)', marginBottom: 6 }}>Entity group (optional)</div>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 10 }}>
                  Tag this connection with a group id so several entities (separate saved connections) can be run together in one click. Paste an existing id to join a group, or generate a new one. Connections sharing a group can be triggered with <strong>“Run all in group”</strong> on the Push step.
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    placeholder="group id (e.g. grp_ab12) — leave blank for ungrouped"
                    value={groupId}
                    onChange={(e) => setGroupId(e.target.value.trim())}
                    style={{ flex: '1 1 240px', padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-base)' }}
                  />
                  <button className="btn btn-outline btn-sm" onClick={() => setGroupId(`grp_${Date.now().toString(36)}`)}>Generate</button>
                  {groupId && <button className="btn btn-sm" style={{ color: 'var(--error-on)', border: '1px solid var(--error)', background: 'transparent' }} onClick={() => setGroupId('')}>Clear</button>}
                </div>
                {/* Load order — parents must load before the children that reference
                    them, otherwise every child row fails its foreign key. */}
                {groupId && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                    <label htmlFor="wizard-group-order" style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>Load order</label>
                    <input
                      id="wizard-group-order"
                      type="number"
                      min="1"
                      placeholder="—"
                      value={groupOrder}
                      onChange={(e) => setGroupOrder(e.target.value)}
                      style={{ width: 90, padding: '6px 10px', borderRadius: 'var(--radius)', border: '1px solid var(--border)', fontSize: 'var(--fs-base)' }}
                    />
                    <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                      Lower runs first. Give the <strong>parent</strong> table 1 and anything with a foreign key into it 2. Blank runs last.
                    </span>
                  </div>
                )}
                {groupId && <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--success-on)' }}>Grouped as <strong>{groupId}</strong>. Save this connection (and tag others with the same id), then use “Run all in group” on the Push step.</div>}
              </div>
            )}

            {/* Validation messages */}
            {!selectedEntity && entities.length > 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-base)', marginTop: 16, textAlign: 'center' }}>
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
                  {/* "SP columns" was hardcoded — it read "4 SP columns unmapped"
                      with a PostgreSQL destination. It names the real destination now. */}
                  <div className="mapper-stats wiz-tallies">
                    <span className="wiz-tally"><b>{mappings.length}</b> mapped</span>
                    {requiredUnmapped.length > 0
                      ? <span className="wiz-tally wiz-tally--bad"><b>{requiredUnmapped.length}</b> required unmapped</span>
                      : <span className="wiz-tally wiz-tally--ok">All required columns mapped</span>}
                    <span className="wiz-tally">
                      <b>{destFields.length - mappedDestNames.size}</b> {selectedDest} column{destFields.length - mappedDestNames.size === 1 ? '' : 's'} unmapped
                    </span>
                  </div>
                </div>

                {mappings.length > 0 && (
                  <div className="wiz-note" style={{ margin: '8px 0', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: 'var(--warning)', fontSize: 'var(--fs-md)' }}>★</span>
                    {effectiveKey
                      ? <span>Identity key: <code style={{ background: 'var(--bg-card)', padding: '1px 5px', borderRadius: 'var(--radius-sm)' }}>{effectiveKey}</code> — records are deduped &amp; upserted by this column. Click the ★ on any mapping row to change it.</span>
                      : <span>No identity key set — every row is inserted as new. Click the ☆ on a mapping row to dedupe/upsert by that column.</span>}
                  </div>
                )}

                {isDbDest(selectedDest) && (
                  <div className="wiz-note" style={{ margin: '8px 0', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 'var(--fw-semibold)' }}>Match records by:</span>
                    <select value={matchKey === '__append__' ? '__append__' : effectiveKey} onChange={(e) => setMatchKey(e.target.value)} style={{ minWidth: 220 }}>
                      <option value="__append__">Append every row (no matching — each row is new)</option>
                      {mappings.flatMap((m) => m.destinations || []).filter((d, i, a) => d && a.indexOf(d) === i).map((d) => (
                        <option key={d} value={d}>Match by “{d}” (update if exists, else insert)</option>
                      ))}
                    </select>
                    <span style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-xs)' }}>
                      New tables get an auto-increment <code>id</code> primary key automatically.
                    </span>
                  </div>
                )}

                {mappings.length > 0 && (
                  <div className="wiz-note" style={{ margin: '8px 0' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 'var(--fw-semibold)', cursor: 'pointer' }}>
                      <input type="checkbox" checked={encryptionEnabled} onChange={(e) => setEncryptionEnabled(e.target.checked)} />
                      <span>&#128274; Encrypt sensitive columns before writing to the destination (AES-256-GCM)</span>
                    </label>
                    {encryptionEnabled && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-xs)', marginBottom: 6 }}>
                          Choose which destination columns to encrypt. Values are written as ciphertext (<code>synz:v1:gcm:…</code>); the owning application decrypts them with this connection&rsquo;s key. The identity-key column can&rsquo;t be encrypted (it must stay usable for matching).
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {mappings.flatMap((m) => m.destinations || []).filter((d, i, a) => d && a.indexOf(d) === i && d !== effectiveKey).map((col) => (
                            <label key={col} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', cursor: 'pointer', background: encryptFields.includes(col) ? 'var(--primary-dim)' : 'transparent' }}>
                              <input
                                type="checkbox"
                                checked={encryptFields.includes(col)}
                                onChange={(e) => setEncryptFields((prev) => e.target.checked ? [...prev, col] : prev.filter((c) => c !== col))}
                              />
                              <span>{col}</span>
                            </label>
                          ))}
                        </div>
                        {activeIntegrationId ? (
                          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <button
                              className="btn btn-outline btn-sm"
                              onClick={async () => {
                                setRevealMsg('Revealing…'); setRevealedKey(null);
                                const res = await api.call(`/api/integrations/${activeIntegrationId}/encryption-key/reveal`, null, 'GET');
                                if (res.ok && res.data?.success) { setRevealedKey(res.data.data.keyHex); setRevealMsg(''); }
                                else { setRevealMsg(res.data?.error || 'Save the connection (with encryption on) first, then reveal.'); }
                              }}
                            >Reveal decryption key</button>
                            {revealMsg && <span style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-xs)' }}>{revealMsg}</span>}
                            {revealedKey && (
                              <code style={{ background: 'var(--bg-card)', padding: '4px 8px', borderRadius: 'var(--radius-sm)', wordBreak: 'break-all', fontSize: 'var(--fs-xs)' }}>{revealedKey}</code>
                            )}
                          </div>
                        ) : (
                          <div style={{ marginTop: 8, color: 'var(--text-dim)', fontSize: 'var(--fs-xs)' }}>Save the connection to generate the key — a &ldquo;Reveal decryption key&rdquo; button will appear here.</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                <JoinsPanel joins={joins} setJoins={setJoins} srcFields={srcFields} sides={joinSides}
                  entitiesFor={entitiesForSide} loadColumns={loadColumnsForSide} />

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
                      {filteredSrc.length === 0 && <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 'var(--fs-sm)' }}>No fields match</div>}
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
                        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-base)' }}>
                          <div style={{ fontSize: 'var(--fs-2xl)', marginBottom: 8 }}>&#8621;</div>
                          Click <strong>Auto-Map</strong> to match fields automatically,<br />or add mappings manually below.
                        </div>
                      )}
                      {mappings.map((m, i) => (
                        <MappingRow
                          key={m.id}
                          mapping={m}
                          index={i}
                          srcFields={srcFieldsAll}
                          destFields={destFields}
                          allowNewDest={isSpSource(selectedDest) || (isDbDest(selectedDest) && createNewTable)}
                          isKey={!!effectiveKey && (m.destinations || []).includes(effectiveKey)}
                          onSetKey={() => setMappingKey(i)}
                          onUpdate={(updated) => updateMapping(i, updated)}
                          onRemove={() => removeMapping(i)}
                          expanded={expandedMapping === i}
                          onToggle={() => setExpandedMapping(expandedMapping === i ? -1 : i)}
                          targets={routeTargets}
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
                        <span style={{ color: 'var(--success-on)' }}>{selectedDest}</span> Columns
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
                      {filteredDest.length === 0 && <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 'var(--fs-sm)' }}>No columns match</div>}
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
            <div className="wiz-section">
              <div className="wiz-section-main">
                <div className="wiz-section-eyebrow">Step 5</div>
                <div className="wiz-section-title">Fetch &amp; review</div>
                <div className="wiz-section-sub">
                  Reads real records and shows them mapped. Nothing is written until Step 6.
                </div>
              </div>
            </div>

            <div className="grid-2" style={{ gap: 24 }}>
              {/* Left: Config */}
              <div className="card" style={{ padding: 20 }}>
                <div className="wiz-card-title">Fetch Configuration</div>
                {/* "Project" is a Jira-only scope. Other sources are scoped by the entity
                    field below, so showing an empty (or fake) Project box only confused. */}
                {/* Facts, not fields: these were readOnly <input>s, which look editable
                    and invite a click that does nothing. */}
                <div className="wiz-facts">
                  <div className="wiz-fact">
                    <span className="wiz-fact-label">{selectedSource === 'Jira' ? 'Project' : 'Source'}</span>
                    <span className="wiz-fact-value">
                      {(selectedSource === 'Jira' ? selectedProject : selectedSource) || '—'}
                    </span>
                  </div>
                  <div className="wiz-fact">
                    <span className="wiz-fact-label">{isSpSource(selectedSource) ? 'List' : 'Entity'}</span>
                    <span className="wiz-fact-value">
                      {(isSpSource(selectedSource)
                        ? (entities.find(e => e.id === selectedEntity)?.name || selectedEntity)
                        : selectedEntity) || '—'}
                    </span>
                  </div>
                </div>
                {/* Date window is a JIRA-only filter (it becomes `updated >= / <=` in the JQL).
                    No other source honors it — scrape/REST/DB/file-share fetches ignore
                    dateFrom/dateTo entirely — so showing it there promised a filter that
                    silently did nothing. */}
                {selectedSource === 'Jira' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div className="form-group">
                      <label htmlFor="wizardpage-date-start">Date Start</label>
                      <input id="wizardpage-date-start" type="date" value={dateStart} onChange={e => setDateStart(e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label htmlFor="wizardpage-date-end">Date End</label>
                      <input id="wizardpage-date-end" type="date" value={dateEnd} onChange={e => setDateEnd(e.target.value)} />
                    </div>
                  </div>
                )}
                {isSpSource(selectedSource) && (
                  <div className="wiz-note wiz-note--info" style={{ marginBottom: 8 }}>
                    All items from the SharePoint list will be fetched (delta query).
                  </div>
                )}
                <div className="form-group" style={{ marginTop: 4 }}>
                  <label style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>
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
                  <div className="wiz-note wiz-note--error" style={{ marginTop: 10 }}>
                    {fetchError}
                  </div>
                )}
              </div>

              {/* Right: Results */}
              <div className="card" style={{ padding: 20 }}>
                <div className="wiz-card-title">Fetch Results</div>
                {fetchStatus === 'idle' && (
                  <div className="wiz-empty">
                    <div className="wiz-empty-icon">&#128269;</div>
                    <div className="wiz-empty-title">{selectedSource === 'Jira'
                      ? 'Configure the date range and click Fetch to pull Jira issues.'
                      : `Click Fetch to read ${sourceScopeLabel || 'the selected entity'} from ${selectedSource}.`}</div>
                  </div>
                )}
                {fetchStatus === 'fetching' && (
                  <div className="wiz-empty">
                    <div className="wiz-empty-icon is-spinning">&#9696;</div>
                    <div className="wiz-empty-title" style={{ marginTop: 8 }}>{selectedSource === 'Jira'
                      ? `Pulling issues from ${selectedProject}...`
                      : `Reading ${sourceScopeLabel || 'records'} from ${selectedSource}...`}</div>
                  </div>
                )}
                {fetchStatus === 'done' && fetchResult && (
                  <div>
                    <div className="wiz-note wiz-note--success" style={{ marginBottom: 12 }}>
                      <div style={{ fontWeight: 'var(--fw-bold)', color: 'var(--success-on)', fontSize: 'var(--fs-base)' }}>
                        &#9989; {fetchResult.serverPreview
                          ? `Previewed ${fetchResult.totalCount}${fetchResult.totalCount >= fetchResult.previewLimit ? '+' : ''} ${isSpSource(selectedSource) ? 'items' : selectedSource === 'Jira' ? 'issues' : 'records'}`
                          : `Fetched ${fetchResult.totalCount} ${isSpSource(selectedSource) ? 'items' : selectedSource === 'Jira' ? 'issues' : 'records'}`}
                      </div>
                      {/* Say WHICH path produced this. Server preview = the same read + mapping
                          the push performs, so what you review is what gets written. */}
                      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-secondary)', marginTop: 3 }}>
                        {fetchResult.serverPreview
                          ? `Read server-side through the same source + mapping the push uses${fetchResult.totalCount >= fetchResult.previewLimit ? ` — showing the first ${fetchResult.previewLimit}; the push reads them all.` : '.'}`
                          : 'Read in the browser (server preview unavailable) — the push re-reads server-side.'}
                      </div>
                      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
                        Run ID: <span style={{ fontFamily: 'var(--font-mono)' }}>{fetchResult.runId}</span>
                      </div>
                    </div>
                    <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 'var(--fw-semibold)' }}>
                      Preview (first {Math.min(5, fetchResult.tickets.length)} of {fetchResult.totalCount})
                    </div>
                    <div className="wiz-table-wrap" style={{ maxHeight: 220 }}>
                      <table className="wiz-data-table">
                        <thead>
                          <tr>
                            {isSpSource(selectedSource) ? (
                              <>
                                <th scope="col">Item ID</th>
                                {srcFields.slice(0, 3).map(f => (
                                  <th scope="col" key={f.name}>{f.displayName || f.name}</th>
                                ))}
                              </>
                            ) : selectedSource === 'Jira' ? (
                              <>
                                <th scope="col">Key</th>
                                <th scope="col">Summary</th>
                                <th scope="col">Status</th>
                              </>
                            ) : (
                              // Generic source (REST/DB/…): columns from the actual record keys.
                              <>
                                {Object.keys(fetchResult.tickets[0] || {}).slice(0, 5).map((c) => (
                                  <th scope="col" key={c}>{c}</th>
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
                                  <td className="is-mono">
                                    {t.spItemId || t.id || '--'}
                                  </td>
                                  {srcFields.slice(0, 3).map(f => (
                                    <td key={f.name}>
                                      {String(t.fields?.[f.name] ?? '').substring(0, 50)}
                                    </td>
                                  ))}
                                </>
                              ) : selectedSource === 'Jira' ? (
                                <>
                                  <td className="is-mono">
                                    {t.key || t.issueKey || '--'}
                                  </td>
                                  <td>
                                    {(t.fields?.summary || t.summary || '').substring(0, 60)}
                                  </td>
                                  <td style={{ whiteSpace: 'nowrap' }}>
                                    {t.fields?.status?.name || t.status || '--'}
                                  </td>
                                </>
                              ) : (
                                // Generic source: show the same record keys as the header.
                                <>
                                  {Object.keys(fetchResult.tickets[0] || {}).slice(0, 5).map((c) => (
                                    <td key={c}>
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
                    <div style={{ marginTop: 12, fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)' }}>
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
            <div className="wiz-section">
              <div className="wiz-section-main">
                <div className="wiz-section-eyebrow">Step 6</div>
                <div className="wiz-section-title">Push &amp; sync</div>
                <div className="wiz-section-sub">
                  Writes the mapped records to <strong>{selectedDest}</strong> and schedules the sync.
                </div>
              </div>
            </div>

            {/* ── Run all entities in this group (multi-entity orchestration) ── */}
            {groupId && (
              <div className="card" style={{ padding: 16, marginBottom: 16, borderLeft: '3px solid var(--primary)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-md)' }}>Entity group: <code style={{ background: 'var(--bg-main)', padding: '1px 6px', borderRadius: 'var(--radius-sm)' }}>{groupId}</code></div>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Runs every <strong>active saved</strong> connection tagged with this group, one after another. Save this connection first so it's included.</div>
                  </div>
                  <button className="btn btn-primary btn-sm" disabled={groupRunStatus === 'running'} onClick={handleRunGroup}>
                    {groupRunStatus === 'running' ? 'Running all…' : '▶ Run all in group'}
                  </button>
                </div>
                {groupRunResult && (
                  <div style={{ marginTop: 10, fontSize: 'var(--fs-sm)' }}>
                    {groupRunResult.error ? (
                      <span style={{ color: 'var(--error-on)' }}>{groupRunResult.error}</span>
                    ) : (
                      <div>
                        <div style={{ color: 'var(--success-on)', fontWeight: 'var(--fw-semibold)', marginBottom: 4 }}>
                          Ran {groupRunResult.count - (groupRunResult.skipped || 0)} of {groupRunResult.count} entit{groupRunResult.count === 1 ? 'y' : 'ies'}
                          {groupRunResult.skipped ? ` · ${groupRunResult.skipped} skipped after a failure` : ''}:
                        </div>
                        {(groupRunResult.results || []).map((r, i) => (
                          <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0', borderBottom: '1px solid var(--border)' }}>
                            <span style={r.skipped ? { color: 'var(--text-dim)' } : undefined}>{r.name || r.integrationId}</span>
                            {/* A skipped member is neither a success nor its own failure —
                                it never ran because something earlier in the load order did. */}
                            {r.skipped
                              ? <span style={{ color: 'var(--warning-on)' }}>{r.reason || 'Skipped'}</span>
                              : r.error
                                ? <span style={{ color: 'var(--error-on)' }}>{r.error}</span>
                                : <span style={{ color: 'var(--text-dim)' }}>{r.published ?? 0} published &times; {r.targets ?? 1} target(s)</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {/* Config + Status row */}
              <div style={{ display: 'grid', gridTemplateColumns: pushStatus !== 'idle' || !fetchResult?.tickets?.length ? '1fr 1fr' : '1fr', gap: 16 }}>
              <div className="card" style={{ padding: 20 }}>
                <div className="wiz-card-title">Push Configuration</div>
                {/* Facts, not a run-on list of "label: value" divs — the same
                    read-only treatment step 5 uses, so the two review panels match. */}
                <div className="wiz-facts">
                  <div className="wiz-fact">
                    <span className="wiz-fact-label">Source</span>
                    <span className="wiz-fact-value is-prose">
                      <strong>{selectedSource}</strong>{sourceScopeLabel ? <span style={{ color: 'var(--text-dim)' }}> &middot; {sourceScopeLabel}</span> : null}{' '}
                      <span style={{ color: 'var(--text-dim)' }}>({fetchResult?.serverPreview && fetchResult.totalCount >= fetchResult.previewLimit ? `${fetchResult.totalCount}+ previewed` : `${fetchResult?.totalCount || 0} records`})</span>
                    </span>
                  </div>
                  <div className="wiz-fact">
                    <span className="wiz-fact-label">Destination</span>
                    <span className="wiz-fact-value is-prose">
                      <strong>{destCreds.table || destCreds.listName || selectedDest}</strong> <span style={{ color: 'var(--text-dim)' }}>({selectedDest})</span>
                    </span>
                  </div>
                  {destCreds.siteUrl && (
                    <div className="wiz-fact">
                      <span className="wiz-fact-label">Site</span>
                      <span className="wiz-fact-value is-prose">{destCreds.siteUrl}</span>
                    </div>
                  )}
                  <div className="wiz-fact">
                    <span className="wiz-fact-label">Mappings</span>
                    <span className="wiz-fact-value is-prose">{mappings.length} fields</span>
                  </div>
                  <div className="wiz-fact">
                    <span className="wiz-fact-label">Mode</span>
                    <span className="wiz-fact-value is-prose">{matchKey === '__append__'
                      ? <><strong>Append</strong> (every row inserted as new)</>
                      : <><strong>Upsert</strong> (update by {matchKey || mappings[0]?.destinations?.[0] || 'key'}, create if new)</>}</span>
                  </div>
                  {selectedSource === 'Jira' && dateStart && dateEnd && (
                    <div className="wiz-fact">
                      <span className="wiz-fact-label">Date Range</span>
                      <span className="wiz-fact-value">{dateStart} &rarr; {dateEnd}</span>
                    </div>
                  )}
                </div>
                <div className="wiz-note wiz-note--info" style={{ marginTop: 14 }}>
                  {matchKey === '__append__'
                    ? <><strong>Append:</strong> Every record is inserted as a new row (no matching). The auto-increment <code>id</code> keeps rows unique.</>
                    : <><strong>Dedup:</strong> Each record is matched by the <code>{matchKey || mappings[0]?.destinations?.[0] || 'key'}</code> column. If a row with the same key already exists in {selectedDest}, it is <strong>updated</strong>; otherwise a new row is created. No duplicates.</>}
                </div>
              </div>

              {/* Middle: Transformation Preview */}
              {fetchResult?.tickets?.length > 0 && pushStatus === 'idle' && (
                <div className="card" style={{ padding: 20, gridColumn: '1 / -1', marginBottom: 0 }}>
                  <div className="wiz-card-title">
                    Transformation Preview &mdash; what goes to {selectedDest}
                  </div>
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 10 }}>
                    Showing transformed output for the first {Math.min(3, fetchResult.tickets.length)} of {fetchResult.totalCount} records using your {mappings.length} mapping rules.
                  </div>
                  <div className="wiz-table-wrap" style={{ maxHeight: 320 }}>
                    <table className="wiz-data-table is-xs is-sticky">
                      <thead>
                        <tr>
                          <th scope="col">#</th>
                          {mappings.map((m, i) => (
                            <th scope="col" key={i}>
                              <span title={`${m.sources.join('+')} \u2192 ${m.destinations.join('+')}`}>
                                {m.destinations[0] || '?'}
                              </span>
                              <div style={{ fontSize: 'var(--fs-xs)', color: m.transform === 'DIRECT' ? 'var(--success)' : m.transform === 'EXPRESSION' ? 'var(--warning)' : 'var(--info)', fontWeight: 'var(--fw-normal)' }}>
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
                            <tr key={rowIdx}>
                              <td className="is-mono" style={{ color: 'var(--text-dim)' }}>
                                {ticket.key || ticket.issueKey || rowIdx + 1}
                              </td>
                              {mappings.map((m, colIdx) => {
                                const val = applyTransform(m, ticket);
                                const truncated = String(val).length > 40 ? String(val).substring(0, 40) + '...' : val;
                                return (
                                  <td key={colIdx} className="is-clip" style={{ maxWidth: 180 }} title={String(val)}>
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
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 6 }}>
                    Note: The actual push uses the server-side 35-field mapper for all columns. This preview shows your custom mapping transforms.
                  </div>
                </div>
              )}

              {/* DDL Preview — Database destination schema diff */}
              {ddlPreview && ddlPreview.requiresApproval && ddlStatus !== 'applied' && (
                <div className="card" style={{ padding: 20, gridColumn: '1 / -1', border: '2px solid var(--warning)', background: 'var(--bg-main)' }}>
                  <div className="wiz-card-title is-warning">
                    &#9888; Schema Changes Required — DDL Preview
                  </div>
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 12 }}>
                    The target table is missing {ddlPreview.missingColumns.length} column(s) needed by your field mapping.
                    Review the ALTER statements below and approve to proceed.
                  </div>
                  <div style={{ background: '#1a1d2e', color: '#e2e4f0', padding: 14, borderRadius: 'var(--radius)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap', marginBottom: 12, maxHeight: 240, overflow: 'auto' }}>
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
                    <div className="wiz-note wiz-note--error" style={{ marginTop: 8 }}>
                      {ddlError}
                    </div>
                  )}
                </div>
              )}
              {ddlStatus === 'applied' && (
                <div className="card" style={{ padding: 16, gridColumn: '1 / -1', border: '2px solid var(--success)', background: 'var(--bg-main)' }}>
                  <span style={{ color: 'var(--success-on)', fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-md)' }}>
                    &#10003; DDL applied successfully — {ddlPreview?.ddlStatements?.length || 0} statement(s) executed.
                  </span>
                </div>
              )}

              {/* Right: Push status */}
              <div className="card" style={{ padding: 20, gridColumn: pushStatus === 'idle' && fetchResult?.tickets?.length > 0 ? '1 / -1' : undefined }}>
                <div className="wiz-card-title">Push Status</div>

                {pushStatus === 'idle' && (
                  <div className="wiz-empty">
                    <div className="wiz-empty-icon">&#128640;</div>
                    <div className="wiz-empty-title">Ready to push {fetchResult?.totalCount || 0} records.</div>
                    <div className="wiz-empty-sub">Click <strong>Push to {selectedDest}</strong> below to start.</div>
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
                  <div className="wiz-empty" style={{ padding: '30px 20px' }}>
                    <div className="wiz-empty-icon is-spinning">&#9696;</div>
                    <div style={{ fontSize: 'var(--fs-md)', fontWeight: 'var(--fw-semibold)', marginTop: 8, color: 'var(--primary)' }}>
                      {pushStatus === 'pushing' ? 'Starting push…' : `Pushing to ${selectedDest}…`}
                    </div>
                    {pushResult && (
                      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginTop: 8 }}>
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
                          <div style={{ height: 9, background: 'var(--bg-main)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', background: 'var(--primary)', borderRadius: 'var(--radius)', transition: 'width .3s ease' }} />
                          </div>
                          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 5 }}>{processed} / {pushResult.total} records &middot; {pct}%</div>
                        </div>
                      );
                    })()}
                    <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginTop: 8 }}>
                      Push Run: <span style={{ fontFamily: 'var(--font-mono)' }}>{pushResult?.pushRunId || '...'}</span>
                    </div>
                    {pushResult?.pushRunId && (
                      <div style={{ marginTop: 16 }}>
                        <button className="btn btn-outline" onClick={handleStopPush} disabled={stopping}
                          style={{ borderColor: 'var(--error)', color: 'var(--error-on)' }}>
                          {stopping ? 'Stopping…' : '⏹ Stop push'}
                        </button>
                        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 6 }}>
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
                        <div style={{ padding: '12px 16px', background: bg, border: `1px solid ${accent}`, borderRadius: 'var(--radius)', marginBottom: 16 }}>
                          <div style={{ fontWeight: 'var(--fw-bold)', color: accent, fontSize: 'var(--fs-md)' }}>{label}</div>
                        </div>
                      );
                    })()}
                    <div className="wiz-stats" style={{ gridTemplateColumns: pushResult.skipped != null ? '1fr 1fr 1fr 1fr' : '1fr 1fr 1fr' }}>
                      <div className="wiz-stat">
                        <div className="wiz-stat-label">Inserted</div>
                        <div className="wiz-stat-value is-good">{pushResult.created || pushResult.inserted || 0}</div>
                      </div>
                      <div className="wiz-stat">
                        <div className="wiz-stat-label">Updated</div>
                        <div className="wiz-stat-value is-primary">{pushResult.updated || 0}</div>
                      </div>
                      {pushResult.skipped != null && (
                        <div className="wiz-stat">
                          <div className="wiz-stat-label">Unchanged</div>
                          <div className="wiz-stat-value is-muted">{pushResult.skipped}</div>
                        </div>
                      )}
                      <div className="wiz-stat">
                        <div className="wiz-stat-label">Failed</div>
                        <div className={`wiz-stat-value ${pushResult.failed > 0 ? 'is-bad' : 'is-muted'}`}>{pushResult.failed || 0}</div>
                      </div>
                    </div>

                    {/* Surface why rows failed (first few errors) so failures aren't opaque */}
                    {pushResult.failed > 0 && (pushResult.errors || []).length > 0 && (
                      <div className="wiz-panel is-error" style={{ marginTop: 12 }}>
                        <div className="wiz-panel-head is-error">
                          Why rows failed (first {(pushResult.errors || []).length})
                        </div>
                        <div className="wiz-panel-body" style={{ maxHeight: 160 }}>
                          {(pushResult.errors || []).map((e, i) => (
                            <div key={i} style={{ padding: '5px 14px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{e}</div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Column-level diff stats (PG smart upsert) */}
                    {pushResult.columnChanges && pushResult.columnChanges.length > 0 && (
                      <div className="wiz-panel">
                        <div className="wiz-panel-head">
                          Column-Level Changes ({pushResult.totalColumnsChanged || 0} cell updates across {pushResult.updated || 0} rows)
                        </div>
                        <div className="wiz-panel-body">
                          {pushResult.columnChanges.map(c => (
                            <div key={c.column} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 14px', borderBottom: '1px solid var(--border)', fontSize: 'var(--fs-sm)' }}>
                              <span style={{ fontFamily: 'var(--font-mono)' }}>{c.column}</span>
                              <span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--primary)' }}>{c.count} row{c.count !== 1 ? 's' : ''} changed</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {pushResult.skipped > 0 && (!pushResult.columnChanges || pushResult.columnChanges.length === 0) && pushResult.updated === 0 && (
                      <div className="wiz-note wiz-note--info" style={{ marginTop: 12 }}>
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
                      <div className="wiz-note wiz-note--error" style={{ marginTop: 10 }}>
                        {quickViewError}
                      </div>
                    )}
                    {quickView && (
                      <div className="wiz-panel">
                        <div className="wiz-panel-head">
                          <span>
                            <span style={{ fontFamily: 'var(--font-mono)' }}>{quickView.table}</span>
                            {' '}&mdash; {quickView.rowCount} of {quickView.totalCount} rows
                          </span>
                          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', fontWeight: 'var(--fw-normal)' }}>SELECT * LIMIT 50</span>
                        </div>
                        <div style={{ maxHeight: 400, overflow: 'auto' }}>
                          <table className="wiz-data-table is-xs is-sticky is-hoverable">
                            <thead>
                              <tr>
                                {quickView.columns.map(col => (
                                  <th scope="col" key={col} className="is-mono">
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {quickView.rows.map((row, ri) => (
                                <tr key={ri}>
                                  {quickView.columns.map(col => {
                                    const val = row[col];
                                    const display = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val);
                                    const truncated = display.length > 60 ? display.substring(0, 60) + '...' : display;
                                    return (
                                      <td key={col} title={display} className="is-clip" style={{ maxWidth: 220 }}>
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
                  <div className="wiz-note wiz-note--error" style={{ marginTop: 10 }}>
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

      {/* Pinned action bar. A six-step form scrolls; the way forward must not.
          The blocking reason is stated next to the disabled button instead of
          leaving the user to guess why Next does nothing. */}
      <div className="wiz-actions">
        <div className="wiz-actions-left">
          <button className="btn btn-outline" onClick={goBack} disabled={wizardStep === 1}>&larr; Back</button>
        </div>
        <div className="wiz-meter">
          <div className="wiz-meter-text">
            <span>Step <strong>{wizardStep}</strong> of 6 &middot; {stepLabels[wizardStep - 1]}</span>
            <span>{Math.round(((wizardStep - 1) / 5) * 100)}%</span>
          </div>
          <div className="wiz-meter-track" role="progressbar" aria-valuenow={wizardStep} aria-valuemin={1}
            aria-valuemax={6} aria-label={`Step ${wizardStep} of 6`}>
            <div className="wiz-meter-fill" style={{ width: `${((wizardStep - 1) / 5) * 100}%` }} />
          </div>
        </div>
        <div className="wiz-actions-right">
          {nextBlocked && <span className="wiz-hint">{nextBlocked}</span>}
          <button className="btn btn-primary btn-lg" onClick={goNext} disabled={!!nextBlocked}>
            {wizardStep === 5 && fetchStatus !== 'done' ? 'Fetch first' :
             wizardStep === 6 ? (pushStatus === 'idle' ? `\u25B6 Push to ${selectedDest || 'destination'}` : pushStatus === 'done' ? 'Done' : 'Pushing\u2026') :
             'Next \u2192'}
          </button>
        </div>
      </div>
    </div>
  );
}
