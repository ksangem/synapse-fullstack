import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDetailPane } from '../../hooks/useDetailPane';
import { api } from '../../services/api';
import { mapToCard, statusLabel } from '../../services/integrationMap';

export default function RegistryPage() {
  const navigate = useNavigate();
  const { openDetailPane } = useDetailPane();
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilters, setActiveFilters] = useState(['All']);

  // ── Real data (T-07): load integrations from the backend ──
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [usingSample, setUsingSample] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const res = await api.getConnected();
      if (!alive) return;
      const rows = (res.ok && Array.isArray(res.data?.data)) ? res.data.data : [];
      setCards(rows.map(mapToCard));
      setUsingSample(false);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, []);

  const filterOptions = ['All', 'Jira', 'SharePoint', 'PostgreSQL', 'SQL Server', 'Active', 'Error'];

  const handleFilterClick = (filter) => {
    if (filter === 'All') {
      setActiveFilters(['All']);
    } else {
      setActiveFilters((prev) => {
        const without = prev.filter((f) => f !== 'All');
        if (without.includes(filter)) {
          const next = without.filter((f) => f !== filter);
          return next.length === 0 ? ['All'] : next;
        }
        return [...without, filter];
      });
    }
  };

  const filteredIntegrations = cards.filter((int) => {
    if (searchTerm && !int.name.toLowerCase().includes(searchTerm.toLowerCase())) {
      return false;
    }
    if (activeFilters.includes('All')) return true;
    let match = false;
    for (const f of activeFilters) {
      if (f === 'Active' && int.status === 'green') match = true;
      else if (f === 'Error' && int.status === 'red') match = true;
      else if (int.src === f || int.dest === f) match = true;
    }
    return match;
  });

  const handleShowLogs = (int) => {
    const pushes = int.recentPushes || [];
    openDetailPane(
      int.name + ' - Logs',
      <div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
          Showing recent push log entries for <strong>{int.name}</strong>
        </div>
        <div className="json-block" style={{ maxHeight: 400, fontSize: '.72rem' }}>
          {pushes.length ? pushes.map((p, i) => (
            <div key={i}>
              [{p.pushedAt ? new Date(p.pushedAt).toLocaleString() : '—'}] {p.status}{' '}
              {p.recordCount ?? 0} records{p.projectKey ? ` · ${p.projectKey}` : ''}
              {p.errorMessage ? ` — ${p.errorMessage}` : ''}
            </div>
          )) : 'No push history yet for this integration.'}
        </div>
      </div>,
      <>
        <a className="clickable" onClick={() => navigate('/registry')}>Registry</a> &raquo; {int.name} &raquo; Logs
      </>
    );
  };

  const handleCardClick = (int) => {
    const statusClass = int.status === 'red' ? 'error' : int.status === 'amber' ? 'warning' : 'success';
    const fm = int.fieldMappings || {};
    const pushes = int.recentPushes || [];
    const mappingRows = Object.entries(fm)
      .filter(([k]) => !['credId', 'destCredId', 'authMethod'].includes(k))
      .slice(0, 8);

    openDetailPane(
      int.name,
      <div>
        <div className="grid-2 mb-16">
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Status</div>
            <span className={`badge badge-${statusClass}`}>{statusLabel(int.status)}</span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Schedule</div>
            <span style={{ fontSize: '.85rem' }}>{int.schedule || 'Manual / on-demand'}</span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Route</div>
            <span style={{ fontSize: '.85rem' }}>{int.route}</span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Created</div>
            <span style={{ fontSize: '.85rem' }}>
              {int.createdAt ? new Date(int.createdAt).toLocaleDateString() : '—'}
            </span>
          </div>
        </div>

        <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Configuration</div>
        <table className="mb-16">
          <thead><tr><th>Field</th><th>Value</th></tr></thead>
          <tbody>
            {mappingRows.length ? mappingRows.map(([k, v]) => (
              <tr key={k}>
                <td className="clickable">{k}</td>
                <td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
              </tr>
            )) : (
              <tr><td colSpan={2}>No field mapping configured.</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Recent Runs</div>
        <table>
          <thead>
            <tr><th>Timestamp</th><th>Records</th><th>Type</th><th>Status</th></tr>
          </thead>
          <tbody>
            {pushes.length ? pushes.map((p, i) => {
              const sc = p.status === 'FAILED' ? 'error' : p.status === 'PARTIAL' ? 'warning' : 'success';
              return (
                <tr key={i}>
                  <td>{p.pushedAt ? new Date(p.pushedAt).toLocaleString() : '—'}</td>
                  <td>{p.recordCount ?? 0}</td>
                  <td>{p.pushType || '—'}</td>
                  <td><span className={`badge badge-${sc}`}>{p.status}</span></td>
                </tr>
              );
            }) : (
              <tr><td colSpan={4}>No runs recorded yet.</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => handleShowLogs(int)}>&#128196; View Logs</button>
        </div>
      </div>,
      <>
        <a className="clickable" onClick={() => navigate('/registry')}>Integration Registry</a> &raquo; {int.name}
      </>
    );
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Integration Registry</div>
          <div className="page-subtitle">
            All deployed adapters and integrations
            {usingSample && <span className="badge badge-warning" style={{ marginLeft: 8 }}>Sample data</span>}
            {!usingSample && !loading && <span className="badge badge-success" style={{ marginLeft: 8 }}>Live</span>}
          </div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate('/wizard')}>+ New Integration</button>
      </div>

      <div className="page-body">
      <div className="flex gap-12 mb-16" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="search-bar">
          <span className="search-icon">&#128269;</span>
          <input
            type="text"
            placeholder="Search integrations..."
            style={{ width: 300 }}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="filter-chips">
          {filterOptions.map((f) => (
            <span
              key={f}
              className={`chip${activeFilters.includes(f) ? ' active' : ''}`}
              onClick={() => handleFilterClick(f)}
            >
              {f}
            </span>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>Loading integrations…</div>
      ) : filteredIntegrations.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
          No integrations match your filters. <a className="clickable" onClick={() => navigate('/wizard')}>Create one →</a>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {filteredIntegrations.map((int, idx) => {
            const statusClass = int.status === 'red' ? 'error' : int.status === 'amber' ? 'warning' : 'success';
            const maxSpark = Math.max(...int.sparkData, 1);

            return (
              <div key={int.id || idx} className="card integration-card" onClick={() => handleCardClick(int)}>
                <div className="int-header">
                  <span
                    className={`status-dot ${int.status}`}
                    onClick={(e) => { e.stopPropagation(); handleCardClick(int); }}
                  ></span>
                  <span className="int-name">{int.name}</span>
                </div>
                <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginBottom: 6 }}>{int.route}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className={`badge badge-${statusClass}`}>{statusLabel(int.status)}</span>
                  <span style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>{int.dept}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 10 }}>
                  <div className="sparkline" onClick={(e) => e.stopPropagation()}>
                    {int.sparkData.map((v, i) => (
                      <div
                        key={i}
                        className="bar"
                        style={{ height: `${(v / maxSpark) * 100}%` }}
                      ></div>
                    ))}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '.85rem', fontWeight: 600 }}>{int.msgsLabel ?? int.msgs}</div>
                    <div style={{ fontSize: '.68rem', color: 'var(--text-dim)' }}>records</div>
                  </div>
                </div>
                <div className="int-meta">
                  <span>Last: {int.lastRun}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}
