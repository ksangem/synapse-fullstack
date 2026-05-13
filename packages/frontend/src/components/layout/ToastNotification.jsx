import { useToast } from '../../hooks/useToast';

export default function ToastNotification() {
  const { message, visible } = useToast();

  return (
    <div
      id="toastNotif"
      style={{
        position: 'fixed',
        bottom: '20px',
        left: '50%',
        transform: `translateX(-50%) translateY(${visible ? '0' : '80px'})`,
        background: 'var(--bg-card)',
        border: '1px solid var(--success)',
        borderRadius: 'var(--radius)',
        padding: '10px 20px',
        fontSize: '.85rem',
        fontWeight: 600,
        color: 'var(--success)',
        boxShadow: 'var(--shadow-md)',
        zIndex: 999,
        transition: 'transform 0.3s ease',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
      }}
    >
      <span>&#10003;</span>
      <span>{message}</span>
    </div>
  );
}
