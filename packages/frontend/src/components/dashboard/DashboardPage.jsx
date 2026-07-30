import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { useHorizontalScroll } from '../../hooks/useHorizontalScroll';
import { useToolbarAction } from '../../hooks/useToolbarAction';
import { api } from '../../services/api';
import { mapToCard, computeKpis, statusLabel, nextRunFromCron, relativeTime } from '../../services/integrationMap';
import { Skeleton, SkeletonCards } from '../layout/Skeleton';
import { OutcomesChart, VolumeChart } from './ActivityCharts';
import NeedsAttentionPanel from './NeedsAttentionPanel';
import Card from '../ui/Card';
import EndpointRoute from '../ui/EndpointRoute';
import { useCountUp } from '../../hooks/useCountUp';
import { clickable } from '../../utils/clickable';

// Sampled to classify causes; the TRUE queue size comes from the API's `counts`.
const DLQ_SAMPLE = 500;

function IntegrationDetailContent({ tile }) {
  const pushes = tile.recentPushes || [];
  const color = tile.status;

  return (
    <>
      <div className="grid-2 mb-16">
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Source</div>
          <span style={{ fontSize: 'var(--fs-base)' }}>{tile.srcLabel}</span>
        </div>
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Destination</div>
          <span style={{ fontSize: 'var(--fs-base)' }}>{tile.destLabel}</span>
        </div>
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Status</div>
          <span className={`badge badge-${color === 'red' ? 'error' : color === 'amber' ? 'warning' : 'success'}`}>
            {statusLabel(color)}
          </span>
        </div>
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Records (recent)</div>
          <span style={{ fontSize: 'var(--fs-base)' }}>{(tile.msgs || 0).toLocaleString()}</span>
        </div>
      </div>

      <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', marginBottom: 8 }}>Recent Runs</div>
      {/* Same treatment as the Registry pane: a one-line date-time stamp was the
          widest cell and pushed Status off the edge of the 420px pane. */}
      <div className="dp-table-wrap mb-16">
        <table className="dp-table">
          <thead>
            <tr><th scope="col">Timestamp</th><th scope="col">Records</th><th scope="col">Type</th><th scope="col">Status</th></tr>
          </thead>
          <tbody>
            {pushes.length ? pushes.map((p, i) => {
              const sc = p.status === 'FAILED' ? 'error' : p.status === 'PARTIAL' ? 'warning' : 'success';
              const at = p.pushedAt ? new Date(p.pushedAt) : null;
              return (
                <tr key={i}>
                  <td>
                    {at ? (
                      <div className="dp-stamp">
                        <span>{at.toLocaleDateString()}</span>
                        <span className="dp-stamp-time">{at.toLocaleTimeString()}</span>
                      </div>
                    ) : '—'}
                  </td>
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
      </div>

      {color === 'red' && pushes[0]?.errorMessage && (
        <>
          <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', marginBottom: 8 }}>Last Error</div>
          <div className="json-block mb-16" style={{ fontSize: 'var(--fs-xs)', maxHeight: 120 }}>
            <span style={{ color: 'var(--error-on)' }}>{pushes[0].errorMessage}</span>
          </div>
        </>
      )}

      <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)', marginBottom: 8 }}>Config Summary</div>
      <div className="grid-2 mb-16">
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Schedule</div>
          <span style={{ fontSize: 'var(--fs-base)' }}>{tile.schedule || 'Manual / on-demand'}</span>
          {(() => {
            const nr = tile.schedule ? nextRunFromCron(tile.schedule) : null;
            return nr ? <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>Next run: {new Date(nr).toLocaleString()}</div> : null;
          })()}
        </div>
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Project / List</div>
          <span style={{ fontSize: 'var(--fs-base)' }}>{tile.dept}</span>
        </div>
      </div>
    </>
  );
}




/* Dashboard leads with these figures, so they count up once on arrival. Deliberately
   NOT used for anything that refreshes often — a ticker on a fast-changing number
   reads as instability rather than as the value landing. */
function KpiNumber({ value }) {
  const n = useCountUp(Number(value) || 0);
  return <>{n.toLocaleString()}</>;
}

/* Dashboard health tile — the compact form of the shared card.

   It previously showed a status dot fed by `integration.status`, which is 'active'
   for every integration, plus a pre-baked `meta` string. So a healthy integration
   and one whose last run failed looked identical, and the Dashboard disagreed with
   the Registry about the same record. Both now read `health` from the real last-run
   outcome and show the same 7-day figure. */
function HealthTile({ tile, onOpen, style }) {
  const h = tile.health === 'failing'
    ? { status: 'fail', label: 'Failing' }
    : tile.health === 'never'
      ? { status: 'idle', label: 'Never run' }
      : { status: 'ok', label: 'Healthy' };
  return (
    <Card
      interactive
      style={style}
      className="ucard--compact"
      status={h.status}
      eyebrow={h.label}
      title={tile.name}
      onOpen={() => onOpen(tile)}
      ariaLabel={`${tile.name}, ${h.label}, ${tile.route}`}
      sub={
        <>
          <EndpointRoute tile={tile} />
        </>
      }
      foot={
        <>
          <span className={`int-when int-when--${tile.lastRunAt ? 'recent' : 'none'}`}>
            {tile.lastRunAt ? relativeTime(tile.lastRunAt) : 'never run'}
          </span>
          <span className="int-meta">
            <span>{(tile.records7d ?? 0).toLocaleString()} rec · 7d</span>
          </span>
        </>
      }
    />
  );
}

// Dashboard time-range dropdown → hours passed to the backend for filtering runs.
const WINDOW_HOURS = { 'Last 24 hours': 24, 'Last 7 days': 168, 'Last 30 days': 720 };

export default function DashboardPage() {
  const navigate = useNavigate();
  const { openDetailPane } = useDetailPane();
  const { showToast } = useToast();
  const [activeFilter, setActiveFilter] = useState('All');
  const [timeRange, setTimeRange] = useState('Last 24 hours');

  // Adapter Health row: arrows page it, and a plain wheel over it scrolls it sideways
  // (shared with the Studio drafts shelf, so both rows answer the same gestures).
  const adapterRowRef = useRef(null);
  const { scrollByPage: scrollAdapters } = useHorizontalScroll(adapterRowRef);

  // ── Real data (T-07) ──
  const [cards, setCards] = useState([]);
  const [kpis, setKpis] = useState(null);
  const [loading, setLoading] = useState(true);
  // Dead-letter queue — drives the "Needs attention" panel and its KPI tile.
  const [dlq, setDlq] = useState({ entries: [], total: 0, loading: true, error: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await api.getDeadLetters(DLQ_SAMPLE);
      if (!alive) return;
      if (res.ok && res.data?.success) {
        setDlq({
          entries: res.data.data || [],
          total: res.data.counts?.unresolved ?? (res.data.data || []).filter((e) => e.status !== 'done').length,
          loading: false,
          error: null,
        });
      } else {
        setDlq({ entries: [], total: 0, loading: false, error: 'Could not read the dead-letter queue.' });
      }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const res = await api.getConnected(`?windowHours=${WINDOW_HOURS[timeRange] || 24}`);
      if (!alive) return;
      if (!res.ok) showToast(res.data?.error || 'Could not load dashboard data', 'error');
      const rows = (res.ok && Array.isArray(res.data?.data)) ? res.data.data : [];
      const mapped = rows.map(mapToCard);
      setCards(mapped);
      setKpis(computeKpis(mapped));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [showToast, timeRange]);

  // Toolbar actions — self-contained (fetch live ids, then act) so they don't depend
  // on the dashboard's display state.
  const bulkAll = async (action) => {
    const res = await api.getConnected();
    const ids = (res.ok && Array.isArray(res.data?.data)) ? res.data.data.map((i) => i.integrationId) : [];
    if (ids.length === 0) { showToast('No connections', 'warning'); return; }
    const r = await api.bulkConnected(action, ids);
    if (r.ok && r.data?.success) showToast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${r.data.data?.updated ?? ids.length} connection(s)`, 'success');
    else showToast(r.data?.error || (r.status === 403 ? 'Bulk actions require admin' : 'Action failed'), 'error');
  };
  useToolbarAction({
    dash_pauseAll: () => bulkAll('pause'),
    dash_resumeAll: () => bulkAll('resume'),
    dash_export: () => {
      if (cards.length === 0) { showToast('Nothing to export', 'warning'); return; }
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
      <IntegrationDetailContent tile={tile} />,
      <>
        <button type="button" className="link-btn" onClick={() => navigate('/dashboard')}>Dashboard</button> &raquo; {tile.name}
      </>
    );
  };

  // Every push across all integrations — the charts bucket these by time themselves.
  const allPushes = cards.flatMap((c) => c.recentPushes || []);
  const windowHours = WINDOW_HOURS[timeRange] || 24;
  // Stuck messages + integrations in an error state. Paused is excluded — see the KPI tile.
  const needsAttention = (dlq.total || 0) + (kpis?.errored || 0);

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Health Dashboard</h1>
          <div className="page-subtitle">
            Real-time platform overview
            {!loading && <span className="badge badge-success" style={{ marginLeft: 8 }}>Live</span>}
          </div>
        </div>
        <div className="flex gap-8">
          <select
            aria-label="Dashboard time range"
            style={{ padding: '4px 8px', fontSize: 'var(--fs-sm)' }}
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
          >
            <option>Last 24 hours</option>
            <option>Last 7 days</option>
            <option>Last 30 days</option>
          </select>
        </div>
      </div>

      <div className="page-body fit">
      {/* KPI Row */}
      {loading ? (
        <div className="grid-4 mb-16">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="card kpi-card">
              <Skeleton h={30} w={90} style={{ margin: '4px 0' }} />
              <Skeleton h={12} w={120} style={{ marginTop: 10 }} />
              <Skeleton h={10} w={150} style={{ marginTop: 10 }} />
            </div>
          ))}
        </div>
      ) : (
      <div className="grid-4 mb-16">
        <div className="card kpi-card">
          <div className="kpi-icon">&#9881;</div>
          <div className="kpi-value" {...clickable(() => navigate('/registry'), { label: 'View all integrations' })}>{kpis ? <KpiNumber value={kpis.total} /> : '—'}</div>
          <div className="kpi-label">Total Integrations</div>
          <div className="kpi-sub">
            <span {...clickable(() => navigate('/registry'))}><span className="status-dot green"></span> {kpis ? kpis.active : 0} active</span>
            <span {...clickable(() => navigate('/registry'))}><span className="status-dot amber"></span> {kpis ? kpis.paused : 0} paused</span>
            <span {...clickable(() => navigate('/registry'))}><span className="status-dot red"></span> {kpis ? kpis.errored : 0} error</span>
          </div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-icon">&#9993;</div>
          <div className="kpi-value" {...clickable(() => navigate('/monitor'), { label: 'View records in the Message Monitor' })}>{kpis ? <KpiNumber value={kpis.recordsSynced} /> : '—'}</div>
          <div className="kpi-label">Records Synced</div>
          <div className="kpi-sub">
            <span style={{ color: 'var(--success-on)' }}>&#9650; {kpis ? kpis.pushOk : 0} ok</span>
            <span style={{ color: 'var(--info-on)' }}>&#9660; {kpis ? kpis.pushPartial : 0} partial</span>
            <span style={{ color: 'var(--error-on)' }}>&#9888; {kpis ? kpis.pushFailed : 0} failed</span>
          </div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-icon">&#9201;</div>
          <div className="kpi-value">{kpis ? (kpis.successRate === null ? '—' : `${kpis.successRate}%`) : '—'}</div>
          <div className="kpi-label">Push Success Rate</div>
          <div className="kpi-sub">
            <span style={{ color: 'var(--success-on)' }}>{kpis ? `${kpis.pushOk + kpis.pushPartial}/${kpis.pushOk + kpis.pushPartial + kpis.pushFailed} pushes ok` : ''}</span>
          </div>
        </div>
        {/* Counts stuck messages + errored integrations. It previously counted
            errored + PAUSED integrations, so it read 0 while thousands of messages
            sat undelivered in the dead-letter queue — directly contradicting the
            critical banner. Pausing is a deliberate operator choice, not a fault,
            so it is reported on the Total Integrations tile instead. */}
        <div className="card kpi-card">
          <div className="kpi-icon">&#9888;</div>
          <div
            className="kpi-value"
            style={{ color: needsAttention > 0 ? 'var(--warning-on)' : undefined }}
            {...clickable(() => navigate(dlq.total > 0 ? '/monitor' : '/alerts'), { label: 'View items needing attention' })}
          >
            {dlq.loading && !kpis ? '—' : <KpiNumber value={needsAttention} />}
          </div>
          <div className="kpi-label">Needs Attention</div>
          <div className="kpi-sub">
            <span {...clickable(() => navigate('/monitor'))}>{dlq.loading ? '…' : `${dlq.total.toLocaleString()} stuck`}</span>
            <span {...clickable(() => navigate('/alerts'))}>{kpis ? kpis.errored : 0} error</span>
          </div>
        </div>
      </div>
      )}

      {/* Integration Health Grid */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-md)' }}>Integration Health</div>
        <button type="button" className="link-btn" style={{ fontSize: 'var(--fs-sm)' }} onClick={() => navigate('/registry')}>View All &#8594;</button>
      </div>

      <div className="filter-chips mb-12" style={{ marginBottom: 12 }}>
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            className={`chip${activeFilter === f ? ' active' : ''}`}
            aria-pressed={activeFilter === f}
            onClick={() => setActiveFilter(f)}
          >
            {f}
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonCards count={8} />
      ) : filteredTiles.length === 0 ? (
        <div className="card empty-state mb-20">
          {cards.length === 0 ? 'No integrations yet — create one from the Connection Wizard.' : 'No integrations match this filter.'}
        </div>
      ) : (
        <div className="adapter-health-wrap mb-20">
          <button
            type="button"
            className="ah-scroll-btn ah-left"
            onClick={() => scrollAdapters(-1)}
            aria-label="Scroll left"
          >
            &#8249;
          </button>
          <div className="adapter-health-row" ref={adapterRowRef}>
          {filteredTiles.map((tile, idx) => (
            <HealthTile key={tile.id || idx} tile={tile} onOpen={handleTileClick} style={{ '--i': Math.min(idx, 12) }} />
          ))}
          </div>
          <button
            type="button"
            className="ah-scroll-btn ah-right"
            onClick={() => scrollAdapters(1)}
            aria-label="Scroll right"
          >
            &#8250;
          </button>
        </div>
      )}

      {/* Charts Row — both charts share one time axis over the selected range */}
      {/* The row is bounded at BOTH ends. Without a max it took every spare pixel on a
          tall/fullscreen display and stretched the bars into thin ribbons; without a
          sensible min it forced the page to scroll on short screens. A bar chart gains
          nothing past ~420px of height, so it stops there and the page stays still. */}
      <div className="dash-charts" style={{ display: 'flex', gap: 16, flex: '1 1 auto', minHeight: 240, maxHeight: 420 }}>
        <OutcomesChart pushes={allPushes} windowHours={windowHours} />
        <VolumeChart pushes={allPushes} windowHours={windowHours} />
        <NeedsAttentionPanel
          entries={dlq.entries}
          total={dlq.total}
          sampled={dlq.entries.length >= DLQ_SAMPLE}
          cards={cards}
          loading={dlq.loading}
          error={dlq.error}
        />
      </div>
      </div>
    </div>
  );
}
