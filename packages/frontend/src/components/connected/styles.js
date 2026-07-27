/* Local presentation helpers for My Connections.

   This file used to be a PARALLEL design system: its own button, table-header and
   table-cell styles that shadowed the real ones with different padding, radius and
   timing — and, because inline styles cannot express pseudo-classes, with no hover,
   focus, active or disabled states at all. Those exports are gone; the page now uses
   `.btn`/`.btn-*`, `.chip`, `.dp-close` and the global `th`/`td` rules.

   What remains is genuinely local: modal chrome and a few formatters. */

export const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,.45)',
  backdropFilter: 'blur(2px)',
  WebkitBackdropFilter: 'blur(2px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  // Was 999 — the exact value the toast stack uses, so their order was undefined and
  // DOM-dependent. Both now come from the shared z-layer scale.
  zIndex: 'var(--z-modal)',
};

export const modalStyle = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  padding: 24,
  width: '100%',
  minWidth: 0,
  maxWidth: 520,
  boxShadow: 'var(--elev-4)',
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
  // Was --border / --bg-main: a soft edge below the 3:1 control minimum, and a
  // page-tinted (lavender) fill that made these inputs look different from every
  // other input in the app.
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-input)',
  color: 'var(--text)',
  boxSizing: 'border-box',
};

export const selectStyle = { ...inputStyle, cursor: 'pointer' };

/* PARTIAL was handled by neither of these, so a partial push rendered grey here and
   amber on the Dashboard. Both now agree, and both use the on-tint text tokens. */
export const statusColor = (s) => {
  if (s === 'SUCCESS' || s === 'COMPLETED') return 'var(--success-on)';
  if (s === 'FAILED') return 'var(--error-on)';
  if (s === 'PARTIAL') return 'var(--warning-on)';
  if (s === 'RUNNING' || s === 'SYNCING') return 'var(--info-on)';
  return 'var(--text-secondary)';
};

export const statusBadgeClass = (s) => {
  if (s === 'SUCCESS' || s === 'COMPLETED') return 'badge-success';
  if (s === 'FAILED') return 'badge-error';
  if (s === 'PARTIAL') return 'badge-warning';
  if (s === 'RUNNING' || s === 'SYNCING') return 'badge-info';
  return 'badge-neutral';
};

/* Locale-aware. This hardcoded 'en-US', so this page showed US dates while every
   other surface (Monitor, Dashboard, Registry, DLQ) used the viewer's locale. */
export const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};
