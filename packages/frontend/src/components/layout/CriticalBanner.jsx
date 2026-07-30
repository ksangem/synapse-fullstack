import { useNavigate } from 'react-router-dom';
import { useAlerts } from '../../hooks/useAlerts';

/* Top-of-app banner for the most recent unresolved CRITICAL alert.
   Reads from AlertsContext — the app polls /api/alerts once and the banner, the
   notification bell, and the Alerts page all render from that single result
   (this component used to run its own duplicate 30s poll). */

export default function CriticalBanner() {
  const { topCritical, dismiss } = useAlerts();
  const navigate = useNavigate();

  if (!topCritical) return null;

  return (
    <div className="critical-banner" role="status">
      <span className="pulse-dot" aria-hidden="true"></span>
      <span style={{ flex: 1 }}>
        <strong>Critical:</strong> {topCritical.title}
        {/* Name the connection before the prose. A platform-wide alert has none,
            and then this reads exactly as it did. */}
        {topCritical.connection
          ? ` — ${topCritical.connection.name || topCritical.connection.route}`
          : ''}
        {topCritical.message ? ` — ${topCritical.message}` : ''}
      </span>
      <button className="btn btn-danger btn-sm" onClick={() => navigate('/alerts')}>
        View Alerts
      </button>
      <button className="btn btn-ghost btn-sm" onClick={() => dismiss(topCritical.id)}>
        Dismiss
      </button>
    </div>
  );
}
