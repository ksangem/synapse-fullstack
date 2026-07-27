import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { useToolbarAction } from '../../hooks/useToolbarAction';
import { api } from '../../services/api';
import { mapToCard, statusLabel } from '../../services/integrationMap';
import IntegrationCard from './IntegrationCard';
import { CardSkeleton, CardEmpty } from '../ui/Card';
import Button from '../ui/Button';

export default function RegistryPage() {
  const navigate = useNavigate();
  const { openDetailPane } = useDetailPane();
  const { showToast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilters, setActiveFilters] = useState(['All']);

  // ── Real data (T-07): load integrations from the backend ──
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState(null);
  // Card selection → bulk pause/resume. The Registry previously offered no way to
  // act on more than one integration at a time even though the API supports it.
  const [selected, setSelected] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(null);

  const load = useCallback(async () => {
    const res = await api.getConnected();
    if (!res.ok) showToast(res.data?.error || 'Could not load integrations', 'error');
    const rows = (res.ok && Array.isArray(res.data?.data)) ? res.data.data : [];
    setCards(rows.map(mapToCard));
    return rows.length;
  }, [showToast]);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await load();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [load]);

  // Run an integration straight from its card, then refresh so the card's health,
  // last-run stamp and 7-day volume reflect the run that just happened.
  const handleRun = async (int) => {
    if (runningId) return;
    setRunningId(int.id);
    try {
      const res = await api.runIntegration(int.id);
      if (res.ok && res.data?.success !== false) {
        showToast(`Started “${int.name}”`, 'success');
        setTimeout(() => { load(); }, 1500);
      } else {
        showToast(res.data?.error || `Could not start “${int.name}”`, 'error');
      }
    } finally {
      setRunningId(null);
    }
  };

  useToolbarAction({
    reg_export: () => {
      if (cards.length === 0) { showToast('Nothing to export', 'warning'); return; }
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const row = (c) => [c.name, c.status, c.source?.name ?? c.source ?? '', c.target?.name ?? c.dest?.name ?? c.target ?? ''];
      const csv = [['name', 'status', 'source', 'destination'].join(','), ...cards.map((c) => row(c).map(esc).join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = 'integrations.csv'; a.click(); URL.revokeObjectURL(url);
      showToast(`Exported ${cards.length} integration(s)`, 'success');
    },
  });

  const bulk = async (action) => {
    const ids = [...selected];
    if (!ids.length) return;
    setBulkBusy(action);
    const res = await api.bulkConnected(action, ids);
    if (res.ok && res.data?.success) {
      showToast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${res.data.data?.updated ?? ids.length} integration(s)`, 'success');
      setSelected(new Set());
      await load();
    } else {
      showToast(res.data?.error || (res.status === 403 ? 'Bulk actions require admin' : 'Bulk action failed'), 'error');
    }
    setBulkBusy(null);
  };

  const toggleSelect = (id, on) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

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
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginBottom: 12 }}>
          Showing recent push log entries for <strong>{int.name}</strong>
        </div>
        <div className="json-block" style={{ maxHeight: 400, fontSize: 'var(--fs-xs)' }}>
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
        <button type="button" className="link-btn" onClick={() => navigate('/registry')}>Registry</button> &raquo; {int.name} &raquo; Logs
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
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Status</div>
            <span className={`badge badge-${statusClass}`}>{statusLabel(int.status)}</span>
          </div>
          <div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Schedule</div>
            <span style={{ fontSize: 'var(--fs-base)' }}>{int.schedule || 'Manual / on-demand'}</span>
          </div>
          <div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Route</div>
            <span style={{ fontSize: 'var(--fs-base)' }}>{int.route}</span>
          </div>
          <div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Created</div>
            <span style={{ fontSize: 'var(--fs-base)' }}>
              {int.createdAt ? new Date(int.createdAt).toLocaleDateString() : '—'}
            </span>
          </div>
        </div>

        <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', marginBottom: 8 }}>Configuration</div>
        <table className="mb-16">
          <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
          <tbody>
            {mappingRows.length ? mappingRows.map(([k, v]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
              </tr>
            )) : (
              <tr><td colSpan={2}>No field mapping configured.</td></tr>
            )}
          </tbody>
        </table>

        <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', marginBottom: 8 }}>Recent Runs</div>
        <table>
          <thead>
            <tr><th scope="col">Timestamp</th><th scope="col">Records</th><th scope="col">Type</th><th scope="col">Status</th></tr>
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
        <button type="button" className="link-btn" onClick={() => navigate('/registry')}>Integration Registry</button> &raquo; {int.name}
      </>
    );
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Integration Registry</h1>
          <div className="page-subtitle">
            All deployed integrations
            {!loading && <span className="badge badge-success" style={{ marginLeft: 8 }}>Live</span>}
          </div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate('/wizard')}>+ New Integration</button>
      </div>

      <div className="page-body fit">
      <div className="flex gap-12 mb-16" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="search-bar">
          <span className="search-icon">&#128269;</span>
          <input
            type="text"
            aria-label="Search integrations" placeholder="Search integrations..."
            style={{ width: 300 }}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="filter-chips">
          {filterOptions.map((f) => (
            <button
              key={f}
              type="button"
              className={`chip${activeFilters.includes(f) ? ' active' : ''}`}
              aria-pressed={activeFilters.includes(f)}
              onClick={() => handleFilterClick(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Selection bar — appears only once something is selected, so the resting
          page is unchanged. */}
      {selected.size > 0 && (
        <div className="bulk-bar" role="region" aria-label="Bulk actions">
          <strong>{selected.size}</strong> selected
          <button type="button" className="link-btn" onClick={() => setSelected(new Set(filteredIntegrations.map((i) => i.id)))}>
            Select all {filteredIntegrations.length}
          </button>
          <button type="button" className="link-btn" onClick={() => setSelected(new Set())}>Clear</button>
          <span style={{ flex: 1 }} />
          <Button className="btn btn-outline btn-sm" loading={bulkBusy === 'pause'} loadingLabel="Pausing"
            disabled={!!bulkBusy} onClick={() => bulk('pause')}>Pause</Button>
          <Button className="btn btn-outline btn-sm" loading={bulkBusy === 'resume'} loadingLabel="Resuming"
            disabled={!!bulkBusy} onClick={() => bulk('resume')}>Resume</Button>
        </div>
      )}

      {loading ? (
        /* Card-shaped skeletons inside the real grid, so arriving content does not
           reflow the page — the previous generic block had a different shape. */
        <div className="fit-scroll ucard-grid"><CardSkeleton count={8} /></div>
      ) : filteredIntegrations.length === 0 ? (
        <div className="fit-scroll ucard-grid">
          <CardEmpty
            title={cards.length === 0 ? 'No integrations yet' : 'Nothing matches those filters'}
            action={cards.length === 0
              ? <button type="button" className="btn btn-primary btn-sm" onClick={() => navigate('/wizard')}>Create one →</button>
              : <button type="button" className="btn btn-outline btn-sm" onClick={() => { setSearchTerm(''); setActiveFilters(['All']); }}>Clear filters</button>}
          >
            {cards.length === 0
              ? 'Connect a source to a destination in the Connection Wizard to see it here.'
              : `${cards.length} integration${cards.length === 1 ? '' : 's'} exist, but none match the current search or filters.`}
          </CardEmpty>
        </div>
      ) : (
        <div className="fit-scroll ucard-grid">
          {filteredIntegrations.map((int, idx) => (
            <IntegrationCard
              key={int.id || idx}
              /* Stagger capped at 12 — past that the tail feels like lag, not choreography. */
              style={{ '--i': Math.min(idx, 12) }}
              int={int}
              running={runningId === int.id}
              selected={selected.has(int.id)}
              onSelect={(on) => toggleSelect(int.id, on)}
              onOpen={handleCardClick}
              onRun={handleRun}
              onLogs={handleShowLogs}
            />
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
