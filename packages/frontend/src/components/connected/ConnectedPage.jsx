import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '../ui/Button';
import Card, { CardEmpty, CardSkeleton } from '../ui/Card';
import Icon from '../ui/Icon';
import StatStrip from '../ui/StatStrip';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { usePolling } from '../../hooks/usePolling';
import { api } from '../../services/api';
import { systemIcon } from '../../services/integrationMap';
import {
  overlayStyle, modalStyle, labelStyle, inputStyle, selectStyle, statusBadgeClass, fmtDate,
} from './styles';

/* My Connections — running integration instances. Adopts the shared design system:
   StatStrip summary/filter, the Card primitive for each connection, shared filter
   classes, and Icon buttons. Real data from /api/connected; no mock rows. */

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
const cronLabel = (cron) => {
  if (!cron) return 'No schedule';
  if (cron === '0 9 * * *') return 'Daily at 9 AM';
  if (cron === '0 9 * * 1-5') return 'Weekdays at 9 AM';
  if (cron === '0 9 * * 1') return 'Weekly (Mon 9 AM)';
  return cron;
};

const cronPresets = [
  { label: 'Daily at 9 AM', value: '0 9 * * *' },
  { label: 'Weekdays at 9 AM', value: '0 9 * * 1-5' },
  { label: 'Weekly (Mon 9 AM)', value: '0 9 * * 1' },
  { label: 'Custom', value: 'custom' },
];

const syncModes = [
  { value: 'RESYNC_SAME', label: 'Re-sync same date range', description: 'Re-push the same date range used in the last sync.' },
  { value: 'EXTEND_TO_TODAY', label: 'Extend to today', description: 'Extend the end date to today and sync all new issues.' },
  { value: 'CUSTOM', label: 'Custom date range', description: 'Choose a custom start and end date for this sync.' },
];

const STATUS_FILTERS = ['all', 'active', 'paused', 'error', 'draft'];

const ident = (side, fm, key) => side?.name || fm?.[key] || (key === 'sourceType' ? 'Source' : 'Destination');
const identIcon = (side, fm, key) => side?.icon || systemIcon(side?.name || fm?.[key]);

/** Lifecycle → the Card status rail tone (ok/warn/fail/idle). */
const toneFor = (lifecycle) => (
  lifecycle === 'error' ? 'fail' : lifecycle === 'active' ? 'ok' : 'idle'
);

/** Tiny dependency-free SVG bar sparkline for the 7-day volume. */
function Sparkline({ data = [], width = 84, height = 22 }) {
  const counts = data.map((d) => Number(d?.count) || 0);
  if (counts.length === 0) return <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>—</span>;
  const max = Math.max(1, ...counts);
  const bw = width / counts.length;
  return (
    <svg width={width} height={height} role="img" aria-label="7-day message volume" style={{ display: 'block' }}>
      {counts.map((c, i) => {
        const h = Math.max(1, Math.round((c / max) * (height - 2)));
        return <rect key={i} x={i * bw + 1} y={height - h} width={Math.max(1, bw - 2)} height={h} rx={1}
          fill={c > 0 ? 'var(--primary)' : 'var(--border)'} />;
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Per-card (handles live sync polling)                              */
/* ------------------------------------------------------------------ */
function IntegrationCard(props) {
  const {
    intg, onSyncUpdate, onSyncTerminal, onOpenSchedule, onRun, onPause, onResume,
    onClone, onDelete, onViewLogs, onEditMapping, pushHistoryCache, onTogglePushes,
    expandedPushes, selected, onToggleSelect,
  } = props;

  const ss = intg.syncState || {};
  const kind = intg.kind || 'sync';
  const lifecycle = intg.status || 'active';      // active | paused | error | draft
  const isRunning = ss.syncStatus === 'RUNNING';
  const paused = lifecycle === 'paused';

  usePolling(intg.integrationId, isRunning, {
    interval: 5000,
    onUpdate: (syncState) => onSyncUpdate(intg.integrationId, syncState),
    onTerminal: (syncState) => onSyncTerminal(intg.integrationId, syncState),
  });

  const fm = intg.fieldMappings || {};
  const srcName = ident(intg.source, fm, 'sourceType');
  const destName = ident(intg.dest, fm, 'destType');
  const target = fm.endpointUrl || fm.destListName || fm.listName || fm.pgTable || fm.destTable || '—';

  const pushes = pushHistoryCache[intg.integrationId] || intg.recentPushes || [];
  const isExpanded = expandedPushes.has(intg.integrationId);

  const eyebrowLabel = isRunning ? 'Syncing…'
    : paused ? 'Paused'
    : lifecycle === 'error' ? 'Error'
    : lifecycle === 'draft' ? 'Draft'
    : 'Active';

  return (
    <Card
      status={isRunning ? 'idle' : toneFor(lifecycle)}
      selected={selected}
      onSelect={() => onToggleSelect(intg.integrationId)}
      eyebrow={<span>{eyebrowLabel}</span>}
      badge={kind}
      title={intg.name || fm.projectKey || 'Connection'}
      ariaLabel={`${intg.name || 'Connection'}, ${eyebrowLabel}, ${srcName} to ${destName}`}
      sub={
        <>
          <span className="ucard-node"><span className="ucard-ico" aria-hidden="true">{identIcon(intg.source, fm, 'sourceType')}</span>{srcName}</span>
          <span className="ucard-arrow" aria-hidden="true">→</span>
          <span className="ucard-node"><span className="ucard-ico" aria-hidden="true">{identIcon(intg.dest, fm, 'destType')}</span>{destName}</span>
          {fm.projectKey ? <span className="badge badge-neutral" style={{ marginLeft: 6 }}>{fm.projectKey}</span> : null}
        </>
      }
      foot={
        <>
          <span title={intg.lastRun ? new Date(intg.lastRun.at).toLocaleString() : 'Never run'}>
            {intg.lastRun ? `last run ${fmtDate(intg.lastRun.at)} · ${intg.lastRun.status}` : 'never run'}
          </span>
          <span>{cronLabel(intg.scheduleCron)}</span>
        </>
      }
    >
      {/* Payload: 7-day volume + details */}
      <div className="ucard-body" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Sparkline data={intg.volume7d} />
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>7-day volume</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginTop: 10 }}>
        <div><div style={labelStyle}>Last Synced</div><div style={{ fontSize: 'var(--fs-sm)' }}>{fmtDate(ss.lastSyncedAt)}</div></div>
        <div><div style={labelStyle}>Date Range</div><div style={{ fontSize: 'var(--fs-sm)' }}>{ss.dateRangeStart || '--'} → {ss.dateRangeEnd || '--'}</div></div>
        <div style={{ gridColumn: '1 / -1' }}><div style={labelStyle}>Target</div><div style={{ fontSize: 'var(--fs-sm)', wordBreak: 'break-all' }}>{target}</div></div>
      </div>

      {ss.syncError && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--error-dim)', border: '1px solid var(--error)', borderRadius: 6, fontSize: 'var(--fs-sm)', color: 'var(--error-on)' }}>
          <strong>Error:</strong> {ss.syncError}
        </div>
      )}

      {/* Operational actions — always visible on this operations page. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn btn-primary btn-xs" disabled={isRunning} onClick={() => onRun(intg)}>
          <Icon name={kind === 'sync' ? 'refresh' : 'play'} />{kind === 'sync' ? 'Sync' : 'Run'}
        </button>
        {paused
          ? <button className="btn btn-outline btn-xs" onClick={() => onResume(intg)}><Icon name="play" />Resume</button>
          : <button className="btn btn-outline btn-xs" onClick={() => onPause(intg)}><Icon name="pause" />Pause</button>}
        <button className="btn btn-outline btn-xs" onClick={() => onOpenSchedule(intg)} title="Schedule">Schedule</button>
        <button className="btn btn-outline btn-xs" onClick={() => onViewLogs(intg)}><Icon name="external" />Logs</button>
        <button className="btn btn-outline btn-xs" onClick={() => onEditMapping(intg)}><Icon name="pencil" />Mapping</button>
        <button className="btn btn-outline btn-xs" onClick={() => onClone(intg)}><Icon name="copy" />Clone</button>
        <button className="btn btn-danger-ghost btn-xs" onClick={() => onDelete(intg)}><Icon name="close" />Delete</button>
      </div>

      {/* Push history toggle */}
      <div style={{ marginTop: 10 }}>
        <button className="btn btn-ghost btn-xs" onClick={() => onTogglePushes(intg.integrationId)}>
          {isExpanded ? '▼' : '▶'} Push History ({pushes.length})
        </button>
        {isExpanded && pushes.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="conn-table">
              <thead><tr>
                <th scope="col">Type</th><th scope="col">Date Range</th>
                <th scope="col">Records</th><th scope="col">Status</th><th scope="col">Pushed At</th><th scope="col">Error</th>
              </tr></thead>
              <tbody>
                {pushes.map((push, i) => (
                  <tr key={push.id || i}>
                    <td><span className={`badge ${push.pushType === 'INITIAL' ? 'badge-primary' : 'badge-info'}`}>{push.pushType}</span></td>
                    <td>{push.dateRangeStart} → {push.dateRangeEnd}</td>
                    <td>{push.recordCount?.toLocaleString?.() ?? push.recordCount}</td>
                    <td><span className={`badge ${statusBadgeClass(push.status)}`}>{push.status}</span></td>
                    <td style={{ fontSize: 'var(--fs-sm)' }}>{fmtDate(push.pushedAt)}</td>
                    <td style={{ color: 'var(--error-on)', fontSize: 'var(--fs-sm)' }}>{push.errorMessage || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {isExpanded && pushes.length === 0 && (
          <div style={{ marginTop: 8, fontSize: 'var(--fs-sm)', color: 'var(--text-dim)' }}>No push history available.</div>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */
export default function ConnectedPage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedPushes, setExpandedPushes] = useState(new Set());
  const [pushHistoryCache, setPushHistoryCache] = useState({});

  // Filters + bulk selection
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());

  // Modals
  const [scheduleModal, setScheduleModal] = useState(null);
  const [schedulePreset, setSchedulePreset] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [syncModal, setSyncModal] = useState(null);
  const [syncMode, setSyncMode] = useState('RESYNC_SAME');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [syncTriggering, setSyncTriggering] = useState(false);
  const [logsModal, setLogsModal] = useState(null); // { intg, runs }

  /* ---- Fetch ---- */
  const fetchIntegrations = useCallback(async () => {
    const res = await api.getConnected();
    const data = (res.ok && Array.isArray(res.data?.data)) ? res.data.data : [];
    setIntegrations(data);
    setLoading(false);
  }, []);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data on mount via a reusable async loader (data fetch, not derived-state-in-effect)
  useEffect(() => { fetchIntegrations(); }, [fetchIntegrations]);

  /* ---- Status counts (StatStrip) ---- */
  const counts = useMemo(() => integrations.reduce((a, i) => {
    const s = i.status || 'active'; a[s] = (a[s] || 0) + 1; return a;
  }, {}), [integrations]);

  /* ---- Search + status filter ---- */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return integrations.filter((intg) => {
      if (statusFilter !== 'all' && (intg.status || 'active') !== statusFilter) return false;
      if (!q) return true;
      const hay = [intg.name, intg.source?.name, intg.dest?.name,
        intg.fieldMappings?.sourceType, intg.fieldMappings?.destType]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [integrations, search, statusFilter]);

  const shownCount = visible.length;

  /* ---- Toggle helpers ---- */
  const togglePushes = useCallback(async (integrationId) => {
    setExpandedPushes((prev) => {
      const next = new Set(prev);
      if (next.has(integrationId)) next.delete(integrationId);
      else {
        next.add(integrationId);
        if (!pushHistoryCache[integrationId]) {
          api.getPushHistory(integrationId).then((res) => {
            if (res.ok && res.data?.data) setPushHistoryCache((p) => ({ ...p, [integrationId]: res.data.data }));
          });
        }
      }
      return next;
    });
  }, [pushHistoryCache]);

  const toggleSelect = useCallback((id) => setSelected((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  }), []);

  /* ---- Sync polling callbacks ---- */
  const handleSyncUpdate = useCallback((integrationId, syncState) => {
    setIntegrations((prev) => prev.map((intg) =>
      intg.integrationId === integrationId ? { ...intg, syncState: { ...intg.syncState, ...syncState } } : intg));
  }, []);

  const handleSyncTerminal = useCallback((integrationId, syncState) => {
    const intg = integrations.find((i) => i.integrationId === integrationId);
    const label = intg?.name || intg?.fieldMappings?.projectKey || integrationId;
    showToast(syncState.syncStatus === 'COMPLETED' ? `Sync completed for ${label}` : `Sync failed for ${label}: ${syncState.syncError || 'Unknown error'}`, syncState.syncStatus === 'COMPLETED' ? 'success' : 'error');
    setPushHistoryCache((prev) => ({ ...prev, [integrationId]: undefined }));
    if (expandedPushes.has(integrationId)) {
      api.getPushHistory(integrationId).then((res) => {
        if (res.ok && res.data?.data) setPushHistoryCache((p) => ({ ...p, [integrationId]: res.data.data }));
      });
    }
  }, [integrations, expandedPushes, showToast]);

  /* ---- Run (bus vs sync) ---- */
  const onRun = (intg) => {
    if ((intg.kind || 'sync') === 'sync') { openSyncModal(intg); return; }
    runBus(intg);
  };
  const runBus = async (intg) => {
    showToast(`Running ${intg.name}…`, 'info');
    const res = await api.runIntegration(intg.integrationId);
    if (res.ok && res.data?.success !== false) {
      const d = res.data?.data || res.data || {};
      showToast(`Run published ${d.published ?? d.records ?? 0} record(s) for ${intg.name}`, 'success');
      setTimeout(fetchIntegrations, 1500);
    } else {
      showToast(res.data?.error || 'Run failed', 'error');
    }
  };

  /* ---- Lifecycle actions ---- */
  const handlePause = async (intg) => {
    const res = await api.pauseIntegration(intg.integrationId);
    if (res.ok) { showToast(`Paused ${intg.name}`, 'success'); fetchIntegrations(); } else showToast(res.data?.error || 'Pause failed', 'error');
  };
  const handleResume = async (intg) => {
    const res = await api.resumeIntegration(intg.integrationId);
    if (res.ok) { showToast(`Resumed ${intg.name}`, 'success'); fetchIntegrations(); } else showToast(res.data?.error || 'Resume failed', 'error');
  };
  const handleClone = async (intg) => {
    const res = await api.cloneIntegration(intg.integrationId);
    if (res.ok && res.data?.success) { showToast(`Cloned ${intg.name} (draft)`, 'success'); fetchIntegrations(); } else showToast(res.data?.error || 'Clone failed', 'error');
  };
  const handleDelete = async (intg) => {
    const ok = await confirm({ title: `Delete "${intg.name}"?`, message: 'This removes the integration and all its runs, history, and (unshared) credentials. This cannot be undone.', danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    const res = await api.deleteIntegration(intg.integrationId);
    if (res.ok && res.data?.success) { showToast(`Deleted ${intg.name}`, 'success'); fetchIntegrations(); } else showToast(res.data?.error || 'Delete failed', 'error');
  };
  const handleViewLogs = async (intg) => {
    const res = await api.getRuns(intg.integrationId);
    setLogsModal({ intg, runs: (res.ok && Array.isArray(res.data?.data)) ? res.data.data : [] });
  };
  const handleEditMapping = (intg) => navigate(`/canvas?integrationId=${intg.integrationId}`);

  /* ---- Bulk + export ---- */
  const bulkAction = async (action) => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const res = await api.bulkConnected(action, ids);
    if (res.ok && res.data?.success) { showToast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${res.data.data?.updated ?? ids.length}`, 'success'); setSelected(new Set()); fetchIntegrations(); }
    else showToast(res.data?.error || (res.status === 403 ? 'Bulk actions require admin' : 'Bulk action failed'), 'error');
  };
  const allAction = async (action) => {
    const ids = integrations.map((i) => i.integrationId);
    if (ids.length === 0) { showToast('No connections', 'warning'); return; }
    const ok = await confirm({
      title: `${action === 'pause' ? 'Pause' : 'Resume'} all connections?`,
      message: `This ${action === 'pause' ? 'pauses' : 'resumes'} all ${ids.length} connection(s) and their schedules.`,
      confirmLabel: action === 'pause' ? 'Pause all' : 'Resume all',
    });
    if (!ok) return;
    const res = await api.bulkConnected(action, ids);
    if (res.ok && res.data?.success) { showToast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${res.data.data?.updated ?? ids.length}`, 'success'); fetchIntegrations(); }
    else showToast(res.data?.error || (res.status === 403 ? 'Bulk actions require admin' : 'Action failed'), 'error');
  };

  const exportCsv = () => {
    if (integrations.length === 0) { showToast('Nothing to export', 'warning'); return; }
    const cols = ['name', 'source', 'dest', 'kind', 'status', 'schedule', 'lastRun', 'lastStatus', 'volume7dTotal'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = integrations.map((i) => [
      i.name, i.source?.name || i.fieldMappings?.sourceType, i.dest?.name || i.fieldMappings?.destType,
      i.kind, i.status, i.scheduleCron || '', i.lastRun?.at || '', i.lastRun?.status || '',
      (i.volume7d || []).reduce((a, b) => a + (b.count || 0), 0),
    ].map(esc).join(','));
    const csv = [cols.join(','), ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = 'my-connections.csv'; a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${integrations.length} connection(s)`, 'success');
  };

  /* ---- Schedule + sync modals ---- */
  const openScheduleModal = (intg) => {
    const current = intg.scheduleCron;
    const preset = cronPresets.find((p) => p.value === current);
    setSchedulePreset(preset ? preset.value : current ? 'custom' : '');
    setCustomCron(current || '');
    setScheduleModal(intg);
  };
  const saveSchedule = async () => {
    const cron = schedulePreset === 'custom' ? customCron : schedulePreset;
    if (!cron) return;
    setScheduleSaving(true);
    const res = await api.updateSchedule(scheduleModal.integrationId, cron);
    setScheduleSaving(false);
    if (res.ok) { showToast(`Schedule saved: ${cronLabel(cron)}`, 'success'); setScheduleModal(null); fetchIntegrations(); }
    else showToast(res.data?.error || 'Failed to save schedule', 'error');
  };
  const clearSchedule = async () => {
    setScheduleSaving(true);
    const res = await api.clearSchedule(scheduleModal.integrationId);
    setScheduleSaving(false);
    if (res.ok) { showToast('Schedule cleared', 'success'); setScheduleModal(null); fetchIntegrations(); }
    else showToast(res.data?.error || 'Failed to clear schedule', 'error');
  };
  const openSyncModal = (intg) => {
    setSyncMode('RESYNC_SAME');
    setCustomStart(intg.syncState?.dateRangeStart || '');
    setCustomEnd(intg.syncState?.dateRangeEnd || '');
    setSyncModal(intg);
  };
  const triggerSync = async (intg) => {
    setSyncTriggering(true);
    const payload = { mode: syncMode, skipCompleted: true, deltaOnly: true };
    if (syncMode === 'CUSTOM') { payload.customStart = customStart; payload.customEnd = customEnd; }
    const res = await api.triggerSync(intg.integrationId, payload);
    setSyncTriggering(false);
    if (res.ok || res.status === 202) {
      showToast(`Sync started for ${intg.name}`, 'info');
      setIntegrations((prev) => prev.map((i) => i.integrationId === intg.integrationId ? { ...i, syncState: { ...i.syncState, syncStatus: 'RUNNING', syncError: null } } : i));
      setSyncModal(null);
    } else if (res.status === 409) { showToast('Sync already in progress', 'warning'); setSyncModal(null); }
    else showToast(res.data?.error || 'Failed to trigger sync', 'error');
  };

  /* ---------------------------------------------------------------- */
  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">My Connections</h1>
          <div className="page-subtitle">
            {loading ? 'Loading…' : <>Running integration instances &mdash; {integrations.length} connection{integrations.length === 1 ? '' : 's'}</>}
          </div>
        </div>
        <div className="flex gap-8">
          <button className="btn btn-outline btn-sm" onClick={() => allAction('pause')} disabled={integrations.length === 0}>Pause All</button>
          <button className="btn btn-outline btn-sm" onClick={() => allAction('resume')} disabled={integrations.length === 0}>Resume All</button>
          <button className="btn btn-outline btn-sm" onClick={exportCsv}><Icon name="download" />Export CSV</button>
          <button className="btn btn-primary btn-sm" onClick={() => navigate('/wizard')}>+ New Connection</button>
        </div>
      </div>

      <div className="page-body fit">
        {/* Summary doubles as the status filter. */}
        <StatStrip
          active={statusFilter}
          onFilter={setStatusFilter}
          items={[
            { key: 'all', label: 'Connections', value: integrations.length, tone: 'info', sub: 'All instances' },
            { key: 'active', label: 'Active', value: counts.active || 0, tone: 'ok', filter: 'active', sub: 'Running' },
            { key: 'paused', label: 'Paused', value: counts.paused || 0, tone: 'idle', filter: 'paused', sub: 'Schedule off' },
            { key: 'error', label: 'Error', value: counts.error || 0, tone: 'fail', filter: 'error', sub: 'Needs attention' },
            { key: 'draft', label: 'Draft', value: counts.draft || 0, tone: 'idle', filter: 'draft', sub: 'Not activated' },
          ]}
        />

        {/* Filter bar */}
        <div className="flex gap-12 mb-16" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="search-bar">
            <span className="search-icon"><Icon name="search" size={15} /></span>
            <input type="text" aria-label="Search connections by name or system"
              placeholder="Search connections…" style={{ width: 280 }}
              value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="filter-chips">
            {STATUS_FILTERS.map((s) => (
              <button key={s} type="button" className={`chip${statusFilter === s ? ' active' : ''}`}
                aria-pressed={statusFilter === s} onClick={() => setStatusFilter(s)}>{s}</button>
            ))}
          </div>
          {(statusFilter !== 'all' || search) && (
            <button type="button" className="link-btn" onClick={() => { setStatusFilter('all'); setSearch(''); }}>
              Clear filters ({shownCount} of {integrations.length} shown)
            </button>
          )}
        </div>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="bulk-bar">
            <span style={{ fontWeight: 'var(--fw-semibold)' }}>{selected.size} selected</span>
            <button className="btn btn-outline btn-sm" onClick={() => bulkAction('pause')}>Pause selected</button>
            <button className="btn btn-outline btn-sm" onClick={() => bulkAction('resume')}>Resume selected</button>
            <button className="btn btn-outline btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}

        {/* Connection grid — the scrolling region */}
        <div className="fit-scroll">
          {loading && <div className="ucard-grid"><CardSkeleton count={6} /></div>}

          {!loading && visible.length > 0 && (
            <div className="ucard-grid">
              {visible.map((intg) => (
                <IntegrationCard
                  key={intg.integrationId}
                  intg={intg}
                  onSyncUpdate={handleSyncUpdate}
                  onSyncTerminal={handleSyncTerminal}
                  onOpenSchedule={openScheduleModal}
                  onRun={onRun}
                  onPause={handlePause}
                  onResume={handleResume}
                  onClone={handleClone}
                  onDelete={handleDelete}
                  onViewLogs={handleViewLogs}
                  onEditMapping={handleEditMapping}
                  pushHistoryCache={pushHistoryCache}
                  onTogglePushes={togglePushes}
                  expandedPushes={expandedPushes}
                  selected={selected.has(intg.integrationId)}
                  onToggleSelect={toggleSelect}
                />
              ))}
            </div>
          )}

          {!loading && integrations.length === 0 && (
            <CardEmpty title="No connections yet" action={<button className="btn btn-primary btn-sm" onClick={() => navigate('/wizard')}>+ New Connection</button>}>
              Build your first connection in the Connection Wizard — it appears here once saved.
            </CardEmpty>
          )}
          {!loading && integrations.length > 0 && visible.length === 0 && (
            <CardEmpty title="Nothing matches this view">
              {integrations.length} connection{integrations.length === 1 ? '' : 's'}, but none match the current search or filters.
            </CardEmpty>
          )}
        </div>

        {/* Schedule Modal */}
        {scheduleModal && (
          <div style={overlayStyle} onClick={() => setScheduleModal(null)}>
            <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>Schedule &mdash; {scheduleModal.name}</h3>
                <button className="dp-close" aria-label="Close" onClick={() => setScheduleModal(null)}><Icon name="close" size={16} /></button>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle} htmlFor="connectedpage-preset">Preset</label>
                <select id="connectedpage-preset" style={selectStyle} value={schedulePreset} onChange={(e) => { setSchedulePreset(e.target.value); if (e.target.value !== 'custom') setCustomCron(e.target.value); }}>
                  <option value="">-- Select a schedule --</option>
                  {cronPresets.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
              </div>
              {schedulePreset === 'custom' && (
                <div style={{ marginBottom: 14 }}>
                  <label style={labelStyle} htmlFor="connectedpage-custom-cron-expression">Custom Cron Expression</label>
                  <input id="connectedpage-custom-cron-expression" style={inputStyle} value={customCron} onChange={(e) => setCustomCron(e.target.value)} placeholder="e.g. 0 9 * * 1-5" />
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>Format: minute hour day-of-month month day-of-week</div>
                </div>
              )}
              {scheduleModal.scheduleCron && (
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginBottom: 14 }}>Current: <strong>{cronLabel(scheduleModal.scheduleCron)}</strong> ({scheduleModal.scheduleCron})</div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                {scheduleModal.scheduleCron && <Button className="btn btn-danger btn-sm" onClick={clearSchedule} loading={scheduleSaving} loadingLabel="Clearing">Clear Schedule</Button>}
                <button className="btn btn-outline btn-sm" onClick={() => setScheduleModal(null)}>Cancel</button>
                <Button className="btn btn-primary btn-sm" onClick={saveSchedule} loading={scheduleSaving} loadingLabel="Saving" disabled={!schedulePreset && !customCron}>Save Schedule</Button>
              </div>
            </div>
          </div>
        )}

        {/* View Logs Modal */}
        {logsModal && (
          <div style={overlayStyle} onClick={() => setLogsModal(null)}>
            <div style={{ ...modalStyle, minWidth: 560 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>Run logs &mdash; {logsModal.intg.name}</h3>
                <button className="dp-close" aria-label="Close" onClick={() => setLogsModal(null)}><Icon name="close" size={16} /></button>
              </div>
              {logsModal.runs.length === 0 ? (
                <div style={{ fontSize: 'var(--fs-base)', color: 'var(--text-dim)', padding: 12 }}>No runs recorded yet.</div>
              ) : (
                <div className="table-wrap">
                  <table className="conn-table">
                    <thead><tr><th scope="col">Started</th><th scope="col">Finished</th><th scope="col">Status</th><th scope="col">In</th><th scope="col">Out</th></tr></thead>
                    <tbody>
                      {logsModal.runs.map((r) => (
                        <tr key={r.runId}>
                          <td style={{ fontSize: 'var(--fs-sm)' }}>{fmtDate(r.startedAt)}</td>
                          <td style={{ fontSize: 'var(--fs-sm)' }}>{fmtDate(r.finishedAt)}</td>
                          <td><span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span></td>
                          <td>{r.recordsIn ?? '—'}</td>
                          <td>{r.recordsOut ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="btn btn-outline btn-sm" onClick={() => { setLogsModal(null); navigate('/monitor'); }}>Open Monitor</button>
              </div>
            </div>
          </div>
        )}

        {/* Sync Dialog Modal */}
        {syncModal && (
          <div style={overlayStyle} onClick={() => setSyncModal(null)}>
            <div style={{ ...modalStyle, minWidth: 440 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 'var(--fs-md)' }}>Sync &mdash; {syncModal.name}</h3>
                <button className="dp-close" aria-label="Close" onClick={() => setSyncModal(null)}><Icon name="close" size={16} /></button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                {syncModes.map((mode) => (
                  <label key={mode.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', border: `1px solid ${syncMode === mode.value ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 8, cursor: 'pointer', background: syncMode === mode.value ? 'var(--primary-dim)' : 'transparent' }}>
                    <input type="radio" name="syncMode" value={mode.value} checked={syncMode === mode.value} onChange={() => setSyncMode(mode.value)} style={{ marginTop: 2, accentColor: 'var(--primary)' }} />
                    <div>
                      <div style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)' }}>{mode.label}</div>
                      <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-dim)', marginTop: 2 }}>{mode.description}</div>
                    </div>
                  </label>
                ))}
              </div>
              {syncMode === 'CUSTOM' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                  <div><label style={labelStyle} htmlFor="connectedpage-start-date">Start Date</label><input id="connectedpage-start-date" type="date" style={inputStyle} value={customStart} onChange={(e) => setCustomStart(e.target.value)} /></div>
                  <div><label style={labelStyle} htmlFor="connectedpage-end-date">End Date</label><input id="connectedpage-end-date" type="date" style={inputStyle} value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} /></div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-outline btn-sm" onClick={() => setSyncModal(null)}>Cancel</button>
                <Button className="btn btn-primary btn-sm" onClick={() => triggerSync(syncModal)} loading={syncTriggering} loadingLabel="Starting">↻ Start Sync</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
