import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../../hooks/useToast';
import { usePolling } from '../../hooks/usePolling';
import { api } from '../../services/api';
import {
  btnStyle, btnPrimaryStyle, btnDangerStyle, thStyle, tdStyle,
  overlayStyle, modalStyle, labelStyle, inputStyle, selectStyle,
  statusColor, statusBadgeClass, fmtDate,
} from './styles';

/* ------------------------------------------------------------------ */
/*  Mock fallback                                                     */
/* ------------------------------------------------------------------ */
const mockConnectedData = [
  {
    integrationId: 'int-001',
    name: 'Flatiron Health',
    status: 'active',
    fieldMappings: { projectKey: 'FLAT', listName: 'Nalashaa_Jira_Issues', endpointUrl: 'https://mynalashaa.sharepoint.com/sites/ResourceManagement', clientId: 'flatiron' },
    scheduleCron: '0 9 * * 1-5',
    createdAt: '2026-02-15T10:00:00Z',
    syncState: { syncStatus: 'COMPLETED', lastSyncedAt: '2026-04-13T09:00:00Z', lastJiraUpdatedAt: '2026-04-13T08:55:00Z', dateRangeStart: '2026-03-01', dateRangeEnd: '2026-03-31', syncError: null },
    recentPushes: [],
  },
  {
    integrationId: 'int-002',
    name: 'Red Gold Foods',
    status: 'active',
    fieldMappings: { projectKey: 'CAS', listName: 'Nalashaa_Jira_Issues', endpointUrl: 'https://mynalashaa.sharepoint.com/sites/ResourceManagement', clientId: 'red-gold' },
    scheduleCron: null,
    createdAt: '2026-03-01T14:00:00Z',
    syncState: { syncStatus: 'IDLE', lastSyncedAt: '2026-04-10T14:30:00Z', lastJiraUpdatedAt: null, dateRangeStart: '2026-03-01', dateRangeEnd: '2026-03-31', syncError: null },
    recentPushes: [],
  },
];

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

/* ------------------------------------------------------------------ */
/*  Polling wrapper per-card                                          */
/* ------------------------------------------------------------------ */
function IntegrationCard({ intg, onSyncUpdate, onSyncTerminal, onOpenSchedule, onOpenSync, pushHistoryCache, onTogglePushes, expandedPushes }) {
  const ss = intg.syncState;
  const isRunning = ss.syncStatus === 'RUNNING';

  usePolling(intg.integrationId, isRunning, {
    interval: 5000,
    onUpdate: (syncState) => onSyncUpdate(intg.integrationId, syncState),
    onTerminal: (syncState) => onSyncTerminal(intg.integrationId, syncState),
  });

  const pushes = pushHistoryCache[intg.integrationId] || intg.recentPushes || [];
  const isExpanded = expandedPushes.has(intg.integrationId);

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 16,
        background: 'var(--bg-main)',
        borderLeft: ss.syncStatus === 'FAILED' ? '3px solid var(--error)'
          : ss.syncStatus === 'RUNNING' ? '3px solid var(--info)'
          : '3px solid var(--success)',
      }}
    >
      {/* Project header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span
              style={{
                width: 10, height: 10, borderRadius: '50%',
                background: statusColor(ss.syncStatus),
                display: 'inline-block', flexShrink: 0,
              }}
            />
            <span style={{ fontWeight: 700, fontSize: '.95rem' }}>
              {intg.fieldMappings.projectKey}
            </span>
            <span className={`badge ${statusBadgeClass(ss.syncStatus)}`}>
              {ss.syncStatus}
            </span>
            {isRunning && (
              <span style={{ fontSize: '.72rem', color: 'var(--info)', fontStyle: 'italic' }}>
                polling...
              </span>
            )}
          </div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginLeft: 18 }}>
            Jira &rarr; {intg.fieldMappings.listName} &middot; Created {fmtDate(intg.createdAt)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button style={btnStyle} onClick={() => onOpenSchedule(intg)} title="Schedule">
            &#128339; Schedule
          </button>
          <button
            style={{
              ...btnPrimaryStyle,
              opacity: isRunning ? 0.5 : 1,
              pointerEvents: isRunning ? 'none' : 'auto',
            }}
            onClick={() => onOpenSync(intg)}
            title="Sync Now"
            disabled={isRunning}
          >
            &#8635; Sync
          </button>
        </div>
      </div>

      {/* Sync details grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginTop: 12 }}>
        <div>
          <div style={labelStyle}>Schedule</div>
          <div style={{ fontSize: '.85rem' }}>{cronLabel(intg.scheduleCron)}</div>
        </div>
        <div>
          <div style={labelStyle}>Last Synced</div>
          <div style={{ fontSize: '.85rem' }}>{fmtDate(ss.lastSyncedAt)}</div>
        </div>
        <div>
          <div style={labelStyle}>Date Range</div>
          <div style={{ fontSize: '.85rem' }}>{ss.dateRangeStart || '--'} &rarr; {ss.dateRangeEnd || '--'}</div>
        </div>
        <div>
          <div style={labelStyle}>SharePoint Site</div>
          <div style={{ fontSize: '.82rem', wordBreak: 'break-all' }}>{intg.fieldMappings.endpointUrl}</div>
        </div>
      </div>

      {/* Error banner */}
      {ss.syncError && (
        <div style={{ marginTop: 10, padding: '8px 12px', background: 'var(--error-dim)', border: '1px solid var(--error)', borderRadius: 6, fontSize: '.82rem', color: 'var(--error)' }}>
          <strong>Error:</strong> {ss.syncError}
        </div>
      )}

      {/* Push history toggle */}
      <div style={{ marginTop: 12 }}>
        <button
          style={{ ...btnStyle, fontSize: '.78rem', padding: '4px 10px' }}
          onClick={() => onTogglePushes(intg.integrationId)}
        >
          {isExpanded ? '\u25BC' : '\u25B6'} Push History ({pushes.length})
        </button>

        {isExpanded && pushes.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>Push ID</th>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Date Range</th>
                  <th style={thStyle}>Records</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Pushed At</th>
                  <th style={thStyle}>Error</th>
                </tr>
              </thead>
              <tbody>
                {pushes.map((push) => (
                  <tr key={push.id}>
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '.76rem' }}>{push.id}</td>
                    <td style={tdStyle}>
                      <span className={`badge ${push.pushType === 'INITIAL' ? 'badge-primary' : 'badge-info'}`}>
                        {push.pushType}
                      </span>
                    </td>
                    <td style={tdStyle}>{push.dateRangeStart} &rarr; {push.dateRangeEnd}</td>
                    <td style={tdStyle}>{push.recordCount?.toLocaleString?.() ?? push.recordCount}</td>
                    <td style={tdStyle}>
                      <span className={`badge ${statusBadgeClass(push.status)}`}>
                        {push.status}
                      </span>
                    </td>
                    <td style={{ ...tdStyle, fontSize: '.78rem' }}>{fmtDate(push.pushedAt)}</td>
                    <td style={{ ...tdStyle, color: 'var(--error)', fontSize: '.78rem' }}>{push.errorMessage || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {isExpanded && pushes.length === 0 && (
          <div style={{ marginTop: 8, fontSize: '.82rem', color: 'var(--text-dim)' }}>
            No push history available.
          </div>
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

  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedClients, setExpandedClients] = useState(new Set());
  const [expandedPushes, setExpandedPushes] = useState(new Set());
  const [pushHistoryCache, setPushHistoryCache] = useState({});

  // Schedule modal
  const [scheduleModal, setScheduleModal] = useState(null);
  const [schedulePreset, setSchedulePreset] = useState('');
  const [customCron, setCustomCron] = useState('');
  const [scheduleSaving, setScheduleSaving] = useState(false);

  // Sync dialog modal
  const [syncModal, setSyncModal] = useState(null);
  const [syncMode, setSyncMode] = useState('RESYNC_SAME');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [syncTriggering, setSyncTriggering] = useState(false);

  /* ---- Fetch integrations from backend ---- */
  const fetchIntegrations = useCallback(async () => {
    const res = await api.getConnected();
    if (res.ok && res.data?.data) {
      const data = res.data.data;
      setIntegrations(data);
      // Auto-expand all client groups
      const clientIds = new Set(data.map((intg) => intg.fieldMappings?.clientId).filter(Boolean));
      setExpandedClients(clientIds);
    } else {
      // Fallback to mock
      setIntegrations(mockConnectedData);
      setExpandedClients(new Set(['flatiron', 'red-gold']));
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchIntegrations(); }, [fetchIntegrations]);

  /* ---- Group by client ---- */
  const grouped = useMemo(() => {
    const map = {};
    integrations.forEach((intg) => {
      const cid = intg.fieldMappings?.clientId || 'unknown';
      if (!map[cid]) map[cid] = { clientName: intg.name, clientId: cid, projects: [] };
      map[cid].projects.push(intg);
    });
    return Object.values(map);
  }, [integrations]);

  /* ---- Toggle helpers ---- */
  const toggleClient = (cid) => {
    setExpandedClients((prev) => {
      const next = new Set(prev);
      next.has(cid) ? next.delete(cid) : next.add(cid);
      return next;
    });
  };

  const togglePushes = useCallback(async (integrationId) => {
    setExpandedPushes((prev) => {
      const next = new Set(prev);
      if (next.has(integrationId)) {
        next.delete(integrationId);
      } else {
        next.add(integrationId);
        // Lazy-fetch push history on first expand if not cached
        if (!pushHistoryCache[integrationId]) {
          api.getPushHistory(integrationId).then((res) => {
            if (res.ok && res.data?.data) {
              setPushHistoryCache((prev) => ({ ...prev, [integrationId]: res.data.data }));
            }
          });
        }
      }
      return next;
    });
  }, [pushHistoryCache]);

  /* ---- Sync polling callbacks ---- */
  const handleSyncUpdate = useCallback((integrationId, syncState) => {
    setIntegrations((prev) =>
      prev.map((intg) =>
        intg.integrationId === integrationId
          ? { ...intg, syncState: { ...intg.syncState, ...syncState } }
          : intg
      )
    );
  }, []);

  const handleSyncTerminal = useCallback((integrationId, syncState) => {
    const status = syncState.syncStatus;
    const intg = integrations.find((i) => i.integrationId === integrationId);
    const label = intg?.fieldMappings?.projectKey || integrationId;
    if (status === 'COMPLETED') {
      showToast(`Sync completed for ${label}`);
    } else {
      showToast(`Sync failed for ${label}: ${syncState.syncError || 'Unknown error'}`);
    }
    // Refresh push history for this integration
    setPushHistoryCache((prev) => ({ ...prev, [integrationId]: undefined }));
    if (expandedPushes.has(integrationId)) {
      api.getPushHistory(integrationId).then((res) => {
        if (res.ok && res.data?.data) {
          setPushHistoryCache((prev) => ({ ...prev, [integrationId]: res.data.data }));
        }
      });
    }
  }, [integrations, expandedPushes, showToast]);

  /* ---- Trigger sync ---- */
  const triggerSync = async (intg) => {
    setSyncTriggering(true);
    const payload = {
      mode: syncMode,
      skipCompleted: true,
      deltaOnly: true,
    };
    if (syncMode === 'CUSTOM') {
      payload.customStart = customStart;
      payload.customEnd = customEnd;
    }

    const res = await api.triggerSync(intg.integrationId, payload);
    setSyncTriggering(false);

    if (res.ok || res.status === 202) {
      showToast(`Sync started for ${intg.fieldMappings.projectKey}`);
      // Set card to RUNNING so polling begins
      setIntegrations((prev) =>
        prev.map((i) =>
          i.integrationId === intg.integrationId
            ? { ...i, syncState: { ...i.syncState, syncStatus: 'RUNNING', syncError: null } }
            : i
        )
      );
      setSyncModal(null);
    } else if (res.status === 409) {
      showToast('Sync already in progress');
      setSyncModal(null);
    } else {
      showToast(res.data?.error || 'Failed to trigger sync');
    }
  };

  /* ---- Schedule actions ---- */
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
    if (res.ok) {
      showToast(`Schedule saved: ${cronLabel(cron)}`);
      setScheduleModal(null);
      fetchIntegrations();
    } else {
      showToast(res.data?.error || 'Failed to save schedule');
    }
  };

  const clearSchedule = async () => {
    setScheduleSaving(true);
    const res = await api.clearSchedule(scheduleModal.integrationId);
    setScheduleSaving(false);
    if (res.ok) {
      showToast('Schedule cleared');
      setScheduleModal(null);
      fetchIntegrations();
    } else {
      showToast(res.data?.error || 'Failed to clear schedule');
    }
  };

  const openSyncModal = (intg) => {
    setSyncMode('RESYNC_SAME');
    setCustomStart(intg.syncState?.dateRangeStart || '');
    setCustomEnd(intg.syncState?.dateRangeEnd || '');
    setSyncModal(intg);
  };

  /* ---------------------------------------------------------------- */
  /*  Render                                                          */
  /* ---------------------------------------------------------------- */
  if (loading) {
    return (
      <div className="page active" style={{ textAlign: 'center', padding: 60, color: 'var(--text-dim)' }}>
        Loading connected instances...
      </div>
    );
  }

  return (
    <div className="page active">
      {/* Header */}
      <div className="page-header">
        <div>
          <div className="page-title">Connected Instances</div>
          <div className="page-subtitle">Active Jira &harr; SharePoint integrations with sync scheduling</div>
        </div>
        <button style={btnPrimaryStyle} onClick={() => navigate('/push')}>
          + Push New Project
        </button>
      </div>

      {/* Client groups */}
      {grouped.map((group) => (
        <div key={group.clientId} className="card" style={{ marginBottom: 16 }}>
          {/* Client header */}
          <div
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '4px 0' }}
            onClick={() => toggleClient(group.clientId)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: '1.1rem', transition: 'transform .2s', transform: expandedClients.has(group.clientId) ? 'rotate(90deg)' : 'rotate(0)' }}>
                &#9654;
              </span>
              <span style={{ fontWeight: 700, fontSize: '1rem' }}>{group.clientName}</span>
              <span className="badge badge-neutral" style={{ marginLeft: 4 }}>
                {group.projects.length} project{group.projects.length !== 1 ? 's' : ''}
              </span>
            </div>
            <span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>
              Client ID: {group.clientId}
            </span>
          </div>

          {/* Projects under this client */}
          {expandedClients.has(group.clientId) && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {group.projects.map((intg) => (
                <IntegrationCard
                  key={intg.integrationId}
                  intg={intg}
                  onSyncUpdate={handleSyncUpdate}
                  onSyncTerminal={handleSyncTerminal}
                  onOpenSchedule={openScheduleModal}
                  onOpenSync={openSyncModal}
                  pushHistoryCache={pushHistoryCache}
                  onTogglePushes={togglePushes}
                  expandedPushes={expandedPushes}
                />
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Empty state */}
      {grouped.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--text-dim)' }}>
          <div style={{ fontSize: '2rem', marginBottom: 8 }}>&#128279;</div>
          <div style={{ fontSize: '.95rem', fontWeight: 600 }}>No connected integrations</div>
          <div style={{ fontSize: '.82rem', marginTop: 4 }}>Push a new project to get started.</div>
          <button style={{ ...btnPrimaryStyle, marginTop: 16 }} onClick={() => navigate('/push')}>
            + Push New Project
          </button>
        </div>
      )}

      {/* ============================================================ */}
      {/*  Schedule Modal                                              */}
      {/* ============================================================ */}
      {scheduleModal && (
        <div style={overlayStyle} onClick={() => setScheduleModal(null)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem' }}>
                Schedule &mdash; {scheduleModal.fieldMappings.projectKey}
              </h3>
              <button
                style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-dim)' }}
                onClick={() => setScheduleModal(null)}
              >
                &times;
              </button>
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Preset</label>
              <select
                style={selectStyle}
                value={schedulePreset}
                onChange={(e) => {
                  setSchedulePreset(e.target.value);
                  if (e.target.value !== 'custom') setCustomCron(e.target.value);
                }}
              >
                <option value="">-- Select a schedule --</option>
                {cronPresets.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            {schedulePreset === 'custom' && (
              <div style={{ marginBottom: 14 }}>
                <label style={labelStyle}>Custom Cron Expression</label>
                <input
                  style={inputStyle}
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="e.g. 0 9 * * 1-5"
                />
                <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 4 }}>
                  Format: minute hour day-of-month month day-of-week
                </div>
              </div>
            )}

            {scheduleModal.scheduleCron && (
              <div style={{ fontSize: '.82rem', color: 'var(--text-dim)', marginBottom: 14 }}>
                Current schedule: <strong>{cronLabel(scheduleModal.scheduleCron)}</strong> ({scheduleModal.scheduleCron})
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {scheduleModal.scheduleCron && (
                <button style={btnDangerStyle} onClick={clearSchedule} disabled={scheduleSaving}>
                  {scheduleSaving ? 'Clearing...' : 'Clear Schedule'}
                </button>
              )}
              <button style={btnStyle} onClick={() => setScheduleModal(null)}>Cancel</button>
              <button
                style={btnPrimaryStyle}
                onClick={saveSchedule}
                disabled={(!schedulePreset && !customCron) || scheduleSaving}
              >
                {scheduleSaving ? 'Saving...' : 'Save Schedule'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/*  Sync Dialog Modal                                           */}
      {/* ============================================================ */}
      {syncModal && (
        <div style={overlayStyle} onClick={() => setSyncModal(null)}>
          <div style={{ ...modalStyle, minWidth: 440 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem' }}>
                Sync &mdash; {syncModal.fieldMappings.projectKey}
              </h3>
              <button
                style={{ background: 'none', border: 'none', fontSize: '1.2rem', cursor: 'pointer', color: 'var(--text-dim)' }}
                onClick={() => setSyncModal(null)}
              >
                &times;
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              {syncModes.map((mode) => (
                <label
                  key={mode.value}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '10px 12px',
                    border: `1px solid ${syncMode === mode.value ? 'var(--primary)' : 'var(--border)'}`,
                    borderRadius: 8,
                    cursor: 'pointer',
                    background: syncMode === mode.value ? 'var(--primary-dim)' : 'transparent',
                    transition: 'all .15s',
                  }}
                >
                  <input
                    type="radio"
                    name="syncMode"
                    value={mode.value}
                    checked={syncMode === mode.value}
                    onChange={() => setSyncMode(mode.value)}
                    style={{ marginTop: 2, accentColor: 'var(--primary)' }}
                  />
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '.88rem' }}>{mode.label}</div>
                    <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginTop: 2 }}>{mode.description}</div>
                  </div>
                </label>
              ))}
            </div>

            {syncMode === 'RESYNC_SAME' && (
              <div style={{ fontSize: '.82rem', color: 'var(--text-secondary)', marginBottom: 14, padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 6 }}>
                Will re-sync: <strong>{syncModal.syncState?.dateRangeStart}</strong> &rarr; <strong>{syncModal.syncState?.dateRangeEnd}</strong>
              </div>
            )}

            {syncMode === 'EXTEND_TO_TODAY' && (
              <div style={{ fontSize: '.82rem', color: 'var(--text-secondary)', marginBottom: 14, padding: '8px 12px', background: 'var(--bg-main)', borderRadius: 6 }}>
                Will sync: <strong>{syncModal.syncState?.dateRangeStart}</strong> &rarr; <strong>{new Date().toISOString().slice(0, 10)}</strong>
              </div>
            )}

            {syncMode === 'CUSTOM' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={labelStyle}>Start Date</label>
                  <input
                    type="date"
                    style={inputStyle}
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                  />
                </div>
                <div>
                  <label style={labelStyle}>End Date</label>
                  <input
                    type="date"
                    style={inputStyle}
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={btnStyle} onClick={() => setSyncModal(null)}>Cancel</button>
              <button
                style={{ ...btnPrimaryStyle, opacity: syncTriggering ? 0.5 : 1 }}
                onClick={() => triggerSync(syncModal)}
                disabled={syncTriggering}
              >
                {syncTriggering ? 'Starting...' : '\u21BB Start Sync'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}