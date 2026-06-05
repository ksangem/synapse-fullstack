import { useState, useEffect, useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { useToast } from '../../hooks/useToast';
import {
  PRESET_TRANSFORMS, PAIR_COLORS, typesCompatible, runPresetTransform,
  evaluateExpression, generateExpression, sampleFor,
} from '../mapping/mappingUtils';

/* Mapping Canvas — real field-mapping editor over a saved integration.
   Reached standalone (pick an integration) or via hand-off from the Connection
   Wizard (srcFields/destFields/mappings passed in navigation state). AI Auto-Map
   calls the backend (Claude, with deterministic fallback); mappings persist to
   integrations.fieldMappings.mappings. Shares all logic with the wizard via
   ../mapping/mappingUtils. */

function deriveFields(mappings, side) {
  const seen = new Map();
  for (const m of mappings) {
    const names = side === 'src' ? m.sources : m.destinations;
    const types = side === 'src' ? m.srcTypes : m.destTypes;
    (names || []).forEach((n, i) => { if (!seen.has(n)) seen.set(n, { name: n, type: (types || [])[i] || 'string' }); });
  }
  return [...seen.values()];
}

export default function CanvasPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const handoff = location.state || null;

  const [integrations, setIntegrations] = useState([]);
  const [integrationId, setIntegrationId] = useState(handoff?.integrationId || '');
  const [srcFields, setSrcFields] = useState(handoff?.srcFields || []);
  const [destFields, setDestFields] = useState(handoff?.destFields || []);
  const [mappings, setMappings] = useState(handoff?.mappings || []);
  const [expanded, setExpanded] = useState(-1);
  const [aiSource, setAiSource] = useState(null); // 'ai' | 'deterministic'
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState('idle');

  // Load saved integrations for the picker.
  useEffect(() => {
    (async () => {
      const res = await api.getConnected();
      if (res.ok && res.data?.data) setIntegrations(res.data.data);
    })();
  }, []);

  // Load mappings for the chosen integration.
  const loadIntegration = useCallback(async (id) => {
    setIntegrationId(id);
    setAiSource(null);
    if (!id) { setMappings([]); setSrcFields([]); setDestFields([]); return; }
    const res = await api.call(`/api/integrations/${id}/mappings`, undefined, 'GET');
    const saved = (res.ok && res.data?.data?.mappings) || [];
    setMappings(saved);
    setSrcFields(deriveFields(saved, 'src'));
    setDestFields(deriveFields(saved, 'dest'));
  }, []);

  const runAutoMap = async () => {
    if (!srcFields.length || !destFields.length) { showToast('No source/destination fields — open this from the Wizard or pick an integration with saved mappings'); return; }
    setBusy(true);
    const res = await api.call(`/api/integrations/${integrationId || 'preview'}/mappings/auto-map`, { srcFields, destFields });
    setBusy(false);
    if (res.ok && res.data?.data) {
      const sug = res.data.data.mappings.map((m, i) => ({ id: `ai-${i}`, preset: null, ...m }));
      setMappings(sug);
      setAiSource(res.data.data.source);
      showToast(res.data.data.source === 'ai' ? 'AI mapped the fields' : 'Auto-mapped (deterministic)');
    } else showToast(res.data?.error || 'Auto-map failed');
  };

  const save = async () => {
    if (!integrationId) { showToast('Select an integration to save into'); return; }
    setSaveState('saving');
    const res = await api.call(`/api/integrations/${integrationId}/mappings`, { mappings }, 'PUT');
    setSaveState(res.ok && res.data?.success ? 'saved' : 'error');
    showToast(res.ok && res.data?.success ? 'Mappings saved' : (res.data?.error || 'Save failed'));
  };

  const updateMapping = (i, patch) => setMappings((prev) => prev.map((m, idx) => idx === i ? { ...m, ...patch } : m));
  const removeMapping = (i) => { setMappings((prev) => prev.filter((_, idx) => idx !== i)); setExpanded(-1); };
  const clearAll = () => { setMappings([]); setAiSource(null); };

  const confColor = (c) => c >= 0.85 ? 'var(--success)' : c >= 0.6 ? 'var(--warning)' : 'var(--error)';

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Mapping Canvas</div>
          <div className="page-subtitle">
            {handoff ? 'Editing mappings handed off from the Connection Wizard' : 'Map source fields to destination columns'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {handoff && <button className="btn btn-outline btn-sm" onClick={() => navigate('/wizard')} title="Return to the Connection Wizard where you left off">&#8592; Back to Wizard</button>}
          <button className="btn btn-outline btn-sm" disabled={busy} onClick={runAutoMap}>{busy ? 'Mapping…' : '✨ AI Auto-Map'}</button>
          <button className="btn btn-ghost btn-sm" onClick={clearAll}>Clear</button>
          <button className={`btn btn-sm ${saveState === 'saved' ? 'btn-success' : 'btn-primary'}`} onClick={save}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : 'Save Mappings'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <label style={{ fontWeight: 600, fontSize: '.85rem' }}>Integration</label>
        <select value={integrationId} onChange={(e) => loadIntegration(e.target.value)} style={{ minWidth: 280 }}>
          <option value="">— select a saved connection —</option>
          {integrations.map((i) => (
            <option key={i.integrationId} value={i.integrationId}>{i.name}</option>
          ))}
        </select>
        {aiSource && <span className={`badge ${aiSource === 'ai' ? 'badge-success' : 'badge-info'}`}>{aiSource === 'ai' ? 'AI suggestions' : 'deterministic'}</span>}
        <span style={{ marginLeft: 'auto', fontSize: '.78rem', color: 'var(--text-dim)' }}>
          {srcFields.length} source · {destFields.length} dest · {mappings.length} mappings
        </span>
      </div>

      {mappings.length === 0 && (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
          No mappings yet. Click <strong>AI Auto-Map</strong> to generate suggestions
          {(!srcFields.length || !destFields.length) && ', or open this Canvas from the Connection Wizard so it can load the live source/destination fields'}.
        </div>
      )}

      {mappings.map((m, i) => (
        <MappingRow
          key={m.id || i}
          mapping={m}
          index={i}
          srcFields={srcFields}
          destFields={destFields}
          expanded={expanded === i}
          onToggle={() => setExpanded(expanded === i ? -1 : i)}
          onUpdate={(patch) => updateMapping(i, patch)}
          onRemove={() => removeMapping(i)}
          confColor={confColor}
          integrationId={integrationId}
          showToast={showToast}
        />
      ))}
    </div>
  );
}

function MappingRow({ mapping, index, srcFields, destFields, expanded, onToggle, onUpdate, onRemove, confColor, integrationId, showToast }) {
  const color = PAIR_COLORS[index % PAIR_COLORS.length];
  const srcDisplay = (mapping.sources || []).join(' + ');
  const destDisplay = (mapping.destinations || []).join(' + ');
  const [nl, setNl] = useState('');
  const [nlBusy, setNlBusy] = useState(false);

  const compatible = (mapping.sources || []).every((s) => {
    const sf = srcFields.find((f) => f.name === s);
    const df = destFields.find((f) => f.name === mapping.destinations?.[0]);
    return typesCompatible(sf?.type, df?.type);
  });
  const hasMismatch = !compatible && mapping.transform === 'DIRECT';

  const sample = useMemo(() => sampleFor(mapping.sources || [], srcFields), [mapping.sources, srcFields]);
  let preview = ''; let previewErr = '';
  if (mapping.transform === 'DIRECT') preview = JSON.stringify(sample[mapping.sources?.[0]]);
  else if (mapping.transform === 'PRESET') preview = JSON.stringify(runPresetTransform(mapping.preset, sample[mapping.sources?.[0]]));
  else if (mapping.transform === 'EXPRESSION' && mapping.expression) {
    const { result, error } = evaluateExpression(mapping.expression, sample);
    if (error) previewErr = error; else preview = JSON.stringify(result);
  }

  const genNl = async () => {
    if (!nl.trim()) return;
    setNlBusy(true);
    const res = await api.call(`/api/integrations/${integrationId || 'preview'}/mappings/transform/nl`, { description: nl, sourceFields: srcFields });
    setNlBusy(false);
    if (res.ok && res.data?.data?.expression) {
      onUpdate({ transform: 'EXPRESSION', expression: res.data.data.expression });
      showToast(res.data.data.source === 'ai' ? 'AI generated the transform' : 'Generated a starter transform');
    } else showToast(res.data?.error || 'Generation failed');
  };

  const confidence = typeof mapping.confidence === 'number' ? mapping.confidence : null;

  return (
    <div className="card" style={{ marginBottom: 8, borderLeft: `3px solid ${color}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={onToggle}>
        <span style={{ width: 22, height: 22, borderRadius: 6, background: color, color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: '.72rem', fontWeight: 700 }}>{index + 1}</span>
        <span style={{ fontFamily: 'monospace', fontSize: '.82rem' }} title={srcDisplay}>{srcDisplay}</span>
        <span style={{ color: 'var(--text-dim)' }}>→</span>
        <span style={{ fontFamily: 'monospace', fontSize: '.82rem' }} title={destDisplay}>{destDisplay}</span>
        <span className={`badge ${hasMismatch ? 'badge-warning' : mapping.transform === 'DIRECT' ? 'badge-neutral' : 'badge-info'}`} style={{ fontSize: '.62rem' }}>
          {hasMismatch ? '⚠ Type' : mapping.transform === 'DIRECT' ? 'Direct' : mapping.transform === 'PRESET' ? 'Preset' : 'JS'}
        </span>
        {confidence != null && (
          <span style={{ fontSize: '.68rem', color: confColor(confidence) }}>{Math.round(confidence * 100)}%</span>
        )}
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
      </div>

      {expanded && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            {['DIRECT', 'PRESET', 'EXPRESSION'].map((t) => (
              <button
                key={t}
                className={`btn btn-sm ${mapping.transform === t ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => onUpdate({
                  transform: t, preset: t === 'PRESET' ? (mapping.preset || 'dateFormat') : null,
                  expression: t === 'EXPRESSION' ? (mapping.expression || generateExpression(mapping.sources, mapping.srcTypes, mapping.destinations, mapping.destTypes)) : mapping.expression,
                })}
              >
                {t === 'DIRECT' ? 'Direct Copy' : t === 'PRESET' ? 'Preset' : 'JavaScript'}
              </button>
            ))}
          </div>

          {mapping.transform === 'PRESET' && (
            <select value={mapping.preset || ''} onChange={(e) => onUpdate({ preset: e.target.value })} style={{ width: '100%', marginBottom: 10 }}>
              {PRESET_TRANSFORMS.map((p) => <option key={p.value} value={p.value}>{p.label} — {p.desc}</option>)}
            </select>
          )}

          {mapping.transform === 'EXPRESSION' && (
            <>
              <textarea value={mapping.expression || ''} onChange={(e) => onUpdate({ expression: e.target.value })} spellCheck={false}
                style={{ width: '100%', minHeight: 90, fontFamily: 'monospace', fontSize: '.78rem', marginBottom: 8 }} />
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <input value={nl} onChange={(e) => setNl(e.target.value)} placeholder="Describe a transform in plain English…" style={{ flex: 1 }} />
                <button className="btn btn-outline btn-sm" disabled={nlBusy} onClick={genNl}>{nlBusy ? '…' : '✨ Generate'}</button>
              </div>
            </>
          )}

          <div style={{ background: 'var(--bg-main)', borderRadius: 'var(--radius-sm)', padding: 8, fontSize: '.74rem' }}>
            <div style={{ color: 'var(--text-dim)' }}>Input: {JSON.stringify(sample)}</div>
            {previewErr ? <div style={{ color: 'var(--error)' }}>Error: {previewErr}</div> : <div style={{ color: 'var(--success)' }}>Output: {preview}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
