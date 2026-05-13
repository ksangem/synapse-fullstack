import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { dashboardTiles } from '../../data/dashboardTiles';

function AdapterDetailContent({ tile, onNavigate, onShowTicketForm, onShowEscalation, onShowLogs }) {
  const isError = tile.status === 'red';
  const isAmber = tile.status === 'amber';
  const msgs = tile.msgs || 0;

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
          <span className={`badge badge-${isError ? 'error' : isAmber ? 'warning' : 'success'}`}>
            {isError ? 'Error' : isAmber ? 'Paused' : 'Active'}
          </span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Messages Today</div>
          <span style={{ fontSize: '.85rem' }}>{msgs.toLocaleString()}</span>
        </div>
      </div>

      <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Last 5 Runs</div>
      <table className="mb-16">
        <thead>
          <tr><th>Timestamp</th><th>Records</th><th>Duration</th><th>Status</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>10:15:03</td>
            <td>{Math.floor(msgs * 0.4) || 12}</td>
            <td>3.2s</td>
            <td><span className="badge badge-success">Success</span></td>
          </tr>
          <tr>
            <td>10:00:01</td>
            <td>{Math.floor(msgs * 0.3) || 8}</td>
            <td>2.1s</td>
            <td><span className="badge badge-success">Success</span></td>
          </tr>
          <tr>
            <td>09:45:02</td>
            <td>{Math.floor(msgs * 0.5) || 15}</td>
            <td>4.8s</td>
            <td><span className={`badge badge-${isError ? 'error' : 'success'}`}>{isError ? 'Failed' : 'Success'}</span></td>
          </tr>
          <tr>
            <td>09:30:01</td>
            <td>{Math.floor(msgs * 0.2) || 5}</td>
            <td>0.9s</td>
            <td><span className="badge badge-success">Success</span></td>
          </tr>
          <tr>
            <td>09:15:00</td>
            <td>{Math.floor(msgs * 0.35) || 10}</td>
            <td>2.5s</td>
            <td><span className="badge badge-success">Success</span></td>
          </tr>
        </tbody>
      </table>

      <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Error Log</div>
      <div className="json-block mb-16" style={{ fontSize: '.75rem', maxHeight: 120 }}>
        {isError ? (
          <span style={{ color: 'var(--error)' }}>
            Error: OAuth2TokenExpiredError at {tile.src}Connector.authenticate<br />
            HTTP 401 Unauthorized - Token expired or revoked
          </span>
        ) : (
          'No recent errors.'
        )}
      </div>

      <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Config Summary</div>
      <div className="grid-2 mb-16">
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Schedule</div>
          <span style={{ fontSize: '.85rem' }}>Every 15 min</span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Retry Policy</div>
          <span style={{ fontSize: '.85rem' }}>3x Exponential</span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Batch Size</div>
          <span style={{ fontSize: '.85rem' }}>100 records</span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Owner</div>
          <span style={{ fontSize: '.85rem' }} className="clickable">Anita Kumar</span>
        </div>
      </div>

      {isError ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-danger btn-sm" onClick={() => onShowTicketForm(tile.name)}>Create Ticket</button>
          <button className="btn btn-outline btn-sm" onClick={() => onShowEscalation(tile.name)}>Escalate</button>
          <button className="btn btn-ghost btn-sm" onClick={() => onShowLogs(tile.name)}>View Logs</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => onShowLogs(tile.name)}>View Logs</button>
        </div>
      )}
    </>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { openDetailPane } = useDetailPane();
  const { showToast } = useToast();
  const [activeFilter, setActiveFilter] = useState('All');
  const [timeRange, setTimeRange] = useState('Last 24 hours');

  const filters = ['All', 'Active', 'Paused', 'Error'];

  const filteredTiles = dashboardTiles.filter((tile) => {
    if (activeFilter === 'All') return true;
    if (activeFilter === 'Active') return tile.status === 'green';
    if (activeFilter === 'Paused') return tile.status === 'amber';
    if (activeFilter === 'Error') return tile.status === 'red';
    return true;
  });

  const handleShowLogs = (name) => {
    openDetailPane(
      name + ' - Logs',
      <div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-secondary)', marginBottom: 12 }}>
          Showing last 10 log entries for <strong>{name}</strong>
        </div>
        <div className="json-block" style={{ maxHeight: 400, fontSize: '.72rem' }}>
          [10:15:03] INFO  Sync started. Batch: 1/3<br />
          [10:15:04] INFO  Fetched 142 records from source<br />
          [10:15:05] INFO  Transform pipeline: 142 records processed<br />
          [10:15:06] INFO  Upserted 142 records to destination<br />
          [10:15:06] INFO  Sync completed. Duration: 3.2s<br />
          [10:00:01] INFO  Sync started. Batch: 1/1<br />
          [10:00:02] INFO  Fetched 89 records from source<br />
          [10:00:03] INFO  Sync completed. Duration: 2.1s<br />
          [09:45:02] WARN  Partial sync: 3 records skipped (validation)<br />
          [09:30:01] INFO  Sync completed. Duration: 0.9s
        </div>
      </div>,
      <>
        <a className="clickable" onClick={() => navigate('/registry')}>Registry</a> &raquo; {name} &raquo; Logs
      </>
    );
  };

  const handleShowTicketForm = (name) => {
    showToast(`Ticket form opened for ${name}`, 'info');
  };

  const handleShowEscalation = (name) => {
    showToast(`Escalation initiated for ${name}`, 'warning');
  };

  const handleTileClick = (tile) => {
    openDetailPane(
      tile.name,
      <AdapterDetailContent
        tile={tile}
        onNavigate={navigate}
        onShowTicketForm={handleShowTicketForm}
        onShowEscalation={handleShowEscalation}
        onShowLogs={handleShowLogs}
      />,
      <>
        <a className="clickable" onClick={() => navigate('/dashboard')}>Dashboard</a> &raquo; {tile.name}
      </>
    );
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Health Dashboard</div>
          <div className="page-subtitle">Real-time platform overview</div>
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

      {/* KPI Row */}
      <div className="grid-4 mb-20">
        <div className="card kpi-card">
          <div className="kpi-icon">&#9881;</div>
          <div className="kpi-value" onClick={() => navigate('/registry')}>15</div>
          <div className="kpi-label">Total Adapters</div>
          <div className="kpi-sub">
            <span onClick={() => navigate('/registry')}><span className="status-dot green"></span> 12 active</span>
            <span onClick={() => navigate('/registry')}><span className="status-dot amber"></span> 2 paused</span>
            <span onClick={() => navigate('/registry')}><span className="status-dot red"></span> 1 error</span>
          </div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-icon">&#9993;</div>
          <div className="kpi-value" onClick={() => navigate('/monitor')}>5,561</div>
          <div className="kpi-label">Messages Today</div>
          <div className="kpi-sub">
            <span onClick={() => navigate('/monitor')} style={{ color: 'var(--success)' }}>&#9650; 2,847 sent</span>
            <span onClick={() => navigate('/monitor')} style={{ color: 'var(--info)' }}>&#9660; 2,691 received</span>
            <span onClick={() => navigate('/monitor')} style={{ color: 'var(--error)' }}>&#9888; 23 failed</span>
          </div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-icon">&#9201;</div>
          <div className="kpi-value">99.7%</div>
          <div className="kpi-label">System Uptime</div>
          <div className="kpi-sub">
            <span style={{ color: 'var(--success)' }}>&#9650; 0.2% vs last month</span>
          </div>
        </div>
        <div className="card kpi-card">
          <div className="kpi-icon">&#9888;</div>
          <div className="kpi-value" style={{ color: 'var(--warning)' }} onClick={() => navigate('/alerts')}>3</div>
          <div className="kpi-label">Active Alerts</div>
          <div className="kpi-sub">
            <span onClick={() => navigate('/alerts')} style={{ color: 'var(--error)' }}>1 critical</span>
            <span onClick={() => navigate('/alerts')} style={{ color: 'var(--warning)' }}>2 warnings</span>
          </div>
        </div>
      </div>

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

      <div
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}
        className="mb-20"
      >
        {filteredTiles.map((tile, idx) => (
          <div
            key={idx}
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

      {/* Charts Row */}
      <div className="grid-2 mb-20">
        <div className="card">
          <div style={{ fontWeight: 600, fontSize: '.9rem', marginBottom: 12 }}>Message Volume (24h)</div>
          <svg width="100%" height="120" viewBox="0 0 500 120" preserveAspectRatio="none">
            <defs>
              <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity=".3" />
                <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M0,100 L20,95 40,85 60,90 80,70 100,60 120,65 140,50 160,55 180,40 200,45 220,35 240,30 260,40 280,25 300,30 320,20 340,25 360,15 380,20 400,18 420,22 440,15 460,10 480,12 500,8" fill="none" stroke="#6366f1" strokeWidth="2" />
            <path d="M0,100 L20,95 40,85 60,90 80,70 100,60 120,65 140,50 160,55 180,40 200,45 220,35 240,30 260,40 280,25 300,30 320,20 340,25 360,15 380,20 400,18 420,22 440,15 460,10 480,12 500,8 L500,120 L0,120 Z" fill="url(#sparkGrad)" />
            <path d="M0,110 L20,108 40,105 60,106 80,100 100,95 120,98 140,90 160,92 180,85 200,88 220,82 240,80 260,84 280,78 300,80 320,75 340,77 360,72 380,74 400,73 420,75 440,72 460,70 480,71 500,68" fill="none" stroke="#22c55e" strokeWidth="1.5" opacity=".6" />
          </svg>
          <div style={{ display: 'flex', gap: 16, fontSize: '.72rem', color: 'var(--text-dim)', marginTop: 8 }}>
            <span><span style={{ color: '#6366f1' }}>&#9644;</span> Sent</span>
            <span><span style={{ color: '#22c55e' }}>&#9644;</span> Received</span>
          </div>
        </div>
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: '.9rem' }}>Error Trend (7 days)</div>
            <a className="clickable" style={{ fontSize: '.75rem' }} onClick={() => navigate('/alerts')}>View All Alerts &#8594;</a>
          </div>
          <svg width="100%" height="120" viewBox="0 0 500 120" preserveAspectRatio="none">
            <rect x="20" y="80" width="50" height="40" rx="3" fill="#ef4444" opacity=".3" />
            <text x="45" y="75" fill="#ef4444" fontSize="10" textAnchor="middle">12</text>
            <rect x="90" y="70" width="50" height="50" rx="3" fill="#ef4444" opacity=".3" />
            <text x="115" y="65" fill="#ef4444" fontSize="10" textAnchor="middle">18</text>
            <rect x="160" y="90" width="50" height="30" rx="3" fill="#ef4444" opacity=".3" />
            <text x="185" y="85" fill="#ef4444" fontSize="10" textAnchor="middle">8</text>
            <rect x="230" y="60" width="50" height="60" rx="3" fill="#ef4444" opacity=".4" />
            <text x="255" y="55" fill="#ef4444" fontSize="10" textAnchor="middle">23</text>
            <rect x="300" y="85" width="50" height="35" rx="3" fill="#ef4444" opacity=".3" />
            <text x="325" y="80" fill="#ef4444" fontSize="10" textAnchor="middle">11</text>
            <rect x="370" y="75" width="50" height="45" rx="3" fill="#ef4444" opacity=".3" />
            <text x="395" y="70" fill="#ef4444" fontSize="10" textAnchor="middle">15</text>
            <rect x="440" y="55" width="50" height="65" rx="3" fill="#ef4444" opacity=".5" />
            <text x="465" y="50" fill="#ef4444" fontSize="10" textAnchor="middle">23</text>
            <text x="45" y="118" fill="currentColor" fontSize="9" textAnchor="middle" opacity=".5">Mon</text>
            <text x="115" y="118" fill="currentColor" fontSize="9" textAnchor="middle" opacity=".5">Tue</text>
            <text x="185" y="118" fill="currentColor" fontSize="9" textAnchor="middle" opacity=".5">Wed</text>
            <text x="255" y="118" fill="currentColor" fontSize="9" textAnchor="middle" opacity=".5">Thu</text>
            <text x="325" y="118" fill="currentColor" fontSize="9" textAnchor="middle" opacity=".5">Fri</text>
            <text x="395" y="118" fill="currentColor" fontSize="9" textAnchor="middle" opacity=".5">Sat</text>
            <text x="465" y="118" fill="#ef4444" fontSize="9" textAnchor="middle" fontWeight="700">Today</text>
          </svg>
        </div>
      </div>
    </div>
  );
}
