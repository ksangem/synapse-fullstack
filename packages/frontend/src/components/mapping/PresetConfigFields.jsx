import { useState } from 'react';
import { presetConfigSpec } from './mappingUtils';

/* Config form for the presets that take options (codeMap / default / currency /
   divide / parseDate). Schema-driven from PRESET_CONFIG_SPEC, so adding a preset
   option is a one-line change in mappingUtils — no UI edit. Shared by the
   Connection Wizard (step 4) and the Mapping Canvas; emits the `presetConfig`
   object the backend's MappingEngine reads. */

const inputStyle = {
  width: '100%', padding: '5px 6px', borderRadius: 'var(--radius)',
  border: '1px solid var(--border)', fontSize: 'var(--fs-sm)',
};
const helpStyle = { fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 3 };

/** Editor for a free-form code → value table. Rows are held locally so typing a
    key doesn't churn the parent object (which would reorder rows and drop focus). */
function KeyValueEditor({ value, onChange }) {
  const [rows, setRows] = useState(() => Object.entries(value || {}).map(([k, v]) => ({ k, v: String(v ?? '') })));

  const commit = (next) => {
    setRows(next);
    const map = {};
    for (const r of next) if (r.k.trim() !== '') map[r.k] = r.v;
    onChange(map);
  };
  const setRow = (i, patch) => commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const dupes = new Set(rows.map((r) => r.k.trim()).filter((k, i, a) => k && a.indexOf(k) !== i));

  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
          <input
            value={r.k}
            onChange={(e) => setRow(i, { k: e.target.value })}
            placeholder="Code (e.g. A)"
            style={{ ...inputStyle, flex: 1, borderColor: dupes.has(r.k.trim()) ? 'var(--warning-on)' : 'var(--border)' }}
          />
          <span style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-sm)' }}>→</span>
          <input
            value={r.v}
            onChange={(e) => setRow(i, { v: e.target.value })}
            placeholder="Value (e.g. Active)"
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            title="Remove this code"
            onClick={() => commit(rows.filter((_, j) => j !== i))}
          >
            &times;
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-outline btn-sm" onClick={() => commit([...rows, { k: '', v: '' }])}>
        + Add code
      </button>
      {dupes.size > 0 && (
        <div style={{ ...helpStyle, color: 'var(--warning-on)' }}>
          Duplicate code{dupes.size > 1 ? 's' : ''} — the last row wins.
        </div>
      )}
    </div>
  );
}

export default function PresetConfigFields({ preset, config, onChange }) {
  const spec = presetConfigSpec(preset);
  if (!spec) return null;

  const cfg = config || {};
  const set = (key, val) => onChange({ ...cfg, [key]: val });

  return (
    <div style={{ marginBottom: 10, padding: 8, border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--bg-input)' }}>
      {spec.map((f) => (
        <div key={f.key} style={{ marginBottom: 8 }}>
          <label style={{ display: 'block', fontSize: 'var(--fs-xs)', fontWeight: 'var(--fw-semibold)', marginBottom: 3 }} htmlFor="presetconfigfields-field">
            {f.label}{f.required && <span style={{ color: 'var(--error-on)' }}> *</span>}
          </label>

          {f.type === 'keyvalue' && (
            <KeyValueEditor value={cfg[f.key]} onChange={(v) => set(f.key, v)} />
          )}

          {f.type === 'select' && (
            <select id="presetconfigfields-field" value={cfg[f.key] ?? f.default ?? ''} onChange={(e) => set(f.key, e.target.value)} style={inputStyle}>
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}

          {f.type === 'number' && (
            <input
              type="number"
              value={cfg[f.key] ?? ''}
              placeholder={f.default !== undefined ? String(f.default) : ''}
              // Keep the stored value a real number — the backend coerces with Number(),
              // and '' must clear the key rather than persist as NaN.
              onChange={(e) => set(f.key, e.target.value === '' ? undefined : Number(e.target.value))}
              style={inputStyle}
            />
          )}

          {f.type === 'text' && (
            <input
              value={cfg[f.key] ?? ''}
              placeholder={f.default !== undefined ? String(f.default) : ''}
              onChange={(e) => set(f.key, e.target.value)}
              style={inputStyle}
            />
          )}

          {f.help && <div style={helpStyle}>{f.help}</div>}
        </div>
      ))}
    </div>
  );
}
