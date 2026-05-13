export const btnStyle = {
  padding: '6px 14px',
  fontSize: '.82rem',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--bg-card)',
  color: 'var(--text)',
  cursor: 'pointer',
  transition: 'all .15s',
};

export const btnPrimaryStyle = {
  ...btnStyle,
  background: 'var(--primary)',
  color: '#fff',
  border: '1px solid var(--primary)',
};

export const btnDangerStyle = {
  ...btnStyle,
  background: 'var(--error)',
  color: '#fff',
  border: '1px solid var(--error)',
};

export const thStyle = {
  textAlign: 'left',
  padding: '8px 12px',
  fontSize: '.75rem',
  fontWeight: 600,
  color: 'var(--text-dim)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};

export const tdStyle = {
  padding: '8px 12px',
  fontSize: '.82rem',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
};

export const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 999,
};

export const modalStyle = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 24,
  minWidth: 400,
  maxWidth: 520,
  boxShadow: 'var(--shadow-md)',
};

export const labelStyle = {
  display: 'block',
  fontSize: '.78rem',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: 4,
};

export const inputStyle = {
  width: '100%',
  padding: '6px 10px',
  fontSize: '.85rem',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg-main)',
  color: 'var(--text)',
  boxSizing: 'border-box',
};

export const selectStyle = { ...inputStyle, cursor: 'pointer' };

export const statusColor = (s) => {
  if (s === 'COMPLETED') return 'var(--success)';
  if (s === 'FAILED') return 'var(--error)';
  if (s === 'RUNNING' || s === 'SYNCING') return 'var(--info)';
  return 'var(--text-dim)';
};

export const statusBadgeClass = (s) => {
  if (s === 'SUCCESS' || s === 'COMPLETED') return 'badge-success';
  if (s === 'FAILED') return 'badge-error';
  if (s === 'RUNNING' || s === 'SYNCING') return 'badge-info';
  return 'badge-neutral';
};

export const fmtDate = (iso) => {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
};
