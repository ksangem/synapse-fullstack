import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../services/api';

const POLL_MS = 30000; // refresh critical alerts every 30s

export default function CriticalBanner() {
  const [alert, setAlert] = useState(null);   // the top open critical alert, or null
  const [dismissedId, setDismissedId] = useState(null); // alertId the user dismissed this session
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await api.getAlerts('?resolved=false&severity=critical');
        const body = res?.data ?? res;          // fetchApi wraps body under .data
        const list = body?.data ?? body ?? [];  // backend envelope: { success, data: [] }
        if (active) setAlert(Array.isArray(list) && list.length ? list[0] : null);
      } catch {
        if (active) setAlert(null); // endpoint down → show nothing rather than a fake banner
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => { active = false; clearInterval(t); };
  }, []);

  // Nothing to show: no open critical alert, or the user dismissed this one.
  if (!alert || alert.alertId === dismissedId) return null;

  return (
    <div className="critical-banner">
      <span className="pulse-dot"></span>
      <span style={{ flex: 1 }}>
        <strong>Critical:</strong> {alert.title}{alert.message ? ` — ${alert.message}` : ''}
      </span>
      <button className="btn btn-danger btn-sm" onClick={() => navigate('/alerts')}>
        View Alerts
      </button>
      <button className="btn btn-ghost btn-sm" onClick={() => setDismissedId(alert.alertId)}>
        Dismiss
      </button>
    </div>
  );
}
