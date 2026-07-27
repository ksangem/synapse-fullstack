import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';
import { ConnectorIcon } from '../studio/StudioPage';
import { useToolbarAction } from '../../hooks/useToolbarAction';
import { SkeletonLines } from '../layout/Skeleton';
import StatStrip from '../ui/StatStrip';
import Icon from '../ui/Icon';
import { useGrowFrom, originRect } from '../../hooks/useGrowFrom';

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
  const [query, setQuery] = useState('');
  /* The detail column grows out of the tree row that selected it. */
  const [detailFrom, setDetailFrom] = useState(null);
  const detailRef = useRef(null);
  useGrowFrom(detailRef, detailFrom, { duration: 260 });

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await api.getEntityCatalog();
      if (res.ok && res.data?.data?.groups) {
        /* Every group starts collapsed, so the tree opens as a short list of
           connectors rather than a wall of entities. No default selection to go
           with it — showing a detail pane for an entity that is not visible in
           the tree reads as a bug; the empty state points at the tree instead. */
        setGroups(res.data.data.groups);
      }
      setLoading(false);
    })();
  }, []);

  const maxUsage = useMemo(() => {
    let m = 1;
    groups.forEach((g) => g.entities.forEach((e) => e.fields.forEach((f) => { if (f.usageCount > m) m = f.usageCount; })));
    return m;
  }, [groups]);

  const totals = useMemo(() => {
    let entities = 0, fields = 0, mapped = 0;
    groups.forEach((g) => g.entities.forEach((e) => {
      entities += 1;
      (e.fields || []).forEach((f) => { fields += 1; if (f.usageCount > 0) mapped += 1; });
    }));
    return { connectors: groups.length, entities, fields, mapped };
  }, [groups]);

  /* Search filters the tree rather than opening a separate result list: a
     connector survives if it matches, or if any of its entities does — and a
     matching connector keeps all of its entities so you still see what it holds. */
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => {
        const gHit = String(g.connectorName || '').toLowerCase().includes(q);
        const entities = gHit ? g.entities : g.entities.filter((e) => String(e.name || e.key).toLowerCase().includes(q));
        return entities.length || gHit ? { ...g, entities } : null;
      })
      .filter(Boolean);
  }, [groups, query]);

  const toggle = (id) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  /* While searching, every surviving group is forced open — otherwise the tree
     would filter down to the matching entities and then hide them behind a
     collapsed parent, which looks like search returning nothing. */
  const searching = query.trim().length > 0;
  const isOpen = (id) => searching || !!expanded[id];

  useToolbarAction({
    catalog_export: () => {
      const rows = [];
      groups.forEach((g) => g.entities.forEach((e) => (e.fields || []).forEach((f) =>
        rows.push([g.connectorName || g.connectorId, e.name, f.name, f.type, f.usageCount ?? 0]))));
      if (rows.length === 0) return;
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [['connector', 'entity', 'field', 'type', 'usageCount'].join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = 'entity-catalog.csv'; a.click(); URL.revokeObjectURL(url);
    },
  });

  const isSelected = (g, e) => selected?.entity?.key === e.key && selected?.group?.connectorId === g.connectorId;

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Entity Catalog</h1>
          <div className="page-subtitle">
            {loading ? 'Loading the data model…'
              : `Canonical data model across ${totals.connectors} connector${totals.connectors === 1 ? '' : 's'}`}
          </div>
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => navigate('/studio')}>
          <Icon name="external" />Manage in Studio
        </button>
      </div>

      <div className="page-body fit">
        <StatStrip
          items={[
            { key: 'c', label: 'Connectors', value: totals.connectors, tone: 'info', sub: 'Contributing entities' },
            { key: 'e', label: 'Entities', value: totals.entities, tone: 'info', sub: 'Across all connectors' },
            { key: 'f', label: 'Fields', value: totals.fields, tone: 'info', sub: 'With a static schema' },
            { key: 'm', label: 'Mapped', value: totals.mapped, tone: totals.mapped ? 'ok' : 'idle', sub: 'Used by an integration' },
          ]}
        />

        <div className="catalog-split fit-col">
          {/* ── Tree (connector → entities) — scrolls internally when tall ── */}
          <div className="panel catalog-tree">
            <div className="search-bar catalog-search">
              <span className="search-icon"><Icon name="search" size={15} /></span>
              <input
                type="text"
                aria-label="Search connectors and entities"
                placeholder="Search entities…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="catalog-tree-body">
              {loading && <SkeletonLines lines={6} />}
              {!loading && groups.length === 0 && <div className="tree-note">No connectors yet.</div>}
              {!loading && groups.length > 0 && shown.length === 0 && (
                <div className="tree-note">Nothing matches “{query}”.</div>
              )}
              {shown.map((g) => (
                <div key={g.connectorId} className="tree-group">
                  <button
                    type="button"
                    className="tree-node"
                    aria-expanded={isOpen(g.connectorId)}
                    onClick={() => toggle(g.connectorId)}
                  >
                    <span className={`tree-caret${isOpen(g.connectorId) ? ' is-open' : ''}`} aria-hidden="true">▶</span>
                    <ConnectorIcon icon={g.icon} size={16} />
                    <span className="tree-label">{g.connectorName}</span>
                    <span className="badge badge-neutral">{g.entities.length}</span>
                  </button>
                  {isOpen(g.connectorId) && g.entities.map((e) => (
                    <button
                      key={e.key}
                      type="button"
                      className={`tree-leaf${isSelected(g, e) ? ' is-selected' : ''}`}
                      aria-pressed={isSelected(g, e)}
                      onClick={(ev) => { setDetailFrom(originRect(ev)); setSelected({ group: g, entity: e }); }}
                    >
                      <span className="tree-label">{e.name}</span>
                      {/* "(0)" on every row read as broken. A connector with no
                          static schema discovers its fields at mapping time —
                          that is a different fact, so it gets a different word. */}
                      <span className="tree-count">{e.fieldCount ? e.fieldCount : 'live'}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {/* ── Detail — scrolls independently of the tree ── */}
          <div className="catalog-detail" ref={detailRef}>
            {!selected && !loading && (
              <div className="ucard ucard--empty">
                <div className="ucard-empty-title">No entity selected</div>
                Pick an entity on the left to inspect its fields and see where they are used.
              </div>
            )}
            {selected && (
              <>
                <div className="ucard">
                  <div className="ucard-top">
                    <span className="ucard-eyebrow">
                      <ConnectorIcon icon={selected.group.icon} size={13} />
                      {selected.group.connectorName}
                    </span>
                    <span className="ucard-badge">{selected.group.isSystem ? 'built-in' : 'custom'}</span>
                  </div>
                  <div className="entity-title">{selected.entity.name}</div>
                  {selected.entity.description && <div className="entity-desc">{selected.entity.description}</div>}

                  {selected.entity.fields.length === 0 ? (
                    <div className="entity-live">
                      <div className="entity-live-title">Fields are discovered live</div>
                      This connector has no static schema — its fields are read from the live
                      system when you build a mapping.
                      <div>
                        <button type="button" className="btn btn-outline btn-sm" onClick={() => navigate('/wizard')}>
                          Discover in the Wizard
                        </button>
                      </div>
                    </div>
                  ) : (
                    <table className="data-table">
                      <thead><tr><th scope="col">Field</th><th scope="col">Label</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Usage</th></tr></thead>
                      <tbody>
                        {selected.entity.fields.map((f, i) => (
                          <tr key={f.name} style={{ '--i': Math.min(i, 14) }}>
                            <td className="cell-field">{f.name}</td>
                            <td>{titleCase(f.name)}</td>
                            <td><span className={`badge ${TYPE_BADGE[f.type] || 'badge-neutral'}`}>{f.type}</span></td>
                            <td>{f.required ? <span className="req-mark" title="Required">✔</span> : ''}</td>
                            <td>
                              <span className="usage" title={`Referenced by ${f.usageCount} mapping${f.usageCount === 1 ? '' : 's'}`}>
                                <span className="usage-track">
                                  <span className="usage-fill" style={{ width: `${Math.round((f.usageCount / maxUsage) * 100)}%` }} />
                                </span>
                                <span className="usage-num">{f.usageCount}</span>
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Cross-reference */}
                <div className="ucard">
                  <div className="ucard-eyebrow">Cross-references</div>
                  <div className="xref-grid">
                    <div>
                      <div className="xref-label">Defined by connector</div>
                      <button type="button" className="link-btn xref-link" onClick={() => navigate('/studio')}>
                        <ConnectorIcon icon={selected.group.icon} size={15} /> {selected.group.connectorName}
                      </button>
                    </div>
                    <div>
                      <div className="xref-label">Integrations</div>
                      {selected.group.usedByAdapters ? (
                        <button type="button" className="link-btn xref-link" onClick={() => navigate('/connected')}>
                          {selected.group.usedByAdapters === 1
                            ? '1 integration uses this connector'
                            : `${selected.group.usedByAdapters} integrations use this connector`}
                        </button>
                      ) : (
                        <span className="xref-none">Not used by any integration yet</span>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
