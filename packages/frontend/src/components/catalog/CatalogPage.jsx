import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { ConnectorIcon } from '../studio/StudioPage';

/* Master Entity Catalog — real data from /api/entities. Entities are grouped by
   connector (our real "department"); usage bars reflect how often each field is
   referenced across saved integration mappings. Replaces the former mock. */

const TYPE_BADGE = {
  string: 'badge-neutral', text: 'badge-neutral', number: 'badge-info', datetime: 'badge-warning',
  date: 'badge-warning', boolean: 'badge-success', object: 'badge-primary', array: 'badge-primary',
};

function titleCase(name) {
  return String(name).replace(/[_.]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function CatalogPage() {
  const navigate = useNavigate();
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [selected, setSelected] = useState(null); // { group, entity }

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await api.getEntityCatalog();
      if (res.ok && res.data?.data?.groups) {
        const g = res.data.data.groups;
        setGroups(g);
        const exp = {};
        g.forEach((x) => { exp[x.connectorId] = true; });
        setExpanded(exp);
        // default selection: first group with an entity
        const firstGroup = g.find((x) => x.entities.length);
        if (firstGroup) setSelected({ group: firstGroup, entity: firstGroup.entities[0] });
      }
      setLoading(false);
    })();
  }, []);

  const maxUsage = useMemo(() => {
    let m = 1;
    groups.forEach((g) => g.entities.forEach((e) => e.fields.forEach((f) => { if (f.usageCount > m) m = f.usageCount; })));
    return m;
  }, [groups]);

  const toggle = (id) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Master Entity Catalog</div>
          <div className="page-subtitle">Canonical data model across all connectors</div>
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => navigate('/studio')}>&#9881; Manage in Studio</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20, flex: 1, minHeight: 0, paddingBottom: 16 }}>
        {/* ── Tree (connector → entities) — scrolls internally when tall ── */}
        <div className="card" style={{ padding: 12, minHeight: 0, overflowY: 'auto' }}>
          {loading && <div style={{ color: 'var(--text-dim)', fontSize: '.82rem' }}>Loading…</div>}
          {!loading && groups.length === 0 && <div style={{ color: 'var(--text-dim)', fontSize: '.82rem' }}>No connectors yet.</div>}
          {groups.map((g) => (
            <div key={g.connectorId} style={{ marginBottom: 4 }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 2px', cursor: 'pointer', fontWeight: 600, fontSize: '.84rem' }}
                onClick={() => toggle(g.connectorId)}
              >
                <span style={{ fontSize: '.7rem' }}>{expanded[g.connectorId] ? '▼' : '▶'}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center' }}><ConnectorIcon icon={g.icon} size={16} /></span>
                <span>{g.connectorName}</span>
                <span className="badge badge-neutral" style={{ fontSize: '.58rem', marginLeft: 'auto' }}>{g.entities.length}</span>
              </div>
              {expanded[g.connectorId] && g.entities.map((e) => (
                <div
                  key={e.key}
                  className={selected?.entity?.key === e.key && selected?.group?.connectorId === g.connectorId ? 'active' : ''}
                  style={{
                    padding: '4px 4px 4px 26px', cursor: 'pointer', fontSize: '.82rem', borderRadius: 'var(--radius-sm)',
                    background: selected?.entity?.key === e.key && selected?.group?.connectorId === g.connectorId ? 'var(--primary-soft, rgba(99,102,241,.12))' : 'transparent',
                    color: selected?.entity?.key === e.key && selected?.group?.connectorId === g.connectorId ? 'var(--primary)' : 'inherit',
                  }}
                  onClick={() => setSelected({ group: g, entity: e })}
                >
                  {e.name} <span style={{ color: 'var(--text-dim)', fontSize: '.7rem' }}>({e.fieldCount})</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* ── Detail — scrolls independently of the tree ── */}
        <div className="panel" style={{ minHeight: 0, overflowY: 'auto', padding: 16 }}>
          {!selected && !loading && (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>Select an entity to inspect its fields.</div>
          )}
          {selected && (
            <>
              <div className="card" style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{selected.entity.name}</div>
                  <span className="badge badge-info" style={{ fontSize: '.62rem' }}>{selected.group.connectorName}</span>
                  <span style={{ marginLeft: 'auto', fontSize: '.74rem', color: 'var(--text-dim)' }}>
                    Used by {selected.group.usedByAdapters} adapter{selected.group.usedByAdapters === 1 ? '' : 's'}
                  </span>
                </div>
                {selected.entity.description && <div style={{ fontSize: '.8rem', color: 'var(--text-dim)', marginBottom: 12 }}>{selected.entity.description}</div>}

                {selected.entity.fields.length === 0 ? (
                  <div style={{ fontSize: '.82rem', color: 'var(--text-dim)' }}>
                    Fields for this entity are discovered live at mapping time (this connector uses runtime discovery, not a static schema).
                  </div>
                ) : (
                  <table>
                    <thead><tr><th>Field</th><th>Label</th><th>Type</th><th>Required</th><th>Usage</th></tr></thead>
                    <tbody>
                      {selected.entity.fields.map((f) => (
                        <tr key={f.name}>
                          <td style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>{f.name}</td>
                          <td>{titleCase(f.name)}</td>
                          <td><span className={`badge ${TYPE_BADGE[f.type] || 'badge-neutral'}`} style={{ fontSize: '.6rem' }}>{f.type}</span></td>
                          <td>{f.required ? '✔' : ''}</td>
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <div style={{ flex: 1, height: 6, background: 'var(--bg-main)', borderRadius: 3, overflow: 'hidden', minWidth: 60 }}>
                                <div style={{ width: `${Math.round((f.usageCount / maxUsage) * 100)}%`, height: '100%', background: f.usageCount > 0 ? 'var(--primary)' : 'transparent' }} />
                              </div>
                              <span style={{ fontSize: '.7rem', color: 'var(--text-dim)' }}>{f.usageCount}</span>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Cross-reference */}
              <div className="card">
                <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Cross-References</div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: '.74rem', color: 'var(--text-dim)', marginBottom: 4 }}>Defined by connector</div>
                    <div
                      style={{ color: 'var(--primary)', cursor: 'pointer', fontWeight: 600, fontSize: '.85rem' }}
                      onClick={() => navigate('/studio')}
                    >
                      <ConnectorIcon icon={selected.group.icon} size={15} /> {selected.group.connectorName}
                      {selected.group.isSystem ? ' (built-in)' : ' (custom)'}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: '.74rem', color: 'var(--text-dim)', marginBottom: 4 }}>Adapters</div>
                    <div
                      style={{ color: selected.group.usedByAdapters ? 'var(--primary)' : 'var(--text-dim)', cursor: selected.group.usedByAdapters ? 'pointer' : 'default', fontSize: '.85rem' }}
                      onClick={() => selected.group.usedByAdapters && navigate('/connected')}
                    >
                      {selected.group.usedByAdapters} integration{selected.group.usedByAdapters === 1 ? '' : 's'} use this connector
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
