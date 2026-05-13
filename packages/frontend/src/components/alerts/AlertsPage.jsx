import { useState } from 'react';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useToast } from '../../hooks/useToast';
import { useNavigate } from 'react-router-dom';
import { alerts } from '../../data/alerts';

function AlertDetailContent({ alert, showToast, navigate }) {
  const [showStack, setShowStack] = useState(false);
  const titleColor = alert.severity === 'critical' ? 'var(--error)' : alert.severity === 'warning' ? 'var(--warning)' : 'var(--info)';
  const sevBadge = alert.severity === 'critical' ? 'badge-error' : alert.severity === 'warning' ? 'badge-warning' : 'badge-info';

  return (
    <>
      <div style={{ color: titleColor, fontWeight: 700, fontSize: '1rem', marginBottom: 12 }}>
        &#9888; {alert.title}
      </div>
      <div className="grid-2 mb-16">
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Severity</div>
          <span className={`badge ${sevBadge}`}>
            {alert.severity.charAt(0).toUpperCase() + alert.severity.slice(1)}
          </span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Adapter</div>
          <span className="clickable" onClick={() => navigate('/registry')}>{alert.adapter}</span>
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Time</div>
          {alert.time}
        </div>
        <div>
          <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>Status</div>
          <span className={`badge ${alert.resolved ? 'badge-success' : 'badge-error'}`}>
            {alert.resolved ? 'Resolved' : 'Unresolved'}
          </span>
        </div>
      </div>

      <div style={{ fontSize: '.85rem', color: 'var(--text-secondary)', marginBottom: 16 }}>
        {alert.msg}
      </div>

      {alert.stack && (
        <>
          <div className="accordion-header" onClick={() => setShowStack(!showStack)}>
            Stack Trace <span style={{ color: 'var(--text-dim)' }}>&#9660;</span>
          </div>
          <div className={`accordion-body${showStack ? ' show' : ''}`}>
            <div className="json-block" style={{ fontSize: '.72rem', color: 'var(--error)' }}>
              {alert.stack.split('\n').map((line, i) => (
                <span key={i}>{line}<br /></span>
              ))}
            </div>
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        {!alert.resolved && (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => showToast('Credential re-authorization started')}>Re-authorize Credential</button>
            <button className="btn btn-outline btn-sm" onClick={() => showToast('Retrying queued messages')}>Retry Queued</button>
            <button className="btn btn-danger btn-sm" onClick={() => showToast('Support ticket created for ' + alert.adapter)}>Create Ticket</button>
            <button className="btn btn-outline btn-sm" onClick={() => showToast('Escalated to designer')}>Escalate to Designer</button>
          </>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => showToast('Alert suppressed')}>Suppress</button>
      </div>
    </>
  );
}

export default function AlertsPage() {
  const [severityFilter, setSeverityFilter] = useState('all');
  const { openDetailPane } = useDetailPane();
  const { showToast } = useToast();
  const navigate = useNavigate();

  const filteredAlerts = alerts.filter(a => {
    if (severityFilter === 'critical') return a.severity === 'critical';
    if (severityFilter === 'warning') return a.severity === 'warning';
    return true;
  });

  const handleAlertClick = (alert) => {
    openDetailPane(
      'Alert: ' + alert.title.substring(0, 30) + '...',
      <AlertDetailContent alert={alert} showToast={showToast} navigate={navigate} />,
      'Alerts > ' + alert.adapter
    );
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <div className="page-title">Alerts &amp; Notifications</div>
          <div className="page-subtitle">3 unresolved alerts</div>
        </div>
        <div className="flex gap-8">
          <select
            style={{ padding: '4px 8px', fontSize: '.8rem' }}
            value={severityFilter}
            onChange={(e) => setSeverityFilter(e.target.value)}
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical Only</option>
            <option value="warning">Warnings</option>
          </select>
        </div>
      </div>

      <div id="alertsList">
        {filteredAlerts.map((a, idx) => {
          const bgColor = a.severity === 'critical' && !a.resolved ? 'var(--error-dim)' : 'transparent';
          const borderColor = a.severity === 'critical' ? 'var(--error)' : a.severity === 'warning' ? 'var(--warning)' : 'var(--info)';
          const badgeClass = a.resolved ? 'badge-success' : (a.severity === 'critical' ? 'badge-error' : 'badge-warning');

          return (
            <div
              key={idx}
              className="card mb-8"
              data-severity={a.severity}
              style={{ background: bgColor, borderLeft: `3px solid ${borderColor}`, cursor: 'pointer', padding: '12px 16px' }}
              onClick={() => handleAlertClick(a)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: '1.1rem' }}>{a.icon}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: '.88rem' }}>{a.title}</div>
                    <div style={{ fontSize: '.75rem', color: 'var(--text-dim)' }}>
                      <span
                        className="clickable"
                        onClick={(e) => { e.stopPropagation(); navigate('/registry'); }}
                      >
                        {a.adapter}
                      </span>
                      {' \u00b7 '}{a.time}
                    </div>
                  </div>
                </div>
                <span className={`badge ${badgeClass}`}>
                  {a.resolved ? 'Resolved' : 'Unresolved'}
                </span>
              </div>
              <div style={{ fontSize: '.82rem', color: 'var(--text-secondary)', marginTop: 6, marginLeft: 30 }}>
                {a.msg}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
