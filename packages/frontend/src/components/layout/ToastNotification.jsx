import { useToast } from '../../hooks/useToast';

// Per-type colour + icon. The colour drives both the border and the text; falls
// back to success so an unknown/omitted type still renders sensibly.
const TOAST_STYLES = {
  success: { color: 'var(--success)', icon: '✓' }, // ✓
  error:   { color: 'var(--error)',   icon: '✗' }, // ✗
  warning: { color: 'var(--warning)', icon: '⚠' }, // ⚠
  info:    { color: 'var(--primary)', icon: 'ℹ' }, // ℹ
};

export default function ToastNotification() {
  const { message, visible, type = 'success' } = useToast();
  const { color, icon } = TOAST_STYLES[type] || TOAST_STYLES.success;

  return (
    <div
      id="toastNotif"
      style={{
        position: 'fixed',
        bottom: '20px',
        left: '50%',
        transform: `translateX(-50%) translateY(${visible ? '0' : '80px'})`,
        background: 'var(--bg-card)',
        border: `1px solid ${color}`,
        borderRadius: 'var(--radius)',
        padding: '10px 20px',
        fontSize: '.85rem',
        fontWeight: 600,
        color,
        boxShadow: 'var(--shadow-md)',
        zIndex: 999,
        transition: 'transform 0.3s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span>{icon}</span>
      <span>{message}</span>
    </div>
  );
}
