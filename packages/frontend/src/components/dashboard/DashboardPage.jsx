import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { useToolbarAction } from '../../hooks/useToolbarAction';
import { api } from '../../services/api';
import { mapToCard, computeKpis, statusLabel } from '../../services/integrationMap';
import { Skeleton, SkeletonCards } from '../layout/Skeleton';

function AdapterDetailContent({ tile }) {
  const pushes = tile.recentPushes || [];
  const color = tile.status;

  return (
    <>
      <div className="grid-2 mb-16">
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Source</div>
          <span style={{ fontSize: '.85rem' }}>{tile.src}</span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Destination</div>
          <span style={{ fontSize: '.85rem' }}>{tile.dest}</span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Status</div>
          <span className={`badge badge-${color === 'red' ? 'error' : color === 'amber' ? 'warning' : 'success'}`}>
            {statusLabel(color)}
          </span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Records (recent)</div>
          <span style={{ fontSize: '.85rem' }}>{(tile.msgs || 0).toLocaleString()}</span>
        </div>
      </div>

      <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Recent Runs</div>
      <table className="mb-16">
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

      {color === 'red' && pushes[0]?.errorMessage && (
        <>
          <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Last Error</div>
          <div className="json-block mb-16" style={{ fontSize: '.75rem', maxHeight: 120 }}>
            <span style={{ color: 'var(--error)' }}>{pushes[0].errorMessage}</span>
          </div>
        </>
      )}

      <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Config Summary</div>
      <div className="grid-2 mb-16">
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Schedule</div>
          <span style={{ fontSize: '.85rem' }}>{tile.schedule || 'Manual / on-demand'}</span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Project / List</div>
          <span style={{ fontSize: '.85rem' }}>{tile.dept}</span>
        </div>
      </div>
    </>
  );
}

// Lightweight bar chart from a numeric series (real push data).
function MiniBars({ series, color = '#6366f1', empty }) {
  if (!series.length || series.every((v) => v === 0)) {
    return <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-dim)', fontSize: '.78rem' }}>{empty}</div>;
  }
  const max = Math.max(...series, 1);
  const w = 500 / series.length;
  return (
    <svg width="100%" height="120" viewBox="0 0 500 120" preserveAspectRatio="none">
      {series.map((v, i) => {
        const h = (v / max) * 100;
        return <rect key={i} x={i * w + 2} y={120 - h} width={w - 4} height={h} rx="2" fill={color} opacity="0.7" />;
      })}
    </svg>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { openDetailPane } = useDetailPane();
  const { showToast } = useToast();
  const [activeFilter, setActiveFilter] = useState('All');
  const [timeRange, setTimeRange] = useState('Last 24 hours');

  // ── Real data (T-07) ──
  const [cards, setCards] = useState([]);
  const [kpis, setKpis] = useState(null);
  const [loading, setLoading] = useState(true);
  const [usingSample, setUsingSample] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const res = await api.getConnected();
      if (!alive) return;
      if (!res.ok) showToast(res.data?.error || 'Could not load dashboard data');
      const rows = (res.ok && Array.isArray(res.data?.data)) ? res.data.data : [];
      const mapped = rows.map(mapToCard);
      setCards(mapped);
      setKpis(computeKpis(mapped));
      setUsingSample(false);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [showToast]);

  // Toolbar actions — self-contained (fetch live ids, then act) so they don't depend
  // on the dashboard's display state.
  const bulkAll = async (action) => {
    const res = await api.getConnected();
    const ids = (res.ok && Array.isArray(res.data?.data)) ? res.data.data.map((i) => i.integrationId) : [];
    if (ids.length === 0) { showToast('No connections'); return; }
    const r = await api.bulkConnected(action, ids);
    if (r.ok && r.data?.success) showToast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${r.data.data?.updated ?? ids.length} connection(s)`);
    else showToast(r.data?.error || (r.status === 403 ? 'Bulk actions require admin' : 'Action failed'));
  };
  useToolbarAction({
    dash_pauseAll: () => bulkAll('pause'),
    dash_resumeAll: () => bulkAll('resume'),
    dash_export: () => {
      if (cards.length === 0) { showToast('Nothing to export'); return; }
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const csv = [['name', 'status'].join(','), ...cards.map((c) => [esc(c.name), esc(c.status)].join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a'); a.href = url; a.download = 'dashboard-report.csv'; a.click(); URL.revokeObjectURL(url);
    },
  });

  const filters = ['All', 'Active', 'Paused', 'Error'];

  const filteredTiles = cards.filter((tile) => {
    if (activeFilter === 'All') return true;
    if (activeFilter === 'Active') return tile.status === 'green';
    if (activeFilter === 'Paused') return tile.status === 'amber';
    if (activeFilter === 'Error') return tile.status === 'red';
    return true;
  });

  const handleTileClick = (tile) => {
    openDetailPane(
      tile.name,
      <AdapterDetailContent tile={tile} />,
      <>
        <a className="clickable" onClick={() => navigate('/dashboard')}>Dashboard</a> &raquo; {tile.name}
      </>
    );
  };

  // Real push series for the charts (newest pushes across all integrations).
  const allPushes = cards.flatMap((c) => c.recentPushes || []);
  const volumeSeries = allPushes
    .slice()
    .sort((a, b) => new Date(a.pushedAt || 0) - new Date(b.pushedAt || 0))
    .map((p) => Number(p.recordCount) || 0);
  const errorSeries = allPushes
    .slice()
    .sort((a, b) => new Date(a.pushedAt || 0) - new Date(b.pushedAt || 0))
    .map((p) => (p.status === 'FAILED' ? 1 : p.status === 'PARTIAL' ? 0.5 : 0));

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Health Dashboard</div>
          <div className="page-subtitle">
            Real-time platform overview
            {usingSample && <span className="badge badge-warning" style={{ marginLeft: 8 }}>Sample data</span>}
            {!usingSample && !loading && <span className="badge badge-success" style={{ marginLeft: 8 }}>Live</span>}
          </div>
        </div>
        <div className="flex gap-8">
          <select
            style={{ padding: '4px 8px', fontSize: '.8rem' }}
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
          >
            <option>Last 24 hours</option>
            <option>Last 7 days</option>
            <option>Last 30 days</option>
          </select>
        </div>
      </div>

      <div className="page-body">
      {/* KPI Row */}
      {loading ? (
        <div className="grid-4 mb-20">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card kpi-card">
              <Skeleton h={30} w={90} style={{ margin: '4px 0' }} />
              <Skeleton h={12} w={120} style={{ marginTop: 10 }} />
              <Skeleton h={10} w={150} style={{ marginTop: 10 }} />
            </div>
          ))}
        </div>
      ) : (
      <div className="grid-4 mb-20">
        <div className="card kpi-card">
          <div className="kpi-icon">&#9881;</div>
          <div className="kpi-value" onClick={() => navigate('/registry')}>{kpis ? kpis.total : '—'}</div>
          <div className="kpi-label">Total Adapters</div>
          <div className="kpi-sub">
            <span onClick={() => navigate('/registry')}><span className="status-dot green"></span> {kpis ? kpis.active : 0} active</span>
            <span onClick={() => navigate('/registry')}><span className="status-dot amber"></span> {kpis ? kpis.paused : 0} paused</span>
            <span onClick={() => navigate('/registry')}><span className="status-dot red"></span> {kpis ? kpis.errored : 0} error</span>
          </div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-icon">&#9993;</div>
          <div className="kpi-value" onClick={() => navigate('/monitor')}>{kpis ? kpis.recordsSynced.toLocaleString() : '—'}</div>
          <div className="kpi-label">Records Synced</div>
          <div className="kpi-sub">
            <span style={{ color: 'var(--success)' }}>&#9650; {kpis ? kpis.pushOk : 0} ok</span>
            <span style={{ color: 'var(--info)' }}>&#9660; {kpis ? kpis.pushPartial : 0} partial</span>
            <span style={{ color: 'var(--error)' }}>&#9888; {kpis ? kpis.pushFailed : 0} failed</span>
          </div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-icon">&#9201;</div>
          <div className="kpi-value">{kpis ? (kpis.successRate === null ? '—' : `${kpis.successRate}%`) : '—'}</div>
          <div className="kpi-label">Push Success Rate</div>
          <div className="kpi-sub">
            <span style={{ color: 'var(--success)' }}>{kpis ? `${kpis.pushOk + kpis.pushPartial}/${kpis.pushOk + kpis.pushPartial + kpis.pushFailed} pushes ok` : ''}</span>
          </div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-icon">&#9888;</div>
          <div className="kpi-value" style={{ color: 'var(--warning)' }} onClick={() => navigate('/alerts')}>{kpis ? kpis.alerts : 0}</div>
          <div className="kpi-label">Needs Attention</div>
          <div className="kpi-sub">
            <span onClick={() => navigate('/alerts')} style={{ color: 'var(--error)' }}>{kpis ? kpis.errored : 0} error</span>
            <span onClick={() => navigate('/alerts')} style={{ color: 'var(--warning)' }}>{kpis ? kpis.paused : 0} paused</span>
          </div>
        </div>
      </div>
      )}

      {/* Adapter Health Grid */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: '.95rem' }}>Adapter Health</div>
        <a className="clickable" style={{ fontSize: '.78rem' }} onClick={() => navigate('/registry')}>View All &#8594;</a>
      </div>

      <div className="filter-chips mb-12" style={{ marginBottom: 12 }}>
        {filters.map((f) => (
          <span
            key={f}
            className={`chip${activeFilter === f ? ' active' : ''}`}
            onClick={() => setActiveFilter(f)}
          >
            {f}
          </span>
        ))}
      </div>

      {loading ? (
        <SkeletonCards count={8} />
      ) : filteredTiles.length === 0 ? (
        <div className="card mb-20" style={{ padding: 40, textAlign: 'center', color: 'var(--text-dim)' }}>
          {cards.length === 0 ? 'No integrations yet — create one from the Connection Wizard.' : 'No adapters match this filter.'}
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 12,
            maxHeight: 'calc(100vh - 240px)',
            overflowY: 'auto',
          }}
          className="mb-20"
        >
          {filteredTiles.map((tile, idx) => (
            <div
              key={tile.id || idx}
              className={`card adapter-tile${tile.status === 'red' ? ' error' : ''}`}
              onClick={() => handleTileClick(tile)}
            >
              <div className="tile-header">
                <div className="tile-name">{tile.name}</div>
                <span className={`status-dot ${tile.status}`}></span>
              </div>
              <div className="tile-route">
                {tile.srcIcon} {tile.src} &rarr; {tile.destIcon} {tile.dest}
              </div>
              <div
                className="tile-meta"
                style={tile.metaError ? { color: tile.status === 'red' ? 'var(--error)' : 'var(--warning)' } : undefined}
              >
                {tile.meta}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Charts Row */}
      <div className="grid-2 mb-20">
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: 12 }}>Records per Push (recent)</div>
          <MiniBars series={usingSample ? [] : volumeSeries} color="#6366f1" empty="No run data yet — trigger a sync to populate." />
        </div>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: '.9rem' }}>Failures per Push (recent)</div>
            <a className="clickable" style={{ fontSize: '.75rem' }} onClick={() => navigate('/alerts')}>View All Alerts &#8594;</a>
          </div>
          <MiniBars series={usingSample ? [] : errorSeries} color="#ef4444" empty="No failures recorded." />
        </div>
      </div>
      </div>
    </div>
  );
}
