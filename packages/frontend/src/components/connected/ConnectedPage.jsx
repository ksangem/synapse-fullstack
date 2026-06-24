import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { usePolling } from '../../hooks/usePolling';
import { api } from '../../services/api';
import { systemIcon } from '../../services/integrationMap';
import {
  btnStyle, btnPrimaryStyle, btnDangerStyle, thStyle, tdStyle,
  overlayStyle, modalStyle, labelStyle, inputStyle, selectStyle,
  statusColor, statusBadgeClass, fmtDate,
} from './styles';

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

/** Tiny dependency-free SVG bar sparkline for the 7-day volume. */
function Sparkline({ data = [], width = 84, height = 22 }) {
  const counts = data.map((d) => Number(d?.count) || 0);
  if (counts.length === 0) return <span style={{ fontSize: '.7rem', color: 'var(--text-dim)' }}>—</span>;
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

  const dotColor = isRunning ? 'var(--info)'
    : paused ? 'var(--text-dim)'
    : lifecycle === 'error' ? 'var(--error)'
    : lifecycle === 'draft' ? 'var(--info)'
    : 'var(--success)';

  const fm = intg.fieldMappings || {};
  const srcName = ident(intg.source, fm, 'sourceType');
  const destName = ident(intg.dest, fm, 'destType');
  const target = fm.endpointUrl || fm.destListName || fm.listName || fm.pgTable || fm.destTable || '—';

  const pushes = pushHistoryCache[intg.integrationId] || intg.recentPushes || [];
  const isExpanded = expandedPushes.has(intg.integrationId);
  const smallBtn = { ...btnStyle, fontSize: '.74rem', padding: '4px 9px' };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, background: 'var(--bg-main)', borderLeft: `3px solid ${dotColor}` }}>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input type="checkbox" checked={selected} onChange={() => onToggleSelect(intg.integrationId)} style={{ marginTop: 4, accentColor: 'var(--primary)' }} title="Select" />
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
              <span style={{ fontWeight: 700, fontSize: '.95rem' }}>{intg.name || fm.projectKey || 'Connection'}</span>
              <span className={`badge ${paused ? 'badge-neutral' : lifecycle === 'error' ? 'badge-error' : lifecycle === 'draft' ? 'badge-info' : 'badge-success'}`}>{lifecycle}</span>
              <span className="badge badge-neutral" style={{ fontSize: '.66rem' }}>{kind}</span>
              {isRunning && <span style={{ fontSize: '.72rem', color: 'var(--info)', fontStyle: 'italic' }}>syncing…</span>}
            </div>
            <div style={{ fontSize: '.8rem', color: 'var(--text-dim)', marginLeft: 18 }}>
              <span title={srcName}>{identIcon(intg.source, fm, 'sourceType')} {srcName}</span>
              {' '}&rarr;{' '}
              <span title={destName}>{identIcon(intg.dest, fm, 'destType')} {destName}</span>
              {fm.projectKey ? ` · ${fm.projectKey}` : ''}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <Sparkline data={intg.volume7d} />
          <span style={{ fontSize: '.7rem', color: 'var(--text-dim)' }}>
            {intg.lastRun ? `last run ${fmtDate(intg.lastRun.at)} · ${intg.lastRun.status}` : 'never run'}
          </span>
        </div>
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
        <button style={{ ...btnPrimaryStyle, fontSize: '.74rem', padding: '4px 10px', opacity: isRunning ? 0.5 : 1, pointerEvents: isRunning ? 'none' : 'auto' }} disabled={isRunning} onClick={() => onRun(intg)}>
          {kind === 'sync' ? '↻ Sync' : '▶ Run'}
        </button>
        {paused
          ? <button style={smallBtn} onClick={() => onResume(intg)}>Resume</button>
          : <button style={smallBtn} onClick={() => onPause(intg)}>Pause</button>}
        <button style={smallBtn} onClick={() => onOpenSchedule(intg)} title="Schedule">&#128339; Schedule</button>
        <button style={smallBtn} onClick={() => onViewLogs(intg)}>View Logs</button>
        <button style={smallBtn} onClick={() => onEditMapping(intg)}>Edit Mapping</button>
        <button style={smallBtn} onClick={() => onClone(intg)}>Clone</button>
        <button style={{ ...btnDangerStyle, fontSize: '.74rem', padding: '4px 10px' }} onClick={() => onDelete(intg)}>Delete</button>
      </div>

      {/* Details grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginTop: 12 }}>
        <div><div style={labelStyle}>Schedule</div><div style={{ fontSize: '.85rem' }}>{cronLabel(intg.scheduleCron)}</div></div>
        <div><div style={labelStyle}>Last Synced</div><div style={{ fontSize: '.85rem' }}>{fmtDate(ss.lastSyncedAt)}</div></div>
        <div><div style={labelStyle}>Date Range</div><div style={{ fontSize: '.85rem' }}>{ss.dateRangeStart || '--'} &rarr; {ss.dateRangeEnd || '--'}</div></div>
        <div><div style={labelStyle}>Target</div><div style={{ fontSize: '.82rem', wordBreak: 'break-all' }}>{target}</div></div>
      </div>

      {/* Error banner */}
      {ss.syncError && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--error-dim)', border: '1px solid var(--error)', borderRadius: 6, fontSize: '.82rem', color: 'var(--error)' }}>
          <strong>Error:</strong> {ss.syncError}
        </div>
      )}

      {/* Push history toggle */}
      <div style={{ marginTop: 12 }}>
        <button style={{ ...btnStyle, fontSize: '.78rem', padding: '4px 10px' }} onClick={() => onTogglePushes(intg.integrationId)}>
          {isExpanded ? '▼' : '▶'} Push History ({pushes.length})
        </button>
        {isExpanded && pushes.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={thStyle}>Push ID</th><th style={thStyle}>Type</th><th style={thStyle}>Date Range</th>
                <th style={thStyle}>Records</th><th style={thStyle}>Status</th><th style={thStyle}>Pushed At</th><th style={thStyle}>Error</th>
              </tr></thead>
              <tbody>
                {pushes.map((push) => (
                  <tr key={push.id}>
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '.76rem' }}>{push.id}</td>
                    <td style={tdStyle}><span className={`badge ${push.pushType === 'INITIAL' ? 'badge-primary' : 'badge-info'}`}>{push.pushType}</span></td>
                    <td style={tdStyle}>{push.dateRangeStart} &rarr; {push.dateRangeEnd}</td>
                    <td style={tdStyle}>{push.recordCount?.toLocaleString?.() ?? push.recordCount}</td>
                    <td style={tdStyle}><span className={`badge ${statusBadgeClass(push.status)}`}>{push.status}</span></td>
                    <td style={{ ...tdStyle, fontSize: '.78rem' }}>{fmtDate(push.pushedAt)}</td>
                    <td style={{ ...tdStyle, color: 'var(--error)', fontSize: '.78rem' }}>{push.errorMessage || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {isExpanded && pushes.length === 0 && (
          <div style={{ marginTop: 8, fontSize: '.82rem', color: 'var(--text-dim)' }}>No push history available.</div>
        )}
      </div>
    </div>
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
  const [expandedClients, setExpandedClients] = useState(new Set());
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
    setExpandedClients(new Set(data.map((intg) => intg.fieldMappings?.clientId).filter(Boolean)));
    setLoading(false);
  }, []);
  useEffect(() => { fetchIntegrations(); }, [fetchIntegrations]);

  /* ---- Filter + group ---- */
  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = integrations.filter((intg) => {
      if (statusFilter !== 'all' && (intg.status || 'active') !== statusFilter) return false;
      if (!q) return true;
      const hay = [intg.name, intg.source?.name, intg.dest?.name, intg.fieldMappings?.sourceType, intg.fieldMappings?.destType]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    const map = {};
    filtered.forEach((intg) => {
      const cid = intg.fieldMappings?.clientId || 'unknown';
      if (!map[cid]) map[cid] = { clientName: intg.name, clientId: cid, projects: [] };
      map[cid].projects.push(intg);
    });
    return Object.values(map);
  }, [integrations, search, statusFilter]);

  /* ---- Toggle helpers ---- */
  const toggleClient = (cid) => setExpandedClients((prev) => {
    const next = new Set(prev); next.has(cid) ? next.delete(cid) : next.add(cid); return next;
  });

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
    showToast(syncState.syncStatus === 'COMPLETED' ? `Sync completed for ${label}` : `Sync failed for ${label}: ${syncState.syncError || 'Unknown error'}`);
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
    showToast(`Running ${intg.name}…`);
    const res = await api.runIntegration(intg.integrationId);
    if (res.ok && res.data?.success !== false) {
      const d = res.data?.data || res.data || {};
      showToast(`Run published ${d.published ?? d.records ?? 0} record(s) for ${intg.name}`);
      setTimeout(fetchIntegrations, 1500);
    } else {
      showToast(res.data?.error || 'Run failed');
    }
  };

  /* ---- Lifecycle actions ---- */
  const handlePause = async (intg) => {
    const res = await api.pauseIntegration(intg.integrationId);
    if (res.ok) { showToast(`Paused ${intg.name}`); fetchIntegrations(); } else showToast(res.data?.error || 'Pause failed');
  };
  const handleResume = async (intg) => {
    const res = await api.resumeIntegration(intg.integrationId);
    if (res.ok) { showToast(`Resumed ${intg.name}`); fetchIntegrations(); } else showToast(res.data?.error || 'Resume failed');
  };
  const handleClone = async (intg) => {
    const res = await api.cloneIntegration(intg.integrationId);
    if (res.ok && res.data?.success) { showToast(`Cloned ${intg.name} (draft)`); fetchIntegrations(); } else showToast(res.data?.error || 'Clone failed');
  };
  const handleDelete = async (intg) => {
    const ok = await confirm({ title: `Delete "${intg.name}"?`, message: 'This removes the integration and all its runs, history, and (unshared) credentials. This cannot be undone.', danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    const res = await api.deleteIntegration(intg.integrationId);
    if (res.ok && res.data?.success) { showToast(`Deleted ${intg.name}`); fetchIntegrations(); } else showToast(res.data?.error || 'Delete failed');
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
    if (res.ok && res.data?.success) { showToast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${res.data.data?.updated ?? ids.length}`); setSelected(new Set()); fetchIntegrations(); }
    else showToast(res.data?.error || (res.status === 403 ? 'Bulk actions require admin' : 'Bulk action failed'));
  };
  // Pause/Resume EVERY connection at once (real replacement for the old dashboard
  // "Pause All / Resume All" stubs) — one confirmed bulk call over all ids.
  const allAction = async (action) => {
    const ids = integrations.map((i) => i.integrationId);
    if (ids.length === 0) { showToast('No connections'); return; }
    const ok = await confirm({
      title: `${action === 'pause' ? 'Pause' : 'Resume'} all connections?`,
      message: `This ${action === 'pause' ? 'pauses' : 'resumes'} all ${ids.length} connection(s) and their schedules.`,
      confirmLabel: action === 'pause' ? 'Pause all' : 'Resume all',
    });
    if (!ok) return;
    const res = await api.bulkConnected(action, ids);
    if (res.ok && res.data?.success) { showToast(`${action === 'pause' ? 'Paused' : 'Resumed'} ${res.data.data?.updated ?? ids.length}`); fetchIntegrations(); }
    else showToast(res.data?.error || (res.status === 403 ? 'Bulk actions require admin' : 'Action failed'));
  };

  const exportCsv = () => {
    if (integrations.length === 0) { showToast('Nothing to export'); return; }
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
    showToast(`Exported ${integrations.length} connection(s)`);
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
    if (res.ok) { showToast(`Schedule saved: ${cronLabel(cron)}`); setScheduleModal(null); fetchIntegrations(); }
    else showToast(res.data?.error || 'Failed to save schedule');
  };
  const clearSchedule = async () => {
    setScheduleSaving(true);
    const res = await api.clearSchedule(scheduleModal.integrationId);
    setScheduleSaving(false);
    if (res.ok) { showToast('Schedule cleared'); setScheduleModal(null); fetchIntegrations(); }
    else showToast(res.data?.error || 'Failed to clear schedule');
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
      showToast(`Sync started for ${intg.name}`);
      setIntegrations((prev) => prev.map((i) => i.integrationId === intg.integrationId ? { ...i, syncState: { ...i.syncState, syncStatus: 'RUNNING', syncError: null } } : i));
      setSyncModal(null);
    } else if (res.status === 409) { showToast('Sync already in progress'); setSyncModal(null); }
    else showToast(res.data?.error || 'Failed to trigger sync');
  };

  /* ---------------------------------------------------------------- */
  if (loading) {
    return <div className="page active" style={{ textAlign: 'center', padding: 60, color: 'var(--text-dim)' }}>Loading connections…</div>;
  }

  const chipStyle = (active) => ({ ...btnStyle, fontSize: '.76rem', padding: '4px 12px', background: active ? 'var(--primary)' : 'var(--bg-main)', color: active ? '#fff' : undefined, borderColor: active ? 'var(--primary)' : 'var(--border)' });

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">My Connections</div>
          <div className="page-subtitle">Running integration instances &mdash; status, schedule, and actions</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={btnStyle} onClick={() => allAction('pause')} disabled={integrations.length === 0}>Pause All</button>
          <button style={btnStyle} onClick={() => allAction('resume')} disabled={integrations.length === 0}>Resume All</button>
          <button style={btnStyle} onClick={exportCsv}>Export CSV</button>
          <button style={btnPrimaryStyle} onClick={() => navigate('/wizard')}>+ New Connection</button>
        </div>
      </div>

      <div className="page-body">
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <input style={{ ...inputStyle, maxWidth: 280 }} placeholder="Search by name or system…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div style={{ display: 'flex', gap: 6 }}>
          {STATUS_FILTERS.map((s) => (
            <button key={s} style={chipStyle(statusFilter === s)} onClick={() => setStatusFilter(s)}>{s}</button>
          ))}
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 14px', marginBottom: 14, background: 'var(--primary-dim)', border: '1px solid var(--primary)', borderRadius: 8 }}>
          <span style={{ fontSize: '.85rem', fontWeight: 600 }}>{selected.size} selected</span>
          <button style={btnStyle} onClick={() => bulkAction('pause')}>Pause selected</button>
          <button style={btnStyle} onClick={() => bulkAction('resume')}>Resume selected</button>
          <button style={{ ...btnStyle, marginLeft: 'auto' }} onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {/* Client groups */}
      {grouped.map((group) => (
        <div key={group.clientId} className="card" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '4px 0' }} onClick={() => toggleClient(group.clientId)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '1.1rem', transition: 'transform .2s', transform: expandedClients.has(group.clientId) ? 'rotate(90deg)' : 'rotate(0)' }}>&#9654;</span>
              <span style={{ fontWeight: 700, fontSize: '1rem' }}>{group.clientName}</span>
              <span className="badge badge-neutral" style={{ marginLeft: 4 }}>{group.projects.length} connection{group.projects.length !== 1 ? 's' : ''}</span>
            </div>
            <span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>Client ID: {group.clientId}</span>
          </div>
          {expandedClients.has(group.clientId) && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {group.projects.map((intg) => (
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
        </div>
      ))}

      {grouped.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>&#128279;</div>
          <div style={{ fontSize: '.95rem', fontWeight: 600 }}>No connections match</div>
          <div style={{ fontSize: '.82rem', marginTop: 4 }}>Adjust the filters, or create a new connection.</div>
          <button style={{ ...btnPrimaryStyle, marginTop: 16 }} onClick={() => navigate('/wizard')}>+ New Connection</button>
        </div>
      )}

      {/* Schedule Modal */}
      {scheduleModal && (
        <div style={overlayStyle} onClick={() => setScheduleModal(null)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Schedule &mdash; {scheduleModal.name}</h3>
              <button style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-dim)' }} onClick={() => setScheduleModal(null)}>&times;</button>
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Preset</label>
              <select style={selectStyle} value={schedulePreset} onChange={(e) => { setSchedulePreset(e.target.value); if (e.target.value !== 'custom') setCustomCron(e.target.value); }}>
                <option value="">-- Select a schedule --</option>
                {cronPresets.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            {schedulePreset === 'custom' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Custom Cron Expression</label>
                <input style={inputStyle} value={customCron} onChange={(e) => setCustomCron(e.target.value)} placeholder="e.g. 0 9 * * 1-5" />
                <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 4 }}>Format: minute hour day-of-month month day-of-week</div>
              </div>
            )}
            {scheduleModal.scheduleCron && (
              <div style={{ fontSize: '.82rem', color: 'var(--text-dim)', marginBottom: 14 }}>Current: <strong>{cronLabel(scheduleModal.scheduleCron)}</strong> ({scheduleModal.scheduleCron})</div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {scheduleModal.scheduleCron && <button style={btnDangerStyle} onClick={clearSchedule} disabled={scheduleSaving}>{scheduleSaving ? 'Clearing…' : 'Clear Schedule'}</button>}
              <button style={btnStyle} onClick={() => setScheduleModal(null)}>Cancel</button>
              <button style={btnPrimaryStyle} onClick={saveSchedule} disabled={(!schedulePreset && !customCron) || scheduleSaving}>{scheduleSaving ? 'Saving…' : 'Save Schedule'}</button>
            </div>
          </div>
        </div>
      )}

      {/* View Logs Modal */}
      {logsModal && (
        <div style={overlayStyle} onClick={() => setLogsModal(null)}>
          <div style={{ ...modalStyle, minWidth: 560 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Run logs &mdash; {logsModal.intg.name}</h3>
              <button style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-dim)' }} onClick={() => setLogsModal(null)}>&times;</button>
            </div>
            {logsModal.runs.length === 0 ? (
              <div style={{ fontSize: '.85rem', color: 'var(--text-dim)', padding: 12 }}>No runs recorded yet.</div>
            ) : (
              <div className="table-wrap">
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={thStyle}>Started</th><th style={thStyle}>Finished</th><th style={thStyle}>Status</th><th style={thStyle}>In</th><th style={thStyle}>Out</th></tr></thead>
                  <tbody>
                    {logsModal.runs.map((r) => (
                      <tr key={r.runId}>
                        <td style={{ ...tdStyle, fontSize: '.78rem' }}>{fmtDate(r.startedAt)}</td>
                        <td style={{ ...tdStyle, fontSize: '.78rem' }}>{fmtDate(r.finishedAt)}</td>
                        <td style={tdStyle}><span className={`badge ${statusBadgeClass(r.status)}`}>{r.status}</span></td>
                        <td style={tdStyle}>{r.recordsIn ?? '—'}</td>
                        <td style={tdStyle}>{r.recordsOut ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              <button style={btnStyle} onClick={() => { setLogsModal(null); navigate('/monitor'); }}>Open Monitor</button>
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Sync Dialog Modal */}
      {syncModal && (
        <div style={overlayStyle} onClick={() => setSyncModal(null)}>
          <div style={{ ...modalStyle, minWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Sync &mdash; {syncModal.name}</h3>
              <button style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-dim)' }} onClick={() => setSyncModal(null)}>&times;</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {syncModes.map((mode) => (
                <label key={mode.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', border: `1px solid ${syncMode === mode.value ? 'var(--primary)' : 'var(--border)'}`, borderRadius: 8, cursor: 'pointer', background: syncMode === mode.value ? 'var(--primary-dim)' : 'transparent' }}>
                  <input type="radio" name="syncMode" value={mode.value} checked={syncMode === mode.value} onChange={() => setSyncMode(mode.value)} style={{ marginTop: 2, accentColor: 'var(--primary)' }} />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '.88rem' }}>{mode.label}</div>
                    <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginTop: 2 }}>{mode.description}</div>
                  </div>
                </label>
              ))}
            </div>
            {syncMode === 'CUSTOM' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div><label style={labelStyle}>Start Date</label><input type="date" style={inputStyle} value={customStart} onChange={(e) => setCustomStart(e.target.value)} /></div>
                <div><label style={labelStyle}>End Date</label><input type="date" style={inputStyle} value={customEnd} onChange={(e) => setCustomEnd(e.target.value)} /></div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={btnStyle} onClick={() => setSyncModal(null)}>Cancel</button>
              <button style={{ ...btnPrimaryStyle, opacity: syncTriggering ? 0.5 : 1 }} onClick={() => triggerSync(syncModal)} disabled={syncTriggering}>{syncTriggering ? 'Starting…' : '↻ Start Sync'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
