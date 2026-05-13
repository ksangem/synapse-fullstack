import { useState, useCallback } from 'react';
import { initialMappings, sourceFields, destFields, pairColors } from '../../data/mappings';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';

const presets = [
  { value: 'none', label: 'None (Direct Copy)' },
  { value: 'dateformat', label: 'Date Format (YYYY-MM-DD)' },
  { value: 'uppercase', label: 'Uppercase' },
  { value: 'lowercase', label: 'Lowercase' },
  { value: 'trim', label: 'Trim Whitespace' },
  { value: 'concat', label: 'Concatenate' },
  { value: 'split', label: 'Split' },
  { value: 'regex', label: 'Regex Replace' },
  { value: 'join', label: 'Join Array' },
];

export default function CanvasPage() {
  const [mappings, setMappings] = useState(() => initialMappings.map(m => ({ ...m })));
  const [selectedField, setSelectedField] = useState(null);
  const [mappingsActive, setMappingsActive] = useState(true);
  const { openDetailPane, closeDetailPane } = useDetailPane();
  const { showToast } = useToast();

  const removeMapping = useCallback((idx) => {
    setMappings(prev => {
      const next = [...prev];
      next.splice(idx, 1);
      return next;
    });
    closeDetailPane();
    showToast('Mapping removed');
  }, [closeDetailPane, showToast]);

  const showMappingDetail = useCallback((idx, currentMappings) => {
    const m = currentMappings[idx];
    if (!m) return;
    const confColor = m.confidence >= 85 ? 'var(--success)' : m.confidence >= 70 ? 'var(--warning)' : 'var(--error)';

    const content = (
      <div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: '.9rem', fontWeight: 700, marginBottom: 8 }}>
            {m.src} &rarr; {m.dest}
          </div>
          <span className="badge" style={{ background: confColor, color: '#fff', opacity: 0.9 }}>
            {m.confidence}% confidence
          </span>{' '}
          {m.type !== 'manual'
            ? <span className="badge badge-primary">AI-mapped</span>
            : <span className="badge badge-neutral">Manual</span>
          }
        </div>

        <div className="form-group">
          <label>Preset Transformation</label>
          <select defaultValue="none">
            {presets.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Custom Expression</label>
          <input
            type="text"
            placeholder="e.g., toUpperCase(trim(value))"
            style={{ fontFamily: 'monospace', fontSize: '.78rem' }}
          />
        </div>

        <div className="form-group">
          <label>Describe in natural language</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              placeholder="e.g., Convert ISO date to DD/MM/YYYY format"
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary btn-sm">AI Generate</button>
          </div>
        </div>

        <div style={{ fontWeight: 600, fontSize: '.82rem', margin: '12px 0 4px' }}>Preview</div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: 10,
          background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', fontSize: '.82rem',
        }}>
          <span style={{ color: 'var(--text-dim)' }}>2026-03-28T09:14:00Z</span>
          <span style={{ color: 'var(--primary)', fontWeight: 700 }}>&rarr;</span>
          <span style={{ color: 'var(--success)', fontWeight: 600 }}>2026-03-28</span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => showToast('Transform applied')}
          >
            Apply
          </button>
          <button
            className="btn btn-danger btn-sm"
            onClick={() => removeMapping(idx)}
          >
            Remove Mapping
          </button>
        </div>
      </div>
    );

    openDetailPane(
      'Mapping: ' + m.src + ' \u2192 ' + m.dest,
      content,
      'Mapping Canvas > Field Pair #' + (idx + 1)
    );
  }, [openDetailPane, showToast, removeMapping]);

  const handleFieldClick = (fieldName, side, mapIdx) => {
    if (mapIdx >= 0) {
      showMappingDetail(mapIdx, mappings);
      return;
    }
    // Unmapped field - select for pairing
    if (selectedField && selectedField.side !== side) {
      const newMap = side === 'source'
        ? { src: fieldName, dest: selectedField.field, confidence: 100, type: 'manual' }
        : { src: selectedField.field, dest: fieldName, confidence: 100, type: 'manual' };
      setMappings(prev => [...prev, newMap]);
      setSelectedField(null);
      showToast('Mapping created: ' + newMap.src + ' \u2192 ' + newMap.dest);
      return;
    }
    setSelectedField({ field: fieldName, side });
  };

  const autoMap = () => {
    setMappingsActive(false);
    setTimeout(() => {
      setMappingsActive(true);
      showToast('AI Auto-Map complete: ' + mappings.length + ' fields mapped');
    }, 800);
  };

  const clearMappings = () => {
    setMappingsActive(false);
    showToast('All mappings cleared');
  };

  const getSourceMapIdx = (fieldName) => {
    if (!mappingsActive) return -1;
    return mappings.findIndex(m => m.src === fieldName);
  };

  const getDestMapIdx = (fieldName) => {
    if (!mappingsActive) return -1;
    return mappings.findIndex(m => m.dest === fieldName);
  };

  const confColor = (conf) =>
    conf >= 85 ? 'var(--success)' : conf >= 70 ? 'var(--warning)' : 'var(--error)';

  return (
    <div className="page active">
      <div className="page-header" style={{ marginBottom: 12 }}>
        <div>
          <div className="page-title">Mapping Canvas</div>
          <div className="page-subtitle">Jira Issues &rarr; SharePoint Tasks</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-outline btn-sm" onClick={autoMap}>
            &#129302; Auto-Map
          </button>
          <button className="btn btn-outline btn-sm" onClick={clearMappings}>
            &#10006; Clear All
          </button>
        </div>
      </div>

      <div className="mapping-container">
        {/* Source panel */}
        <div className="mapping-panel">
          <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8, color: 'var(--info)' }}>
            &#128196; Source: Jira Issue
          </div>
          <div>
            {sourceFields.map((f) => {
              const mapIdx = getSourceMapIdx(f.name);
              const isMapped = mapIdx >= 0;
              const colorClass = isMapped ? pairColors[mapIdx % pairColors.length] : '';
              const isSelected = selectedField && selectedField.field === f.name && selectedField.side === 'source';

              return (
                <div
                  key={f.name}
                  className={`mapping-field${isMapped ? ' mapped' : ''}${isSelected ? ' selected' : ''}`}
                  onClick={() => handleFieldClick(f.name, 'source', mapIdx)}
                >
                  <span className={`map-dot ${colorClass}`}></span>
                  <span className="field-name">{f.name}</span>
                  <span className="field-type">{f.type}</span>
                  {isMapped && (
                    <>
                      <span className="map-num">{mapIdx + 1}</span>
                      <span className="confidence-inline" style={{ color: confColor(mappings[mapIdx].confidence) }}>
                        {mappings[mapIdx].confidence}%
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Center column */}
        <div className="mapping-center-col">
          <div style={{ fontSize: '.6rem', fontWeight: 700, color: 'var(--text-dim)', marginBottom: 8, textAlign: 'center' }}>#</div>
          {mappingsActive && mappings.map((m, idx) => (
            <div
              key={idx}
              className={`mapping-pair-num ${pairColors[idx % pairColors.length]}`}
              onClick={() => showMappingDetail(idx, mappings)}
              title={`${m.src} \u2192 ${m.dest}`}
            >
              {idx + 1}
            </div>
          ))}
        </div>

        {/* Dest panel */}
        <div className="mapping-panel">
          <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8, color: 'var(--success)' }}>
            &#128196; Dest: SharePoint Task
          </div>
          <div>
            {destFields.map((f) => {
              const mapIdx = getDestMapIdx(f.name);
              const isMapped = mapIdx >= 0;
              const colorClass = isMapped ? pairColors[mapIdx % pairColors.length] : '';
              const isSelected = selectedField && selectedField.field === f.name && selectedField.side === 'dest';

              return (
                <div
                  key={f.name}
                  className={`mapping-field${isMapped ? ' mapped' : ''}${isSelected ? ' selected' : ''}`}
                  onClick={() => handleFieldClick(f.name, 'dest', mapIdx)}
                >
                  <span className={`map-dot ${colorClass}`}></span>
                  <span className="field-name">{f.name}</span>
                  <span className="field-type">{f.type}</span>
                  {isMapped && (
                    <span className="map-num">{mapIdx + 1}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
