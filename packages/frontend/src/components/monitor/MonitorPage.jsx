import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../../services/api';
import DeadLetterPanel from './DeadLetterPanel';
import { SkeletonTableRows } from '../layout/Skeleton';
import StatStrip from '../ui/StatStrip';
import Icon from '../ui/Icon';
import TableFrame from '../ui/TableFrame';
import { endpoint } from '../../services/integrationMap';
import { useToast } from '../../hooks/useToast';

/* One classifier, three consumers: the row rail, the status badge and the
   summary tiles. Bus statuses are an open set, so anything unrecognised lands in
   "in flight" rather than being silently dropped from the counts. The server
   classifies identically (api/messages.routes.ts) so tiles and table agree. */
function classify(status) {
  if (status === 'done') return { key: 'delivered', tone: 'ok', badge: 'badge-success' };
  if (status === 'failed' || status === 'poisoned') return { key: 'failed', tone: 'fail', badge: 'badge-error' };
  if (status === 'processing') return { key: 'inflight', tone: 'info', badge: 'badge-info' };
  return { key: 'inflight', tone: 'warn', badge: 'badge-warning' }; // pending / received / …
}

const shortId = (v) => (v ? `${String(v).slice(0, 8)}…` : '—');
const PAGE_SIZE = 50;
const EXPORT_CAP = 500;           // matches the endpoint's hard limit

/* Stable identity for a feed row. This used to include the row's index within
   the current page slice — with a 4s poll prepending new messages, every index
   shifted and an expanded payload re-bound to a DIFFERENT message on the next
   tick. messageId+direction+dest is the outbox's own uniqueness rule. */
const rowKey = (r) => `${r.messageId}-${r.direction}-${r.dest ?? ''}`;

export default function MonitorPage() {
  // Which view is shown — the live message log ('network') or the dead-letter queue ('dlq').
  const [view, setView] = useState('network');
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [directionFilter, setDirectionFilter] = useState('All');
  const [outcome, setOutcome] = useState('all');   // all | delivered | failed | inflight
  const [realtime, setRealtime] = useState(true);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ delivered: 0, failed: 0, inflight: 0, total: 0 });
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connectionFilter, setConnectionFilter] = useState('All');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState({ col: 'time', dir: 'desc' });
  /* connector UUID → human name, for the connector kinds in the expanded row.
     The feed stores raw ids, and a wall of UUIDs is nothing an operator can act on. */
  const [nameById, setNameById] = useState({});
  /* integrationId → its destination targets. Only a connection that fans out to
     more than one target needs the Target column; for the rest it is one
     repeated value, so it stays blank. */
  const [targetsById, setTargetsById] = useState({});
  /* integrationId → its qualified source/destination ("site.list (SharePoint)").
     Built once alongside the target map — both come out of the same fetch. */
  const [endsById, setEndsById] = useState({});
  const { showToast } = useToast();
  const timer = useRef(null);
  /* Ids seen on the previous poll — rows not in this set arrived since, and only
     those flash. Animating the whole table every 4s tick would strobe. */
  const seenIds = useRef(null);
  const [newIds, setNewIds] = useState(() => new Set());

  /* Filtering, sorting and paging all run server-side. They used to run in the
     browser over a fixed `?limit=200` window, so "1–50 of N" could never exceed
     200 while the page implied it was showing everything. */
  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String(page * PAGE_SIZE));
    p.set('sort', sort.col);
    p.set('dir', sort.dir);
    if (directionFilter !== 'All') p.set('direction', directionFilter.toLowerCase());
    if (outcome !== 'all') p.set('outcome', outcome);
    if (connectionFilter !== 'All') p.set('connection', connectionFilter);
    if (dateFrom) p.set('from', dateFrom);
    if (dateTo) p.set('to', dateTo);
    return `?${p.toString()}`;
  }, [page, sort, directionFilter, outcome, connectionFilter, dateFrom, dateTo]);

  const load = useCallback(async () => {
    const res = await api.getMessages(query);
    if (res.ok && res.data?.success) {
      const next = res.data.data || [];
      const ids = new Set(next.map((r) => r.messageId));
      // First load establishes the baseline — everything is "new" then, which is
      // not information, so nothing flashes until we have something to compare to.
      setNewIds(seenIds.current
        ? new Set(next.filter((r) => !seenIds.current.has(r.messageId)).map((r) => r.messageId))
        : new Set());
      seenIds.current = ids;
      setRows(next);
      setTotal(res.data.total ?? next.length);
      if (res.data.counts) setCounts(res.data.counts);
      if (Array.isArray(res.data.connections)) setConnections(res.data.connections);
    }
    setLoading(false);
  }, [query]);

  // Refetches whenever the server-side query changes (filters, sort, page).
  useEffect(() => { load(); }, [load]);

  // Names and targets change rarely — fetched once, not on every 4s poll.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [conn, integ] = await Promise.all([api.getConnectors(), api.getConnected()]);
      if (!alive) return;
      const map = {};
      for (const c of (conn.ok && Array.isArray(conn.data?.data) ? conn.data.data : [])) {
        if (c.connectorId) map[c.connectorId] = c.name || c.key;
      }
      const targets = {};
      const ends = {};
      for (const i of (integ.ok && Array.isArray(integ.data?.data) ? integ.data.data : [])) {
        if (!i.integrationId) continue;
        // The qualified endpoints of the connection this message belongs to. A
        // connector name ("SharePoint") is the same on every row out of the same
        // site; `site.list` is what distinguishes them.
        ends[i.integrationId] = {
          source: endpoint(i.fieldMappings, 'source').label,
          dest: endpoint(i.fieldMappings, 'dest').label,
        };
        const list = Array.isArray(i.fieldMappings?.targets) ? i.fieldMappings.targets : [];
        // The label an operator would recognise: what they named the target, else
        // the table/list it writes to, else the raw id.
        targets[i.integrationId] = {
          count: list.length || 1,
          labels: Object.fromEntries(list.map((t, n) => [
            t.targetId || `t${n + 1}`,
            t.label || t.config?.pgTable || t.config?.destTable || t.config?.listName || t.targetId || `t${n + 1}`,
          ])),
        };
      }
      setNameById(map);
      setTargetsById(targets);
      setEndsById(ends);
    })();
    return () => { alive = false; };
  }, []);

  // Poll every 4s while real-time is on.
  useEffect(() => {
    if (!realtime) {
      if (timer.current) clearInterval(timer.current);
      return undefined;
    }
    timer.current = setInterval(load, 4000);
    return () => clearInterval(timer.current);
  }, [realtime, load]);

  const nameOf = useCallback(
    (id) => (id ? nameById[id] || shortId(id) : null),
    [nameById],
  );

  /* The Target cell. Blank unless the connection actually fans out — with one
     target it is the same value on every row, and 'legacy' is the synthesised
     id of a single-destination connection, which names nothing. */
  const targetOf = useCallback((row) => {
    if (!row.targetId || row.targetId === 'legacy') return null;
    const t = targetsById[row.integrationId];
    if (t && t.count < 2) return null;
    return t?.labels?.[row.targetId] ?? row.targetId;
  }, [targetsById]);

  const resolved = useMemo(() => rows.map((r) => {
    const targetName = targetOf(r);
    const ends = endsById[r.integrationId];
    return {
      r,
      k: classify(r.status),
      // The server resolves the name; an id with no surviving connection (deleted
      // since the message was sent) still identifies it better than a dash.
      connName: r.connection || (r.integrationId ? shortId(r.integrationId) : null),
      targetName,
      /* The connection's qualified endpoints first — "site.list (SharePoint)" rather
         than "SharePoint", which is the same value on every row out of that site.
         The connector-name lookup stays as the fallback for a message whose
         connection has since been deleted. */
      srcName: ends?.source || nameOf(r.source) || '—',
      // A fan-out row names its OWN target; only then the connection's single dest.
      destName: targetName || ends?.dest || (r.dest ? (nameById[r.dest] || r.dest) : '—'),
    };
  }), [rows, targetOf, nameOf, nameById, endsById]);

  /* The Target column earns its place only when something on the page fans out.
     No connection multi-targets today, so a permanent column would be a full
     width of dashes; it appears the moment one does. */
  const showTarget = useMemo(() => resolved.some((x) => x.targetName), [resolved]);
  const colCount = showTarget ? 7 : 6;

  // Options come from the server's DISTINCT over the whole feed, so the list
  // does not change as you page.
  const connectionOptions = useMemo(
    () => connections.map((c) => ({ id: c.id, label: c.name || shortId(c.id) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [connections],
  );

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const firstRow = total === 0 ? 0 : safePage * PAGE_SIZE + 1;

  const toggleRow = (id) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Clicking a header sorts by it; clicking the active one flips direction.
  const toggleSort = (col) => {
    setSort((s) => ({ col, dir: s.col === col && s.dir === 'desc' ? 'asc' : 'desc' }));
    setPage(0);
  };
  const ariaSort = (col) => (sort.col === col ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');

  // Time leads (that is what you scan on a live feed); the full stamp is on hover.
  const fmtTime = (iso) => {
    try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
  };
  const fmtFull = (iso) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  /* Exports every row matching the current filters, not just the visible page —
     so it refetches rather than serialising `rows`. The endpoint caps at 500;
     when that bites we say so instead of quietly writing a short file. */
  const exportLogs = async () => {
    if (total === 0) return;
    const p = new URLSearchParams(query);
    p.set('limit', String(EXPORT_CAP));
    p.set('offset', '0');
    const res = await api.getMessages(`?${p.toString()}`);
    if (!res.ok || !res.data?.success) { showToast('Could not load messages to export', 'error'); return; }
    const all = res.data.data || [];
    const cols = ['timestamp', 'direction', 'topic', 'connection', 'targetId', 'source', 'dest', 'status', 'runId', 'messageId'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...all.map((r) => cols.map((k) => esc(r[k])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `bus-messages-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(all.length < total
      ? `Exported the most recent ${all.length} of ${total} matching messages (${EXPORT_CAP} max per export)`
      : `Exported ${all.length} messages`, all.length < total ? 'warning' : 'success');
  };

  const clearFilters = () => {
    setDirectionFilter('All'); setOutcome('all'); setConnectionFilter('All');
    setDateFrom(''); setDateTo(''); setPage(0);
  };
  const filtersOn = directionFilter !== 'All' || outcome !== 'all' || connectionFilter !== 'All' || dateFrom || dateTo;

  /* No contextual-toolbar actions here by design. Export / Clear filters /
     Real-time each used to exist BOTH in the toolbar and on the page — and the
     page versions are strictly better: the toggle shows its state, Export
     disables when there is nothing to export, and Clear filters appears only
     when a filter is on. The toolbar band still renders its breadcrumb, as it
     already does on Alerts, Wizard and My Connections. */

  const th = (col, label, extra) => (
    <th scope="col" aria-sort={ariaSort(col)} {...extra}>
      <button type="button" className="th-sort" onClick={() => toggleSort(col)}>
        {label}
        <span className="th-sort-icon" aria-hidden="true">
          {sort.col === col ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
        </span>
      </button>
    </th>
  );

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Message Monitor</h1>
          <div className="page-subtitle">
            {loading ? 'Loading the bus feed…'
              : counts.failed
                ? <><strong>{counts.failed}</strong> failed of {counts.total} messages on the bus</>
                : <>{counts.total} messages on the bus · none failed</>}
          </div>
        </div>
        <div className="flex gap-8 items-center">
          <div className="seg-toggle sm">
            <button className={view === 'network' ? 'active' : ''} onClick={() => setView('network')}>Network</button>
            <button className={view === 'dlq' ? 'active' : ''} onClick={() => setView('dlq')}>DLQ</button>
          </div>
          <label className="realtime-toggle">
            <span className="pulse-indicator" style={{ animationPlayState: realtime ? 'running' : 'paused' }}></span>
            Real-time
            <input type="checkbox" checked={realtime} onChange={(e) => setRealtime(e.target.checked)} />
          </label>
          <button className="btn btn-sm btn-outline" onClick={exportLogs} disabled={total === 0}>
            <Icon name="download" />Export
          </button>
          <button className="btn btn-sm btn-outline" onClick={load}><Icon name="refresh" />Refresh</button>
        </div>
      </div>

      <div className="page-body fit">
        {view === 'dlq' && <DeadLetterPanel fill />}

        {view === 'network' && (
        <>
        {/* The feed used to open with 200 undifferentiated rows; the strip states
            the outcome mix first and is also how you filter to one of them.
            Counts are over the whole feed under the non-outcome filters. */}
        <StatStrip
          active={outcome}
          onFilter={(v) => { setOutcome(v); setPage(0); }}
          items={[
            { key: 'all', label: 'Messages', value: counts.total, tone: 'info', sub: 'Matching current filters' },
            { key: 'delivered', label: 'Delivered', value: counts.delivered, tone: 'ok', filter: 'delivered', sub: 'Reached destination' },
            { key: 'failed', label: 'Failed', value: counts.failed, tone: 'fail', filter: 'failed', sub: 'Dead-lettered or poisoned' },
            { key: 'inflight', label: 'In flight', value: counts.inflight, tone: 'warn', filter: 'inflight', sub: 'Pending or processing' },
          ]}
        />

        <div className="filter-bar mb-16">
          <select aria-label="Filter by direction" value={directionFilter}
            onChange={(e) => { setDirectionFilter(e.target.value); setPage(0); }}>
            <option value="All">All directions</option>
            <option value="In">Inbound (in)</option>
            <option value="Out">Outbound (out)</option>
          </select>
          <select aria-label="Filter by connection" value={connectionFilter}
            onChange={(e) => { setConnectionFilter(e.target.value); setPage(0); }}>
            <option value="All">All connections</option>
            {connectionOptions.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <label className="filter-date">
            From <input type="date" aria-label="From date" value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(0); }} />
          </label>
          <label className="filter-date">
            To <input type="date" aria-label="To date" value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(0); }} />
          </label>
          {filtersOn && <button type="button" className="link-btn" onClick={clearFilters}>Clear filters</button>}
          <span className="filter-count">
            {total === 0 ? '0 messages' : `${firstRow}–${firstRow + rows.length - 1} of ${total}`}
          </span>
        </div>

        <TableFrame label="Message feed">
          <table className="data-table">
            <thead>
              <tr>
                {th('time', 'Time')}
                {th('direction', 'Dir')}
                {th('topic', 'Topic')}
                {/* The connection, not the connector pair. Several connections
                    run the same source→destination kinds, so connector names
                    cannot tell you which one a failure came from — and the
                    connection is the only thing you can then act on. Its name is
                    resolved server-side AFTER paging, so it is not sortable. */}
                <th scope="col">Connection</th>
                {showTarget && <th scope="col">Target</th>}
                {th('status', 'Status')}
                <th scope="col"><span className="viz-sr-only">Payload</span></th>
              </tr>
            </thead>
            <tbody>
              {resolved.map(({ r: row, k, connName, targetName, srcName, destName }, idx) => {
                const id = rowKey(row);
                const open = expandedRows.has(id);
                return (
                  <React.Fragment key={id}>
                    <tr
                      className={newIds.has(row.messageId) ? 'is-new' : undefined}
                      data-status={k.tone}
                      style={{ '--i': Math.min(idx, 14), cursor: 'pointer' }}
                      onClick={() => toggleRow(id)}
                    >
                      <td className="cell-time" title={fmtFull(row.timestamp)}>{fmtTime(row.timestamp)}</td>
                      <td>
                        <span className={`dir-pill dir-pill--${row.direction}`}>
                          {row.direction === 'in' ? '↓ in' : '↑ out'}
                        </span>
                      </td>
                      <td className="cell-topic" title={row.topic}>{row.topic}</td>
                      <td className="cell-name" title={row.integrationId || ''}>{connName || '—'}</td>
                      {showTarget && <td className="cell-name" title={row.targetId || ''}>{targetName || '—'}</td>}
                      <td><span className={`badge ${k.badge}`}>{row.status}</span></td>
                      <td>
                        {/* One affordance instead of two: the row was clickable
                            AND carried a separate "Payload" button, with nothing
                            showing the row could expand at all. */}
                        <button className="btn btn-ghost btn-xs row-expander" aria-expanded={open}
                          aria-label={`${open ? 'Hide' : 'Show'} payload for message ${row.messageId}`}
                          onClick={(e) => { e.stopPropagation(); toggleRow(id); }}>
                          <span className={`chev${open ? ' is-open' : ''}`} aria-hidden="true">›</span>
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="expandable-content show">
                        <td colSpan={colCount}>
                          <dl className="payload-meta">
                            {/* No longer just the connector kind — the qualified
                                endpoint, so "which SharePoint list" is answered here
                                instead of needing a trip to the Registry. */}
                            <div><dt>Source</dt><dd title={row.source || ''}>{srcName}</dd></div>
                            <div><dt>Destination</dt><dd title={row.dest || ''}>{destName}</dd></div>
                            <div><dt>Run</dt><dd title={row.runId || ''}>{row.runId ? shortId(row.runId) : '—'}</dd></div>
                            <div><dt>Message</dt><dd>{row.messageId}</dd></div>
                          </dl>
                          <div className="payload-head">Payload</div>
                          <pre className="json-block payload-block">
                            {JSON.stringify(row.payload, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {!loading && total === 0 && (
                <tr><td colSpan={colCount} className="table-empty">
                  <div className="table-empty-title">
                    {filtersOn ? 'Nothing matches these filters' : 'No messages on the bus yet'}
                  </div>
                  {filtersOn
                    ? 'Clear or widen the filters to see messages.'
                    : 'Trigger a flow from the Registry — the bus must be running (HUB_ENABLED=true).'}
                </td></tr>
              )}
              {loading && <SkeletonTableRows rows={6} cols={colCount} />}
            </tbody>
          </table>
        </TableFrame>

        {pageCount > 1 && (
          <div className="flex gap-8 items-center mt-16" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-sm btn-outline" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Prev</button>
            <span className="filter-count">Page {safePage + 1} of {pageCount}</span>
            <button className="btn btn-sm btn-outline" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Next</button>
          </div>
        )}
        </>
        )}
      </div>
    </div>
  );
}
