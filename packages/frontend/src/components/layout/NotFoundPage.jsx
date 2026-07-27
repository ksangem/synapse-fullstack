import { useLocation, useNavigate } from 'react-router-dom';

/* Catch-all for unknown routes. Without this, a mistyped or stale URL rendered the
   full app chrome around an empty content area with no explanation. */
export default function NotFoundPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();

  return (
    <div className="page active">
      <div className="page-header">
        <div>
          <h1 className="page-title">Page not found</h1>
          <div className="page-subtitle">No screen matches this address.</div>
        </div>
      </div>
      <div className="page-body">
        <div className="card" style={{ maxWidth: 560 }}>
          <p style={{ fontSize: 'var(--fs-base)', color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 8 }}>
            Nothing is routed to:
          </p>
          <code
            style={{
              display: 'block',
              fontFamily: 'var(--font-mono)',
              fontSize: 'var(--fs-sm)',
              color: 'var(--text)',
              background: 'var(--bg-input)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '8px 12px',
              marginBottom: 16,
              wordBreak: 'break-all',
            }}
          >
            {pathname}
          </code>
          <p style={{ fontSize: 'var(--fs-base)', color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 16 }}>
            The link may be out of date, or the page may have been renamed. Pick a destination
            from the sidebar, or head back to the dashboard.
          </p>
          <div className="flex gap-8">
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/dashboard')}>
              Go to Health Dashboard
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => navigate(-1)}>
              Back
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
