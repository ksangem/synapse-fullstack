import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../services/api';
import DeadLetterPanel from './DeadLetterPanel';

// Bus envelope status → badge style.
const statusBadge = (status) => {
  switch (status) {
    case 'done': return 'badge-success';
    case 'failed': return 'badge-error';
    case 'poisoned': return 'badge-error';
    case 'processing': return 'badge-info';
    default: return 'badge-warning'; // pending / received / etc.
  }
};

export default function MonitorPage() {
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [directionFilter, setDirectionFilter] = useState('All');
  const [showSuccess, setShowSuccess] = useState(true);
  const [showFailed, setShowFailed] = useState(true);
  const [realtime, setRealtime] = useState(true);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const timer = useRef(null);

  const load = useCallback(async () => {
    const res = await api.getMessages('?limit=200');
    if (res.ok && res.data?.success) {
      setRows(res.data.data || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll every 4s while real-time is on.
  useEffect(() => {
    if (!realtime) {
      if (timer.current) clearInterval(timer.current);
      return undefined;
    }
    timer.current = setInterval(load, 4000);
    return () => clearInterval(timer.current);
  }, [realtime, load]);

  const filtered = rows.filter((r) => {
    if (directionFilter !== 'All' && r.direction !== directionFilter.toLowerCase()) return false;
    const failed = r.status === 'failed' || r.status === 'poisoned';
    if (!showFailed && failed) return false;
    if (!showSuccess && !failed) return false;
    return true;
  });

  const toggleRow = (id) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const fmt = (iso) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  // Export the currently-filtered message log to CSV (real replacement for the old
  // toolbar "Export Logs" stub).
  const exportLogs = () => {
    if (filtered.length === 0) return;
    const cols = ['timestamp', 'direction', 'topic', 'source', 'dest', 'status', 'messageId'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...filtered.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `bus-messages-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Trading Network Console</div>
          <div className="page-subtitle">Live message flow through the Integration Bus</div>
        </div>
        <div className="flex gap-8 items-center">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem', cursor: 'pointer' }}>
            <span className="pulse-indicator" style={{ animationPlayState: realtime ? 'running' : 'paused' }}></span>
            {' '}Real-time
            <input type="checkbox" checked={realtime} onChange={(e) => setRealtime(e.target.checked)} style={{ accentColor: 'var(--primary)' }} />
          </label>
          <button className="btn btn-sm btn-outline" onClick={exportLogs} disabled={filtered.length === 0}>Export Logs</button>
          <button className="btn btn-sm btn-outline" onClick={load}>Refresh</button>
        </div>
      </div>

      <div className="page-body">
        {/* Dead Letter Queue — live data + manual replay */}
        <DeadLetterPanel />

        <div className="flex gap-12 mb-16 items-center" style={{ flexWrap: 'wrap' }}>
          <select style={{ minWidth: 150 }} value={directionFilter} onChange={(e) => setDirectionFilter(e.target.value)}>
            <option value="All">All directions</option>
            <option value="In">Inbound (in)</option>
            <option value="Out">Outbound (out)</option>
          </select>
          <div className="flex gap-8">
            <label className="check-item" style={{ padding: 0 }}>
              <input type="checkbox" checked={showSuccess} onChange={(e) => setShowSuccess(e.target.checked)} />
              <span style={{ fontSize: '.78rem' }}>Success</span>
            </label>
            <label className="check-item" style={{ padding: 0 }}>
              <input type="checkbox" checked={showFailed} onChange={(e) => setShowFailed(e.target.checked)} />
              <span style={{ fontSize: '.78rem' }}>Failed</span>
            </label>
          </div>
          <span style={{ fontSize: '.78rem', color: 'var(--text-dim)' }}>{filtered.length} message(s)</span>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Dir</th>
                <th>Topic</th>
                <th>Source</th>
                <th>Destination</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row, idx) => {
                const id = `${row.messageId}-${row.direction}-${idx}`;
                const failed = row.status === 'failed' || row.status === 'poisoned';
                return (
                  <React.Fragment key={id}>
                    <tr
                      style={{ borderLeft: failed ? '3px solid var(--error)' : undefined, cursor: 'pointer' }}
                      onClick={() => toggleRow(id)}
                    >
                      <td style={{ fontFamily: 'monospace', fontSize: '.76rem', color: 'var(--text-dim)' }}>{fmt(row.timestamp)}</td>
                      <td style={{ color: 'var(--primary)', fontWeight: 600 }}>{row.direction === 'in' ? '▼ in' : '▲ out'}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: '.78rem' }}>{row.topic}</td>
                      <td style={{ fontSize: '.8rem' }}>{row.source || '—'}</td>
                      <td style={{ fontSize: '.8rem' }}>{row.dest || '—'}</td>
                      <td><span className={`badge ${statusBadge(row.status)}`}>{row.status}</span></td>
                      <td><button className="btn btn-ghost btn-sm" style={{ fontSize: '.75rem' }} onClick={(e) => { e.stopPropagation(); toggleRow(id); }}>Payload</button></td>
                    </tr>
                    {expandedRows.has(id) && (
                      <tr className="expandable-content show">
                        <td colSpan={7}>
                          <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>
                            Payload — message {row.messageId}
                          </div>
                          <pre className="json-block" style={{ maxHeight: 280, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                            {JSON.stringify(row.payload, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 28 }}>
                  No messages yet. Trigger a flow (the bus must be running, HUB_ENABLED=true).
                </td></tr>
              )}
              {loading && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 28 }}>Loading…</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
