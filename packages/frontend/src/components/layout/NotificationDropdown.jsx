import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

const notifications = [
  {
    id: 1,
    type: 'critical',
    title: 'SAP ERP Adapter Down',
    meta: '47 min ago \u00B7 Integration Registry',
  },
  {
    id: 2,
    type: 'warning',
    title: 'Salesforce token expires in 3 days',
    meta: '2 hours ago \u00B7 Credential Vault',
  },
  {
    id: 3,
    type: 'warning',
    title: 'High latency on Workday sync',
    meta: '3 hours ago \u00B7 Message Monitor',
  },
  {
    id: 4,
    type: '',
    title: 'New connector published: Stripe v2.1',
    meta: '5 hours ago \u00B7 Connector Studio',
  },
  {
    id: 5,
    type: '',
    title: 'Weekly performance report ready',
    meta: '1 day ago \u00B7 Dashboard',
  },
];

export default function NotificationDropdown({ isOpen, onClose }) {
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    function handleClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) {
        onClose();
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, onClose]);

  function handleItemClick(notif) {
    if (notif.type === 'critical') {
      navigate('/alerts');
    }
    onClose();
  }

  return (
    <div
      ref={ref}
      className={`notification-dropdown${isOpen ? ' show' : ''}`}
    >
      <div className="notif-header">
        <span>Notifications</span>
        <span className="badge badge-error">3 unresolved</span>
      </div>
      {notifications.map((notif) => (
        <div
          key={notif.id}
          className={`notif-item${notif.type ? ` ${notif.type}` : ''}`}
          onClick={() => handleItemClick(notif)}
        >
          <div className="notif-title">{notif.title}</div>
          <div className="notif-meta">{notif.meta}</div>
        </div>
      ))}
    </div>
  );
}
