import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { integrations } from '../../data/integrations';

export default function RegistryPage() {
  const navigate = useNavigate();
  const { openDetailPane } = useDetailPane();
  const { showToast } = useToast();
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilters, setActiveFilters] = useState(['All']);

  const filterOptions = ['All', 'Dynamics 365', 'Jira', 'SAP', 'Active', 'Error'];

  const handleFilterClick = (filter) => {
    if (filter === 'All') {
      setActiveFilters(['All']);
    } else {
      setActiveFilters((prev) => {
        const without = prev.filter((f) => f !== 'All');
        if (without.includes(filter)) {
          const next = without.filter((f) => f !== filter);
          return next.length === 0 ? ['All'] : next;
        }
        return [...without, filter];
      });
    }
  };

  const filteredIntegrations = integrations.filter((int) => {
    // Search filter
    if (searchTerm && !int.name.toLowerCase().includes(searchTerm.toLowerCase())) {
      return false;
    }
    // Chip filters
    if (activeFilters.includes('All')) return true;
    let match = false;
    if (activeFilters.includes('Dynamics 365') && (int.src === 'Dynamics 365' || int.dest === 'Dynamics 365')) match = true;
    if (activeFilters.includes('Jira') && (int.src === 'Jira' || int.dest === 'Jira')) match = true;
    if (activeFilters.includes('SAP') && (int.src.includes('SAP') || int.dest.includes('SAP'))) match = true;
    if (activeFilters.includes('Active') && int.status === 'green') match = true;
    if (activeFilters.includes('Error') && int.status === 'red') match = true;
    return match;
  });

  const handleShowVersionHistory = (name) => {
    showToast(`Version history for ${name}`, 'info');
  };

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

  const handleCardClick = (int) => {
    const statusClass = int.status === 'red' ? 'error' : int.status === 'amber' ? 'warning' : 'success';
    const statusLabel = int.status === 'red' ? 'Error' : int.status === 'amber' ? 'Paused' : 'Active';

    openDetailPane(
      int.name,
      <div>
        <div className="grid-2 mb-16">
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Status</div>
            <span className={`badge badge-${statusClass}`}>{statusLabel}</span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Schedule</div>
            <span style={{ fontSize: '.85rem' }}>Every 15 min</span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Owner</div>
            <span style={{ fontSize: '.85rem' }} className="clickable">Anita Kumar</span>
          </div>
          <div>
            <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Created</div>
            <span style={{ fontSize: '.85rem' }}>2026-01-15</span>
          </div>
        </div>

        <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Field Mapping Summary</div>
        <table className="mb-16">
          <thead>
            <tr><th>Source</th><th>Destination</th><th>Transform</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="clickable">key</td>
              <td>Title</td>
              <td><span className="badge badge-primary">Concat</span></td>
            </tr>
            <tr>
              <td className="clickable">assignee.displayName</td>
              <td>AssignedTo</td>
              <td><span className="badge badge-neutral">Direct</span></td>
            </tr>
            <tr>
              <td className="clickable">status.name</td>
              <td>Status</td>
              <td><span className="badge badge-neutral">Direct</span></td>
            </tr>
            <tr>
              <td className="clickable">created</td>
              <td>CreatedDate</td>
              <td><span className="badge badge-primary">DateFmt</span></td>
            </tr>
          </tbody>
        </table>

        <div style={{ fontWeight: 600, fontSize: '.85rem', marginBottom: 8 }}>Recent Runs</div>
        <table>
          <thead>
            <tr><th>Timestamp</th><th>Records</th><th>Duration</th><th>Status</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>2026-04-02 10:15:03</td>
              <td>142</td>
              <td>3.2s</td>
              <td><span className="badge badge-success">Success</span></td>
            </tr>
            <tr>
              <td>2026-04-02 10:00:01</td>
              <td>89</td>
              <td>2.1s</td>
              <td><span className="badge badge-success">Success</span></td>
            </tr>
            <tr>
              <td>2026-04-02 09:45:02</td>
              <td>156</td>
              <td>4.8s</td>
              <td><span className="badge badge-success">Success</span></td>
            </tr>
            <tr>
              <td>2026-04-02 09:30:01</td>
              <td>12</td>
              <td>0.9s</td>
              <td><span className="badge badge-warning">Partial</span></td>
            </tr>
          </tbody>
        </table>

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => handleShowVersionHistory(int.name)}>&#128339; Version History</button>
          <button className="btn btn-ghost btn-sm" onClick={() => handleShowLogs(int.name)}>&#128196; View Logs</button>
        </div>
      </div>,
      <>
        <a className="clickable" onClick={() => navigate('/registry')}>Integration Registry</a> &raquo; {int.name}
      </>
    );
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Integration Registry</div>
          <div className="page-subtitle">All deployed adapters and integrations</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={() => navigate('/wizard')}>+ New Integration</button>
      </div>

      <div className="flex gap-12 mb-16" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="search-bar">
          <span className="search-icon">&#128269;</span>
          <input
            type="text"
            placeholder="Search integrations..."
            style={{ width: 300 }}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="filter-chips">
          {filterOptions.map((f) => (
            <span
              key={f}
              className={`chip${activeFilters.includes(f) ? ' active' : ''}`}
              onClick={() => handleFilterClick(f)}
            >
              {f}
            </span>
          ))}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
        {filteredIntegrations.map((int, idx) => {
          const statusClass = int.status === 'red' ? 'error' : int.status === 'amber' ? 'warning' : 'success';
          const statusLabel = int.status === 'red' ? 'Error' : int.status === 'amber' ? 'Paused' : 'Active';
          const maxSpark = Math.max(...int.sparkData, 1);

          return (
            <div key={idx} className="card integration-card" onClick={() => handleCardClick(int)}>
              <div className="int-header">
                <span
                  className={`status-dot ${int.status}`}
                  onClick={(e) => { e.stopPropagation(); handleCardClick(int); }}
                ></span>
                <span className="int-name">{int.name}</span>
              </div>
              <div style={{ fontSize: '.72rem', color: 'var(--text-dim)', marginBottom: 6 }}>{int.route}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className={`badge badge-${statusClass}`}>{statusLabel}</span>
                <span style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>{int.dept}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 10 }}>
                <div className="sparkline" onClick={(e) => e.stopPropagation()}>
                  {int.sparkData.map((v, i) => (
                    <div
                      key={i}
                      className="bar"
                      style={{ height: `${(v / maxSpark) * 100}%` }}
                    ></div>
                  ))}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '.85rem', fontWeight: 600 }}>{int.msgs}</div>
                  <div style={{ fontSize: '.68rem', color: 'var(--text-dim)' }}>msgs/day</div>
                </div>
              </div>
              <div className="int-meta">
                <span>Last: {int.lastRun}</span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={(e) => { e.stopPropagation(); handleShowVersionHistory(int.name); }}
                  title="Version History"
                >
                  &#128339;
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
