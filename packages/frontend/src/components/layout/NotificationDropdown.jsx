import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAlerts } from '../../hooks/useAlerts';

/* The notification tray renders REAL alerts from GET /api/alerts (via AlertsContext).
   It previously rendered a hardcoded array of alerts for SAP / Salesforce / Workday /
   Stripe — systems Synapse does not connect to — alongside a badge that always read "3". */

export default function NotificationDropdown({ isOpen, onClose }) {
  const ref = useRef(null);
  const navigate = useNavigate();
  const { recent, unresolvedCount, loading, error } = useAlerts();

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        onClose();
      }
    }
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKey);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isOpen, onClose]);

  function handleItemClick() {
    navigate('/alerts');
    onClose();
  }

  // Severity → the left-border accent class already defined in styles.css.
  const itemClass = (a) => {
    if (a.resolved) return '';
    if (a.severity === 'critical') return ' critical';
    if (a.severity === 'warning') return ' warning';
    return '';
  };

  return (
    <div
      ref={ref}
      className={`notification-dropdown${isOpen ? ' show' : ''}`}
      role="dialog"
      aria-label="Notifications"
    >
      <div className="notif-header">
        <span>Notifications</span>
        {unresolvedCount > 0 && (
          <span className="badge badge-error">{unresolvedCount} unresolved</span>
        )}
      </div>

      {loading && <div className="empty-state" style={{ padding: '24px 16px' }}>Loading alerts…</div>}

      {!loading && error && (
        <div className="empty-state" style={{ padding: '24px 16px' }}>{error}</div>
      )}

      {!loading && !error && recent.length === 0 && (
        <div className="empty-state" style={{ padding: '24px 16px' }}>
          No alerts — everything looks healthy.
        </div>
      )}

      {!loading && !error && recent.map((a) => (
        <div
          key={a.id}
          className={`notif-item${itemClass(a)}`}
          role="button"
          tabIndex={0}
          onClick={handleItemClick}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleItemClick(); } }}
        >
          <div className="notif-title">{a.title}</div>
          <div className="notif-meta">
            {a.relative}
            {a.resolved ? ' · Resolved' : ''}
          </div>
        </div>
      ))}
    </div>
  );
}
