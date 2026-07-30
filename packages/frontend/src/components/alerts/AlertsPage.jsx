import { useState } from 'react';
import { useDetailPane } from '../../hooks/useDetailPane';
import { useNavigate } from 'react-router-dom';
import { useAlerts } from '../../hooks/useAlerts';
import Card, { CardSkeleton, CardEmpty, CardError } from '../ui/Card';
import { clickable } from '../../utils/clickable';

function AlertDetailContent({ alert, navigate }) {
  const [showStack, setShowStack] = useState(false);
  const titleColor = alert.severity === 'critical' ? 'var(--error-on)' : alert.severity === 'warning' ? 'var(--warning-on)' : 'var(--info-on)';
  const sevBadge = alert.severity === 'critical' ? 'badge-error' : alert.severity === 'warning' ? 'badge-warning' : 'badge-info';

  return (
    <>
      <div style={{ color: titleColor, fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-md)', marginBottom: 12 }}>
        &#9888; {alert.title}
      </div>
      <div className="grid-2 mb-16">
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Severity</div>
          <span className={`badge ${sevBadge}`}>
            {alert.severity.charAt(0).toUpperCase() + alert.severity.slice(1)}
          </span>
        </div>
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Integration</div>
          {/* A bare UUID identified nothing you could act on. Name it, and say what
              it moves — the id stays as the tooltip for anyone matching logs. */}
          {alert.integrationId
            ? (
              <button type="button" className="link-btn" title={alert.integrationId}
                onClick={() => navigate('/registry')}>
                {alert.connection?.name || alert.integrationId}
              </button>
            )
            : <span style={{ color: 'var(--text-dim)' }}>Platform-wide</span>}
        </div>
        {alert.connection && (
          <>
            <div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Source</div>
              <span style={{ fontSize: 'var(--fs-base)' }}>{alert.connection.srcLabel}</span>
            </div>
            <div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Destination</div>
              <span style={{ fontSize: 'var(--fs-base)' }}>{alert.connection.destLabel}</span>
            </div>
          </>
        )}
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Time</div>
          {alert.time || '—'}
        </div>
        <div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Status</div>
          <span className={`badge ${alert.resolved ? 'badge-success' : 'badge-error'}`}>
            {alert.resolved ? 'Resolved' : 'Unresolved'}
          </span>
        </div>
      </div>

      <div style={{ fontSize: 'var(--fs-base)', color: 'var(--text-secondary)', marginBottom: 16 }}>
        {alert.message}
      </div>

      {alert.stack && (
        <>
          <div className="accordion-header" {...clickable(() => setShowStack(!showStack), { label: `${showStack ? 'Hide' : 'Show'} stack trace` })}
            aria-expanded={showStack}>
            Stack Trace <span style={{ color: 'var(--text-dim)' }}>&#9660;</span>
          </div>
          <div className={`accordion-body${showStack ? ' show' : ''}`}>
            <div className="json-block" style={{ fontSize: 'var(--fs-xs)', color: 'var(--error-on)' }}>
              {alert.stack.split('\n').map((line, i) => (
                <span key={i}>{line}<br /></span>
              ))}
            </div>
          </div>
        </>
      )}

    </>
  );
}

const SEVERITY = {
  critical: { status: 'fail', label: 'Critical' },
  warning: { status: 'warn', label: 'Warning' },
  info: { status: 'ok', label: 'Info' },
};

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'critical', label: 'Critical' },
  { key: 'warning', label: 'Warning' },
  { key: 'unresolved', label: 'Unresolved' },
  { key: 'resolved', label: 'Resolved' },
];

export default function AlertsPage() {
  const [filter, setFilter] = useState('all');
  const { alerts, unresolvedCount, loading, error } = useAlerts();
  const { openDetailPane } = useDetailPane();
  const navigate = useNavigate();

  const filteredAlerts = alerts.filter((a) => {
    if (filter === 'critical' || filter === 'warning') return a.severity === filter;
    if (filter === 'unresolved') return !a.resolved;
    if (filter === 'resolved') return a.resolved;
    return true;
  });

  // Counts sit on the chips so the filter row doubles as a summary.
  const countFor = (key) => {
    if (key === 'all') return alerts.length;
    if (key === 'unresolved') return alerts.filter((a) => !a.resolved).length;
    if (key === 'resolved') return alerts.filter((a) => a.resolved).length;
    return alerts.filter((a) => a.severity === key).length;
  };

  const handleAlertClick = (alert) => {
    const label = alert.title.length > 30 ? `${alert.title.slice(0, 30)}…` : alert.title;
    openDetailPane(
      `Alert: ${label}`,
      <AlertDetailContent alert={alert} navigate={navigate} />,
      'Alerts',
    );
  };

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Alerts</h1>
          <div className="page-subtitle">
            {unresolvedCount > 0
              ? <><strong>{unresolvedCount}</strong> unresolved · {alerts.length} total</>
              : <>Nothing unresolved · {alerts.length} total</>}
          </div>
        </div>
      </div>

      <div className="page-body fit">
        {/* Filter chips, matching the Registry's row — a select hid the counts and
            took two interactions to change. */}
        <div className="filter-chips mb-16">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`chip${filter === f.key ? ' active' : ''}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="chip-count">{countFor(f.key)}</span>
            </button>
          ))}
        </div>

        {loading && <div className="ucard-grid" style={{ '--ucard-min': '100%' }}><CardSkeleton count={4} /></div>}

        {!loading && error && <CardError>{error}</CardError>}

        {!loading && !error && filteredAlerts.length === 0 && (
          <CardEmpty title={alerts.length === 0 ? 'No alerts' : 'Nothing matches this filter'}>
            {alerts.length === 0
              ? 'Everything looks healthy. Alerts raised by the platform will appear here.'
              : `${alerts.length} alert${alerts.length === 1 ? '' : 's'} exist, but none match “${FILTERS.find((f) => f.key === filter)?.label}”.`}
          </CardEmpty>
        )}

        {!loading && !error && filteredAlerts.length > 0 && (
          <div className="fit-scroll alert-list">
            {filteredAlerts.map((a, i) => {
              const sev = SEVERITY[a.severity] || SEVERITY.info;
              return (
                <Card
                  key={a.id}
                  interactive
                  style={{ '--i': Math.min(i, 12) }}
                  /* Resolved alerts keep their severity in the eyebrow but drop the
                     rail colour — history should not shout like a live problem. */
                  status={a.resolved ? 'idle' : sev.status}
                  eyebrow={a.resolved ? `${sev.label} · resolved` : sev.label}
                  badge={a.integrationId ? 'integration' : 'platform'}
                  title={a.title}
                  /* Which sync raised it, named the way the Registry names it.
                     "integration" in the badge said only that one was involved. */
                  sub={a.connection
                    ? <>
                        <span className="ucard-scope">{a.connection.name || 'Connection'}</span>
                        <span className="ucard-sys">{a.connection.route}</span>
                      </>
                    : undefined}
                  onOpen={() => handleAlertClick(a)}
                  ariaLabel={`${sev.label} alert: ${a.title}, ${a.resolved ? 'resolved' : 'unresolved'}`}
                  foot={
                    <>
                      <span className={`int-when int-when--${a.resolved ? 'stale' : 'recent'}`} title={a.time}>
                        {a.relative || '—'}
                      </span>
                      <span className="int-meta">
                        <span>{a.resolved ? 'Resolved' : 'Needs attention'}</span>
                      </span>
                    </>
                  }
                >
                  {a.message && <div className="alert-msg">{a.message}</div>}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
