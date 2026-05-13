import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { monitorData } from '../../data/monitorData';

const statusBadgeMap = {
  Success: 'badge-success',
  Failed: 'badge-error',
  Partial: 'badge-warning',
  Processing: 'badge-info',
};

export default function MonitorPage() {
  const navigate = useNavigate();
  const { openDetailPane } = useDetailPane();
  const { showToast } = useToast();
  const [expandedRows, setExpandedRows] = useState(new Set());
  const [adapterFilter, setAdapterFilter] = useState('All Adapters');
  const [dateFrom, setDateFrom] = useState('2026-04-02');
  const [dateTo, setDateTo] = useState('2026-04-02');
  const [showSuccess, setShowSuccess] = useState(true);
  const [showFailed, setShowFailed] = useState(true);
  const [showPartial, setShowPartial] = useState(true);
  const [realtime, setRealtime] = useState(true);

  const uniqueAdapters = ['All Adapters', ...new Set(monitorData.map((r) => r.adapter))];

  const filteredData = monitorData.filter((row) => {
    if (adapterFilter !== 'All Adapters' && row.adapter !== adapterFilter) return false;
    if (!showSuccess && row.status === 'Success') return false;
    if (!showFailed && row.status === 'Failed') return false;
    if (!showPartial && row.status === 'Partial') return false;
    return true;
  });

  const toggleRow = (idx) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  const handleTicket = (adapterName) => {
    showToast(`Ticket form opened for ${adapterName}`, 'info');
  };

  const handleEscalate = (adapterName) => {
    showToast(`Escalation initiated for ${adapterName}`, 'warning');
  };

  const handleMonitorDetail = (row, idx) => {
    openDetailPane(
      'Message Detail',
      <div>
        <div className="grid-2 mb-16">
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Adapter</div>
            <span className="clickable">{row.adapter}</span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Timestamp</div>
            2026-04-02 {row.time}
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Records</div>
            {row.records}
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Duration</div>
            {row.dur}
          </div>
        </div>
        <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Payload</div>
        <div className="json-block mb-16">
          {'{'}<br />
          &nbsp;&nbsp;<span className="json-key">"messageId"</span>: <span className="json-string">"msg_{String(idx + 1).padStart(4, '0')}"</span>,<br />
          &nbsp;&nbsp;<span className="json-key">"adapter"</span>: <span className="json-string">"{row.adapter}"</span>,<br />
          &nbsp;&nbsp;<span className="json-key">"recordCount"</span>: <span className="json-number">{row.records}</span>,<br />
          &nbsp;&nbsp;<span className="json-key">"batchSize"</span>: <span className="json-number">100</span>,<br />
          &nbsp;&nbsp;<span className="json-key">"success"</span>: <span className="json-bool">true</span><br />
          {'}'}
        </div>
        <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Mapping Trace</div>
        <div style={{ fontSize: '.82rem' }}>
          <div>key &rarr; ExternalId <span className="badge badge-success">OK</span></div>
          <div>summary &rarr; Title <span className="badge badge-success">OK</span></div>
          <div>status.name &rarr; Status <span className="badge badge-success">OK</span></div>
          <div>assignee &rarr; AssignedTo <span className="badge badge-success">OK</span></div>
        </div>
      </div>,
      <>
        <a className="clickable" onClick={() => navigate('/monitor')}>Trading Console</a> &raquo; msg_{String(idx + 1).padStart(4, '0')}
      </>
    );
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Trading Network Console</div>
          <div className="page-subtitle">Message Monitor</div>
        </div>
        <div className="flex gap-8 items-center">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '.82rem', cursor: 'pointer' }}>
            <span
              className="pulse-indicator"
              style={{ animationPlayState: realtime ? 'running' : 'paused' }}
            ></span>
            {' '}Real-time
            <input
              type="checkbox"
              checked={realtime}
              onChange={(e) => setRealtime(e.target.checked)}
              style={{ accentColor: 'var(--primary)' }}
            />
          </label>
        </div>
      </div>

      <div className="flex gap-12 mb-16 items-center" style={{ flexWrap: 'wrap' }}>
        <select
          style={{ minWidth: 180 }}
          value={adapterFilter}
          onChange={(e) => setAdapterFilter(e.target.value)}
        >
          {uniqueAdapters.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
          style={{ maxWidth: 160 }}
        />
        <span style={{ color: 'var(--text-dim)' }}>to</span>
        <input
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
          style={{ maxWidth: 160 }}
        />
        <div className="flex gap-8">
          <label className="check-item" style={{ padding: 0 }}>
            <input type="checkbox" checked={showSuccess} onChange={(e) => setShowSuccess(e.target.checked)} />
            <span style={{ fontSize: '.78rem' }}>Success</span>
          </label>
          <label className="check-item" style={{ padding: 0 }}>
            <input type="checkbox" checked={showFailed} onChange={(e) => setShowFailed(e.target.checked)} />
            <span style={{ fontSize: '.78rem' }}>Failed</span>
          </label>
          <label className="check-item" style={{ padding: 0 }}>
            <input type="checkbox" checked={showPartial} onChange={(e) => setShowPartial(e.target.checked)} />
            <span style={{ fontSize: '.78rem' }}>Partial</span>
          </label>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Source</th>
              <th></th>
              <th>Destination</th>
              <th>Adapter</th>
              <th>Status</th>
              <th>Records</th>
              <th>Duration</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filteredData.map((row, idx) => {
              const failed = row.status === 'Failed';
              const isProcessing = row.status === 'Processing';
              const originalIdx = monitorData.indexOf(row);

              return (
                <React.Fragment key={originalIdx}>
                  <tr
                    style={{
                      borderLeft: failed ? '3px solid var(--error)' : undefined,
                      cursor: 'pointer',
                    }}
                    onClick={() => toggleRow(originalIdx)}
                  >
                    <td style={{ fontFamily: 'monospace', fontSize: '.78rem', color: 'var(--text-dim)' }}>
                      2026-04-02 {row.time}
                    </td>
                    <td className="clickable" onClick={(e) => e.stopPropagation()}>
                      {row.src}
                    </td>
                    <td style={{ color: 'var(--primary)' }}>{row.dir}</td>
                    <td>{row.dest}</td>
                    <td style={{ fontSize: '.8rem' }} className="clickable" onClick={(e) => e.stopPropagation()}>
                      {row.adapter}
                    </td>
                    <td>
                      {isProcessing && (
                        <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', fontSize: '.7rem' }}>&#9696;</span>
                      )}{' '}
                      <span className={`badge ${statusBadgeMap[row.status]}`}>{row.status}</span>
                    </td>
                    <td>{row.records.toLocaleString()}</td>
                    <td>{row.dur}</td>
                    <td>
                      {failed ? (
                        <>
                          <button
                            className="btn btn-sm btn-danger"
                            style={{ fontSize: '.7rem', padding: '2px 6px' }}
                            onClick={(e) => { e.stopPropagation(); handleTicket(row.adapter); }}
                          >
                            Ticket
                          </button>{' '}
                          <button
                            className="btn btn-sm btn-outline"
                            style={{ fontSize: '.7rem', padding: '2px 6px' }}
                            onClick={(e) => { e.stopPropagation(); handleEscalate(row.adapter); }}
                          >
                            Escalate
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={(e) => { e.stopPropagation(); handleMonitorDetail(row, originalIdx); }}
                          style={{ fontSize: '.75rem' }}
                          title="View Details"
                        >
                          Details
                        </button>
                      )}
                    </td>
                  </tr>
                  {expandedRows.has(originalIdx) && (
                    <tr className="expandable-content show">
                      <td colSpan={9}>
                        <div className="grid-2">
                          <div>
                            <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>
                              Payload Sample
                            </div>
                            <div className="json-block">
                              {'{'}<br />
                              &nbsp;&nbsp;<span className="json-key">"messageId"</span>: <span className="json-string">"msg_{String(originalIdx + 1).padStart(4, '0')}_{row.time.replace(/:/g, '')}"</span>,<br />
                              &nbsp;&nbsp;<span className="json-key">"adapter"</span>: <span className="json-string">"{row.adapter}"</span>,<br />
                              &nbsp;&nbsp;<span className="json-key">"recordCount"</span>: <span className="json-number">{row.records}</span>,<br />
                              &nbsp;&nbsp;<span className="json-key">"success"</span>: <span className="json-bool">{String(!failed)}</span><br />
                              {'}'}
                            </div>
                          </div>
                          <div>
                            <div style={{ fontSize: '.78rem', color: 'var(--text-dim)', marginBottom: 6, fontWeight: 600 }}>
                              Field Mapping Trace
                            </div>
                            <div style={{ fontSize: '.8rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                              <div>key &rarr; ExternalId <span className="badge badge-success">OK</span></div>
                              <div>summary &rarr; Title <span className="badge badge-success">OK</span></div>
                              <div>status.name &rarr; Status <span className="badge badge-success">OK</span></div>
                              {failed ? (
                                <div>* &rarr; * <span className="badge badge-error">Auth Error</span></div>
                              ) : (
                                <div>assignee &rarr; AssignedTo <span className="badge badge-success">OK</span></div>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
