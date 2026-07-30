import { useState, useEffect, useCallback } from 'react';
import { api } from '../../services/api';
import Button from '../ui/Button';
import { useToast } from '../../hooks/useToast';
import { SkeletonLines } from '../layout/Skeleton';
import TableFrame from '../ui/TableFrame';

// Dead Letter Queue panel (T-04 manual replay). Lists real dead-lettered
// messages and lets an operator replay them — single row or all at once.
export default function DeadLetterPanel({ fill = false }) {
  const { showToast } = useToast();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  // Which async action is in flight — a single `busy` flag made every button in the
  // panel show a spinner, so clicking "Replay all" also claimed to be "Refreshing".
  const [busyAction, setBusyAction] = useState(null); // null | 'all' | `one:${id}`
  const [statusFilter, setStatusFilter] = useState('All');
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api.getDeadLetters();
    setRows(res.ok && Array.isArray(res.data?.data) ? res.data.data : []);
    setLoading(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- loads data on mount via a reusable async loader (data fetch, not derived-state-in-effect)
  useEffect(() => { load(); }, [load]);

  const outcomeToast = (result) => {
    if (result === 'resolved') showToast('Message replayed and delivered ✓', 'success');
    else if (result === 'retried') showToast('Replay failed — retry count bumped', 'warning');
    else if (result === 'poisoned') showToast('Marked poisoned (max retries reached)', 'error');
    else showToast('Entry was not replayable', 'info');
  };

  const replayOne = async (id) => {
    setBusyAction(`one:${id}`);
    const res = await api.replayDeadLetter(id);
    outcomeToast(res.data?.data?.result);
    await load();
    setBusyAction(null);
  };

  const replayAll = async () => {
    setBusyAction('all');
    const res = await api.replayAllDeadLetters();
    const s = res.data?.data;
    showToast(s ? `Replay done — ${s.resolved} resolved, ${s.retried} retried, ${s.poisoned} poisoned` : 'Replay failed', 'info');
    await load();
    setBusyAction(null);
  };

  const statusBadge = (s) =>
    s === 'done' ? 'badge-success' : s === 'poisoned' ? 'badge-error' : s === 'failed' ? 'badge-warning' : 'badge-info';

  const replayable = rows.filter((r) => r.status === 'failed');

  // Client-side filtering (bus/DLQ core untouched — this only narrows the displayed list).
  const q = query.trim().toLowerCase();
  const visible = rows.filter((r) => {
    if (statusFilter !== 'All' && r.status !== statusFilter) return false;
    if (q && !`${r.topic} ${r.destConnectorId} ${r.error}`.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div className={`dlq-panel${fill ? ' dlq-fill' : ''}`} style={{ marginBottom: fill ? 0 : 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 'var(--fs-md)' }}>&#9760;</span>
          <span style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-md)' }}>Dead Letter Queue</span>
          <span className={`badge ${replayable.length ? 'badge-warning' : 'badge-success'}`} style={{ fontSize: 'var(--fs-xs)' }}>
            {replayable.length} replayable
          </span>
        </div>
        <div className="flex gap-8">
          <Button className="btn btn-ghost btn-sm" onClick={load} loading={loading} loadingLabel="Refreshing" disabled={!!busyAction} title="Refresh">&#8635; Refresh</Button>
          <Button className="btn btn-primary btn-sm" onClick={replayAll} loading={busyAction === 'all'} loadingLabel="Replaying" disabled={!!busyAction || replayable.length === 0}>&#9654; Replay all</Button>
        </div>
      </div>

      {rows.length > 0 && (
        <div className="flex gap-8 items-center mb-12" style={{ flexWrap: 'wrap' }}>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ minWidth: 130 }}>
            <option value="All">All statuses</option>
            <option value="failed">Failed</option>
            <option value="poisoned">Poisoned</option>
            <option value="done">Done</option>
            <option value="processing">Processing</option>
          </select>
          <input
            type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search topic / destination / error"
            style={{ minWidth: 240, flex: 1 }}
          />
          {(statusFilter !== 'All' || query) && (
            <button className="btn btn-ghost btn-sm" onClick={() => { setStatusFilter('All'); setQuery(''); }}>Clear</button>
          )}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 16 }}><SkeletonLines lines={3} /></div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)' }}>
          No dead-lettered messages. &#127881; Failed hub deliveries will appear here for replay.
        </div>
      ) : (
        <TableFrame label="Dead-letter queue">
          <table>
            <thead>
              <tr>
                <th scope="col">Time</th><th scope="col">Topic</th><th scope="col">Destination</th><th scope="col">Error</th><th scope="col">Retries</th><th scope="col">Status</th><th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-dim)', padding: 16 }}>No messages match the filter.</td></tr>
              )}
              {visible.map((r) => (
                <tr key={r.id} style={{ borderLeft: r.status === 'failed' ? '3px solid var(--warning)' : undefined }}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                    {new Date(r.createdAt).toLocaleString()}
                  </td>
                  <td style={{ fontSize: 'var(--fs-sm)' }}>{r.topic}</td>
                  <td style={{ fontSize: 'var(--fs-sm)' }}>{r.destConnectorId}</td>
                  <td style={{ fontSize: 'var(--fs-sm)', color: 'var(--error-on)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.error}>
                    {r.error}
                  </td>
                  <td style={{ textAlign: 'center' }}>{r.retryCount}</td>
                  <td><span className={`badge ${statusBadge(r.status)}`}>{r.status}</span></td>
                  <td>
                    <Button
                      className="btn btn-sm btn-primary"
                      style={{ fontSize: 'var(--fs-xs)', padding: '2px 8px' }}
                      loading={busyAction === `one:${r.id}`}
                      loadingLabel="Replaying"
                      disabled={!!busyAction || r.status !== 'failed'}
                      onClick={() => replayOne(r.id)}
                    >
                      &#9654; Replay
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      )}
    </div>
  );
}
