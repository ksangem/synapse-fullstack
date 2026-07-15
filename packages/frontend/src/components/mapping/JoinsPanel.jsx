import React, { useState, useCallback, useEffect } from 'react';

/**
 * JoinsPanel — configure cross-entity joins (enrichment / lookup / aggregate).
 *
 * Intent-driven flow: instead of one raw form, the user picks WHAT they want
 * ("look up an ID", "add details", "summarize related records") and answers a few
 * plain-language questions. Configured joins read back as sentences. The raw form is
 * preserved as an "advanced" fallback for chained/hand-tuned joins.
 *
 * Output is unchanged — the same backend JoinSpec array
 * ({ alias, on:{localField,op}, entity:{side,ref,keyColumn}, pull, aggregate, onMissing }),
 * so WizardPage + the backend need no changes. The @join.<alias>.<as> fields those joins
 * produce appear in the source-field picker exactly as before.
 */

const AGG_FNS = ['count', 'sum', 'avg', 'min', 'max', 'concat', 'first'];

/* ── styles (inline, token-based so both themes work) ── */
const S = {
  panel: { margin: '0 0 16px', border: '1px solid var(--border)', borderRadius: 10 },
  head: { width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text)' },
  body: { padding: '4px 14px 16px' },
  lbl: { fontSize: '.72rem', color: 'var(--text-dim)', display: 'block', marginBottom: 3 },
  inp: { width: '100%', padding: '6px 8px', fontSize: '.82rem', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)' },
  addBtn: { display: 'inline-flex', alignItems: 'center', gap: 8, background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 8, padding: '9px 14px', fontSize: '.85rem', fontWeight: 600, cursor: 'pointer' },
  ghost: { fontSize: '.78rem', padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' },
  link: { fontSize: '.76rem', background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 4 },
  chip: { display: 'flex', alignItems: 'center', gap: 11, background: 'var(--bg-card, var(--bg))', border: '1px solid var(--border)', borderRadius: 9, padding: '11px 13px', marginBottom: 9 },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 9 },
  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 9 },
  rowX: { display: 'grid', gridTemplateColumns: '1fr 1fr 30px', gap: 9, alignItems: 'end', marginTop: 8 },
  card: (c) => ({ textAlign: 'left', background: 'var(--bg-card, var(--bg))', border: '1px solid var(--border)', borderLeft: `3px solid ${c}`, borderRadius: 10, padding: 14, cursor: 'pointer', color: 'var(--text)' }),
};
const INTENTS = {
  lookup:   { icon: '🔗', color: 'var(--primary)',                 title: 'Look up an ID',      blurb: 'My data has a name or code, but the destination needs the matching ID.' },
  enrich:   { icon: '➕', color: 'var(--success, #12916a)',        title: 'Add details',        blurb: 'Pull extra columns from another list or table that shares a key.' },
  aggregate:{ icon: '∑', color: 'var(--warning, #d9821a)',        title: 'Summarize',          blurb: 'Count, sum, or average the related records for each item.' },
};

/* ── helpers ── */
const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
function uniqueAlias(base, taken) {
  let a = base || 'lookup'; let n = 2;
  while (taken.has(a)) a = `${base || 'lookup'}_${n++}`;
  return a;
}
function detectIntent(j) {
  if (j.aggregate?.length) return 'aggregate';
  if (j.entity?.side === 'dest') return 'lookup';
  if (j.entity?.side === 'source' && j.pull?.length) return 'enrich';
  return 'advanced';
}
/** Plain-language sentence for a configured join. */
function describe(j) {
  const local = j.on?.localField || '?';
  const where = j.entity?.ref || '?';
  const key = j.entity?.keyColumn || '?';
  const intent = detectIntent(j);
  if (intent === 'lookup') {
    const as = j.pull?.[0]?.as || j.pull?.[0]?.column || 'value';
    return { icon: '🔗', color: 'var(--primary)', text: `Look up ${as} by matching ${local} to ${where}.${key}${j.onMissing === 'error' ? ' — flag if missing' : ''}` };
  }
  if (intent === 'aggregate') {
    const parts = (j.aggregate || []).map((a) => `${a.fn}${a.column ? ` of ${a.column}` : ''} → ${a.as}`).join(', ');
    return { icon: '∑', color: 'var(--warning, #d9821a)', text: `Per ${local}: ${parts} from related ${where}` };
  }
  if (intent === 'enrich') {
    const cols = (j.pull || []).map((p) => p.as || p.column).join(', ');
    return { icon: '➕', color: 'var(--success, #12916a)', text: `Add ${cols} from ${where}, matched on ${key}` };
  }
  return { icon: '⚙', color: 'var(--text-dim)', text: `Advanced join "${j.alias}" on ${local}` };
}

/* ── draft <-> spec conversion for the guided intents ── */
function blankDraft(intent) {
  const base = { _intent: intent, localField: '', op: 'eq', ref: '', keyColumn: '' };
  if (intent === 'lookup') return { ...base, side: 'dest', returnColumn: '', resultName: '', onMissing: 'error' };
  if (intent === 'enrich') return { ...base, side: 'source', cols: [{ column: '', as: '' }], onMissing: 'null' };
  if (intent === 'aggregate') return { ...base, side: 'source', aggs: [{ fn: 'count', column: '', resultName: '' }], onMissing: 'null' };
  return base;
}
function draftFromSpec(j) {
  const intent = detectIntent(j);
  const base = { _intent: intent, alias: j.alias, localField: j.on?.localField || '', op: j.on?.op || 'eq', side: j.entity?.side || 'source', ref: j.entity?.ref || '', keyColumn: j.entity?.keyColumn || '', onMissing: j.onMissing || 'null' };
  if (intent === 'lookup') return { ...base, returnColumn: j.pull?.[0]?.column || '', resultName: j.pull?.[0]?.as || '' };
  if (intent === 'enrich') return { ...base, cols: (j.pull || []).map((p) => ({ column: p.column, as: p.as })) };
  if (intent === 'aggregate') return { ...base, aggs: (j.aggregate || []).map((a) => ({ fn: a.fn, column: a.column || '', resultName: a.as })) };
  return { _intent: 'advanced', ...j }; // advanced edits the raw spec
}
function specFromDraft(d, existingAliases) {
  const alias = d.alias || uniqueAlias(slug(d.ref) || slug(d.resultName) || 'lookup', existingAliases);
  const on = { localField: d.localField, op: d.op || 'eq' };
  const entity = { side: d.side, ref: d.ref, keyColumn: d.keyColumn };
  if (d._intent === 'lookup') return { alias, on, entity, pull: [{ column: d.returnColumn, as: slug(d.resultName) || slug(d.returnColumn) }], onMissing: d.onMissing || 'error' };
  if (d._intent === 'enrich') return { alias, on, entity, pull: (d.cols || []).filter((c) => c.column).map((c) => ({ column: c.column, as: slug(c.as) || slug(c.column) })), onMissing: 'null' };
  if (d._intent === 'aggregate') return { alias, on, entity, aggregate: (d.aggs || []).filter((a) => a.fn && (a.fn === 'count' || a.column)).map((a) => ({ fn: a.fn, ...(a.fn === 'count' ? {} : { column: a.column }), as: slug(a.resultName) || a.fn })), onMissing: 'null' };
  return d; // advanced: already a spec
}

const DEFAULT_SIDES = [
  { side: 'dest', label: 'a destination table', noun: 'table', discover: false },
  { side: 'source', label: 'another source list/table', noun: 'entity', discover: false },
];

export default function JoinsPanel({ joins = [], setJoins, srcFields = [], sides = DEFAULT_SIDES, entitiesFor = () => [], loadColumns }) {
  const [open, setOpen] = useState(joins.length > 0);
  const [view, setView] = useState('list');        // 'list' | 'intent' | 'form'
  const [draft, setDraft] = useState(null);
  const [editIndex, setEditIndex] = useState(-1);
  const [cols, setCols] = useState({});             // cache: `${side}::${entity}` -> column names[]

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  // Fetch an entity's columns once (only for a real, known entity) so the column fields become
  // dropdowns. Unknown/typed entities stay free-text.
  const ensureCols = useCallback((side, entity) => {
    const key = `${side}::${entity}`;
    if (!entity || !loadColumns || cols[key] || !entitiesFor(side).includes(entity)) return;
    Promise.resolve(loadColumns(side, entity)).then((c) => setCols((prev) => ({ ...prev, [key]: c || [] })));
  }, [loadColumns, cols, entitiesFor]);
  const columnsFor = (side, entity) => cols[`${side}::${entity}`] || [];

  // localField options: native source fields + OTHER joins' outputs (chaining).
  const localOptions = joins
    .filter((_, i) => i !== editIndex)
    .flatMap((j) => [...(j.pull || []), ...(j.aggregate || [])].filter((o) => o.as).map((o) => `@join.${j.alias}.${o.as}`))
    .concat(srcFields.map((f) => f.name));

  const startAdd = () => { setView('intent'); setEditIndex(-1); };
  const chooseIntent = (intent) => { setDraft(blankDraft(intent)); setView('form'); };
  const startEdit = (i) => { setDraft(draftFromSpec(joins[i])); setEditIndex(i); setView('form'); };
  const cancel = () => { setDraft(null); setEditIndex(-1); setView('list'); };
  const remove = (i) => setJoins(joins.filter((_, idx) => idx !== i));

  const save = () => {
    const taken = new Set(joins.filter((_, i) => i !== editIndex).map((j) => j.alias));
    const { _intent, ...spec } = specFromDraft(draft, taken); // strip transient marker
    const next = editIndex >= 0 ? joins.map((j, i) => (i === editIndex ? spec : j)) : [...joins, spec];
    setJoins(next);
    cancel();
  };

  // The advanced draft carries nested on/entity/pull/aggregate; the guided drafts are flat.
  const valid = !!draft && (
    draft._intent === 'advanced'
      ? !!(draft.on?.localField && draft.entity?.ref && draft.entity?.keyColumn &&
          ((draft.pull || []).some((p) => p.column) || (draft.aggregate || []).some((a) => a.fn === 'count' || a.column)))
      : !!(draft.localField && draft.ref && draft.keyColumn && (
          (draft._intent === 'lookup' && draft.returnColumn) ||
          (draft._intent === 'enrich' && (draft.cols || []).some((c) => c.column)) ||
          (draft._intent === 'aggregate' && (draft.aggs || []).some((a) => a.fn === 'count' || a.column))
        ))
  );

  return (
    <div style={S.panel}>
      <button style={S.head} onClick={() => setOpen(!open)}>
        <span style={{ fontWeight: 600, fontSize: '.9rem' }}>
          {open ? '▾' : '▸'} Cross-Entity Joins{' '}
          <span style={{ color: 'var(--text-dim)', fontWeight: 400 }}>— pull, look up, or summarize from another entity</span>
        </span>
        {joins.length > 0 && <span className="col-count">{joins.length}</span>}
      </button>

      {open && (
        <div style={S.body}>
          {/* ── LIST ── */}
          {view === 'list' && (
            <>
              {joins.map((j, i) => {
                const d = describe(j);
                return (
                  <div key={i} style={{ ...S.chip, borderLeft: `3px solid ${d.color}` }}>
                    <span style={{ fontSize: '1rem' }}>{d.icon}</span>
                    <span style={{ fontSize: '.82rem', flex: 1, lineHeight: 1.4 }}>{d.text}</span>
                    <button style={S.link} onClick={() => startEdit(i)}>Edit</button>
                    <button style={{ ...S.link, color: 'var(--error, #c0392b)' }} onClick={() => remove(i)}>Remove</button>
                  </div>
                );
              })}
              <button style={S.addBtn} onClick={startAdd}>＋ Add data from another place</button>
            </>
          )}

          {/* ── INTENT CHOOSER ── */}
          {view === 'intent' && (
            <>
              <p style={{ fontSize: '.8rem', color: 'var(--text-dim)', margin: '2px 0 12px' }}>What do you want to add?</p>
              <div style={S.grid3}>
                {Object.entries(INTENTS).map(([key, it]) => (
                  <button key={key} style={S.card(it.color)} onClick={() => chooseIntent(key)}>
                    <div style={{ fontSize: '1.1rem', marginBottom: 6 }}>{it.icon} <strong style={{ fontSize: '.9rem' }}>{it.title}</strong></div>
                    <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', lineHeight: 1.45 }}>{it.blurb}</div>
                  </button>
                ))}
              </div>
              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                <button style={S.link} onClick={() => chooseIntent('advanced')}>Advanced (raw editor)…</button>
                <button style={S.ghost} onClick={cancel}>Cancel</button>
              </div>
            </>
          )}

          {/* ── GUIDED / ADVANCED FORM ── */}
          {view === 'form' && draft && (
            <GuidedForm
              draft={draft} set={set} setDraft={setDraft} localOptions={localOptions}
              valid={valid} onSave={save} onCancel={cancel} sides={sides}
              entitiesFor={entitiesFor} columnsFor={columnsFor} ensureCols={ensureCols}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* A real dropdown that lists known values, with a "type a name" escape for new/unknown ones
   (e.g. a table that doesn't exist yet). Falls back to a plain text box when there's nothing to list. */
function PickField({ value, options = [], onChange, placeholder }) {
  const known = options.length > 0;
  const [typing, setTyping] = useState(false);
  const manual = !known || typing || (!!value && !options.includes(value));
  if (manual) {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input style={S.inp} value={value || ''} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        {known && <button style={S.ghost} title="Pick from list" onClick={() => { setTyping(false); onChange(''); }}>▾</button>}
      </div>
    );
  }
  return (
    <select style={S.inp} value={value || ''} onChange={(e) => { if (e.target.value === '__type__') { setTyping(true); onChange(''); } else onChange(e.target.value); }}>
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
      <option value="__type__">✏️ Type a name…</option>
    </select>
  );
}

/* ── the guided (and advanced) form for one join ── */
function GuidedForm({ draft, set, setDraft, localOptions, valid, onSave, onCancel, sides = DEFAULT_SIDES, entitiesFor = () => [], columnsFor = () => [], ensureCols = () => {} }) {
  const d = draft;
  const isAdv = d._intent === 'advanced';
  const it = INTENTS[d._intent];
  const [advOpen, setAdvOpen] = useState(false);

  // Which connectors this connection can look values up in, and each one's vocabulary.
  const sideList = sides.length ? sides : DEFAULT_SIDES;
  const current = sideList.find((s) => s.side === d.side) || sideList[0];
  const noun = current?.noun || 'entity';   // "table" | "list" | "entity", per the connector
  const discover = !!current?.discover;      // can we list this side's schema for dropdowns?
  // A discoverable side's columns load (for the dropdowns) once its container is chosen.
  useEffect(() => { if (discover) ensureCols(d.side, d.ref); }, [discover, d.side, d.ref, ensureCols]);
  const tableList = discover ? entitiesFor(d.side) : [];
  const colList = discover ? columnsFor(d.side, d.ref) : [];

  const dl = 'joins-localopts';
  const LocalField = (
    <div>
      <label style={S.lbl}>Which field in your data has the value to match?</label>
      <input style={S.inp} list={dl} value={d.localField} placeholder="e.g. ClientName" onChange={(e) => set({ localField: e.target.value })} />
      <datalist id={dl}>{localOptions.map((n) => <option key={n} value={n} />)}</datalist>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: '1rem' }}>{it ? it.icon : '⚙'}</span>
        <strong style={{ fontSize: '.9rem' }}>{it ? it.title : 'Advanced join'}</strong>
      </div>

      {isAdv ? (
        <AdvancedFields d={d} set={set} localOptions={localOptions} />
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          {LocalField}

          <div>
            <label style={S.lbl}>Where does the value live?</label>
            <select style={S.inp} value={d.side} onChange={(e) => set({ side: e.target.value, ref: '', keyColumn: '', returnColumn: '' })}>
              {sideList.map((s) => <option key={s.side} value={s.side}>{s.label} ({s.side === 'dest' ? 'destination' : 'source'})</option>)}
            </select>
          </div>

          <div>
            <label style={S.lbl}>Which {noun} holds it?</label>
            <PickField value={d.ref} options={tableList} placeholder={discover ? `pick a ${noun}…` : `enter ${noun} name…`}
              onChange={(v) => set({ ref: v, keyColumn: '', returnColumn: '' })} />
            {discover && !tableList.length && (
              <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 4 }}>
                No {noun}s loaded from {current.label} yet — type a name, or re-test that connection so its {noun}s load.
              </div>
            )}
            {discover && d.ref && tableList.length > 0 && !colList.length && (
              <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 4 }}>loading columns…</div>
            )}
          </div>

          <div>
            <label style={S.lbl}>Match it against — which column?</label>
            <PickField value={d.keyColumn} options={colList} placeholder={discover ? 'pick a column…' : 'enter column name…'}
              onChange={(v) => set({ keyColumn: v })} />
          </div>

          {d._intent === 'lookup' && (
            <div style={S.grid2}>
              <div>
                <label style={S.lbl}>Bring back — which column?</label>
                <PickField value={d.returnColumn} options={colList} placeholder="e.g. id"
                  onChange={(v) => set({ returnColumn: v, resultName: d.resultName || v })} />
              </div>
              <div>
                <label style={S.lbl}>Name this result</label>
                <input style={S.inp} value={d.resultName} placeholder="e.g. account_id" onChange={(e) => set({ resultName: e.target.value })} />
              </div>
            </div>
          )}

          {d._intent === 'enrich' && (
            <div>
              <label style={S.lbl}>Columns to bring in</label>
              {(d.cols || []).map((c, i) => (
                <div key={i} style={S.rowX}>
                  <PickField value={c.column} options={colList} placeholder="column (e.g. Region)"
                    onChange={(v) => set({ cols: d.cols.map((x, j) => j === i ? { ...x, column: v, as: x.as || v } : x) })} />
                  <input style={S.inp} value={c.as} placeholder="name it (e.g. region)" onChange={(e) => set({ cols: d.cols.map((x, j) => j === i ? { ...x, as: e.target.value } : x) })} />
                  <button style={S.ghost} onClick={() => set({ cols: d.cols.filter((_, j) => j !== i) })}>×</button>
                </div>
              ))}
              <button style={{ ...S.link, marginTop: 6 }} onClick={() => set({ cols: [...(d.cols || []), { column: '', as: '' }] })}>+ another column</button>
            </div>
          )}

          {d._intent === 'aggregate' && (
            <div>
              <label style={S.lbl}>What to calculate</label>
              {(d.aggs || []).map((a, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr 30px', gap: 9, alignItems: 'end', marginTop: 8 }}>
                  <select style={S.inp} value={a.fn} onChange={(e) => set({ aggs: d.aggs.map((x, j) => j === i ? { ...x, fn: e.target.value } : x) })}>
                    {AGG_FNS.map((fn) => <option key={fn} value={fn}>{fn}</option>)}
                  </select>
                  {a.fn === 'count'
                    ? <input style={{ ...S.inp, opacity: 0.5 }} value="(counts rows)" disabled readOnly />
                    : <PickField value={a.column} options={colList} placeholder="of column" onChange={(v) => set({ aggs: d.aggs.map((x, j) => j === i ? { ...x, column: v } : x) })} />}
                  <input style={S.inp} value={a.resultName} placeholder="name it (e.g. open_tickets)" onChange={(e) => set({ aggs: d.aggs.map((x, j) => j === i ? { ...x, resultName: e.target.value } : x) })} />
                  <button style={S.ghost} onClick={() => set({ aggs: d.aggs.filter((_, j) => j !== i) })}>×</button>
                </div>
              ))}
              <button style={{ ...S.link, marginTop: 6 }} onClick={() => set({ aggs: [...(d.aggs || []), { fn: 'count', column: '', resultName: '' }] })}>+ another</button>
            </div>
          )}

          <div>
            <button style={S.link} onClick={() => setAdvOpen(!advOpen)}>{advOpen ? '▾' : '▸'} Advanced options</button>
            {advOpen && (
              <div style={{ ...S.grid2, marginTop: 8 }}>
                <label style={{ fontSize: '.8rem', display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text)' }}>
                  <input type="checkbox" checked={d.op === 'ci-eq'} onChange={(e) => set({ op: e.target.checked ? 'ci-eq' : 'eq' })} />
                  Ignore upper/lower case when matching
                </label>
                {d._intent === 'lookup' && (
                  <div>
                    <label style={S.lbl}>If not found</label>
                    <select style={S.inp} value={d.onMissing} onChange={(e) => set({ onMissing: e.target.value })}>
                      <option value="error">Stop &amp; flag the row</option>
                      <option value="null">Leave it empty</option>
                    </select>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button style={{ ...S.addBtn, opacity: valid ? 1 : 0.5, cursor: valid ? 'pointer' : 'not-allowed' }} disabled={!valid} onClick={onSave}>Save</button>
        <button style={S.ghost} onClick={onCancel}>Cancel</button>
        {!isAdv && <button style={{ ...S.link, marginLeft: 'auto' }} onClick={() => setDraft({ _intent: 'advanced', ...specFromDraft(d, new Set()) })}>Edit as advanced…</button>}
      </div>
    </div>
  );
}

/* ── advanced raw editor (the original full form, kept as fallback) ── */
function AdvancedFields({ d, set, localOptions }) {
  const entity = d.entity || { side: 'source', ref: '', keyColumn: '' };
  const on = d.on || { localField: '', op: 'eq' };
  const setEntity = (patch) => set({ entity: { ...entity, ...patch } });
  const setOn = (patch) => set({ on: { ...on, ...patch } });
  const pull = d.pull || [];
  const aggregate = d.aggregate || [];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={S.grid3}>
        <div><label style={S.lbl}>Alias (namespace)</label><input style={S.inp} value={d.alias || ''} onChange={(e) => set({ alias: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })} /></div>
        <div><label style={S.lbl}>Match on (this row's field)</label><input style={S.inp} list="joins-localopts-adv" value={on.localField} onChange={(e) => setOn({ localField: e.target.value })} />
          <datalist id="joins-localopts-adv">{localOptions.map((n) => <option key={n} value={n} />)}</datalist>
        </div>
        <div><label style={S.lbl}>Match type</label>
          <select style={S.inp} value={on.op || 'eq'} onChange={(e) => setOn({ op: e.target.value })}><option value="eq">exact</option><option value="ci-eq">case-insensitive</option></select>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr 100px', gap: 9 }}>
        <div><label style={S.lbl}>Side</label><select style={S.inp} value={entity.side} onChange={(e) => setEntity({ side: e.target.value })}><option value="source">source</option><option value="dest">dest</option></select></div>
        <div><label style={S.lbl}>{entity.side === 'dest' ? 'Table' : 'Entity'}</label><input style={S.inp} value={entity.ref} onChange={(e) => setEntity({ ref: e.target.value })} /></div>
        <div><label style={S.lbl}>Key column</label><input style={S.inp} value={entity.keyColumn} onChange={(e) => setEntity({ keyColumn: e.target.value })} /></div>
        <div><label style={S.lbl}>If no match</label><select style={S.inp} value={d.onMissing || 'null'} onChange={(e) => set({ onMissing: e.target.value })}><option value="null">null</option><option value="error">fail row</option></select></div>
      </div>
      <div>
        <label style={S.lbl}>Pull columns</label>
        {pull.map((p, i) => (
          <div key={i} style={S.rowX}>
            <input style={S.inp} value={p.column} placeholder="column" onChange={(e) => set({ pull: pull.map((x, j) => j === i ? { ...x, column: e.target.value } : x) })} />
            <input style={S.inp} value={p.as} placeholder="as" onChange={(e) => set({ pull: pull.map((x, j) => j === i ? { ...x, as: e.target.value } : x) })} />
            <button style={S.ghost} onClick={() => set({ pull: pull.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        <button style={{ ...S.link, marginTop: 6 }} onClick={() => set({ pull: [...pull, { column: '', as: '' }] })}>+ pull column</button>
      </div>
      <div>
        <label style={S.lbl}>Aggregates</label>
        {aggregate.map((a, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr 30px', gap: 9, alignItems: 'end', marginTop: 8 }}>
            <select style={S.inp} value={a.fn} onChange={(e) => set({ aggregate: aggregate.map((x, j) => j === i ? { ...x, fn: e.target.value } : x) })}>{AGG_FNS.map((fn) => <option key={fn} value={fn}>{fn}</option>)}</select>
            <input style={S.inp} value={a.column || ''} disabled={a.fn === 'count'} placeholder={a.fn === 'count' ? '(no column)' : 'column'} onChange={(e) => set({ aggregate: aggregate.map((x, j) => j === i ? { ...x, column: e.target.value } : x) })} />
            <input style={S.inp} value={a.as} placeholder="as" onChange={(e) => set({ aggregate: aggregate.map((x, j) => j === i ? { ...x, as: e.target.value } : x) })} />
            <button style={S.ghost} onClick={() => set({ aggregate: aggregate.filter((_, j) => j !== i) })}>×</button>
          </div>
        ))}
        <button style={{ ...S.link, marginTop: 6 }} onClick={() => set({ aggregate: [...aggregate, { as: '', fn: 'count', column: '' }] })}>+ aggregate</button>
      </div>
    </div>
  );
}
