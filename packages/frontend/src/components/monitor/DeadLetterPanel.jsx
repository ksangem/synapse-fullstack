import { useState, useEffect, useCallback } from 'react';
import { api } from '../../services/api';
import { useToast } from '../../hooks/useToast';

// Dead Letter Queue panel (T-04 manual replay). Lists real dead-lettered
// messages and lets an operator replay them — single row or all at once.
export default function DeadLetterPanel() {
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.getDeadLetters();
    setRows(res.ok && Array.isArray(res.data?.data) ? res.data.data : []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const outcomeToast = (result) => {
    if (result === 'resolved') showToast('Message replayed and delivered ✓', 'success');
    else if (result === 'retried') showToast('Replay failed — retry count bumped', 'warning');
    else if (result === 'poisoned') showToast('Marked poisoned (max retries reached)', 'error');
    else showToast('Entry was not replayable', 'info');
  };

  const replayOne = async (id) => {
    setBusy(true);
    const res = await api.replayDeadLetter(id);
    outcomeToast(res.data?.data?.result);
    await load();
    setBusy(false);
  };

  const replayAll = async () => {
    setBusy(true);
    const res = await api.replayAllDeadLetters();
    const s = res.data?.data;
    showToast(s ? `Replay done — ${s.resolved} resolved, ${s.retried} retried, ${s.poisoned} poisoned` : 'Replay failed', 'info');
    await load();
    setBusy(false);
  };

  const statusBadge = (s) =>
    s === 'done' ? 'badge-success' : s === 'poisoned' ? 'badge-error' : s === 'failed' ? 'badge-warning' : 'badge-info';

  const replayable = rows.filter((r) => r.status === 'failed');

  return (
    <div className="card" style={{ marginBottom: 20, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: '1.05rem' }}>&#9760;</span>
          <span style={{ fontWeight: 700, fontSize: '.95rem' }}>Dead Letter Queue</span>
          <span className={`badge ${replayable.length ? 'badge-warning' : 'badge-success'}`} style={{ fontSize: '.7rem' }}>
            {replayable.length} replayable
          </span>
        </div>
        <div className="flex gap-8">
          <button className="btn btn-ghost btn-sm" onClick={load} disabled={busy} title="Refresh">&#8635; Refresh</button>
          <button className="btn btn-primary btn-sm" onClick={replayAll} disabled={busy || replayable.length === 0}>&#9654; Replay all</button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)' }}>Loading dead-letter queue…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)' }}>
          No dead-lettered messages. &#127881; Failed hub deliveries will appear here for replay.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th><th>Topic</th><th>Destination</th><th>Error</th><th>Retries</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderLeft: r.status === 'failed' ? '3px solid var(--warning)' : undefined }}>
                  <td style={{ fontFamily: 'monospace', fontSize: '.75rem', color: 'var(--text-dim)' }}>
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td style={{ fontSize: '.8rem' }}>{r.topic}</td>
                  <td style={{ fontSize: '.8rem' }}>{r.destConnectorId}</td>
                  <td style={{ fontSize: '.78rem', color: 'var(--error)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error}>
                    {r.error}
                  </td>
                  <td style={{ textAlign: 'center' }}>{r.retryCount}</td>
                  <td><span className={`badge ${statusBadge(r.status)}`}>{r.status}</span></td>
                  <td>
                    <button
                      className="btn btn-sm btn-primary"
                      style={{ fontSize: '.7rem', padding: '2px 8px' }}
                      disabled={busy || r.status !== 'failed'}
                      onClick={() => replayOne(r.id)}
                    >
                      &#9654; Replay
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
