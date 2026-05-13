import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export default function CriticalBanner() {
  const [visible, setVisible] = useState(true);
  const navigate = useNavigate();

  if (!visible) return null;

  return (
    <div className="critical-banner">
      <span className="pulse-dot"></span>
      <span style={{ flex: 1 }}>
        <strong>Critical:</strong> SAP ERP Production adapter has been failing for 47 minutes. 1,247 messages queued.
      </span>
      <button
        className="btn btn-danger btn-sm"
        onClick={() => navigate('/alerts')}
      >
        View Alerts
      </button>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() => setVisible(false)}
      >
        Dismiss
      </button>
    </div>
  );
}
