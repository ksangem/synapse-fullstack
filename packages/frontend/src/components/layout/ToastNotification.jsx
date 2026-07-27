import { useToast } from '../../hooks/useToast';

/* Toast stack.

   Replaces a single fixed slot that was overwritten by each new call — a burst of
   results showed only the last one — and which was never announced to assistive
   tech (no role, no aria-live), had no dismiss control, and expired after 2.5s
   regardless of severity.

   Colour now lives on the rail and the icon, not the message text: the old version
   coloured the whole label with the semantic hue, which put success text at 2.28:1
   on the card surface. */

const TOAST = {
  success: { icon: '✓', label: 'Success' },
  error: { icon: '✕', label: 'Error' },
  warning: { icon: '⚠', label: 'Warning' },
  info: { icon: 'ℹ', label: 'Information' },
};

export default function ToastNotification() {
  const { toasts, dismiss, pause, resume } = useToast();

  return (
    /* The region is always mounted so screen readers pick up insertions. Errors are
       assertive; everything else is polite. */
    <div className="toast-stack" role="region" aria-label="Notifications">
      {toasts.map((t) => {
        const meta = TOAST[t.type] || TOAST.success;
        return (
          <div
            key={t.id}
            className={`toast toast--${t.type}${t.leaving ? ' is-leaving' : ''}`}
            role={t.type === 'error' ? 'alert' : 'status'}
            aria-live={t.type === 'error' ? 'assertive' : 'polite'}
            onMouseEnter={() => pause(t.id)}
            onMouseLeave={() => resume(t.id, t.type)}
          >
            <span className="toast-icon" aria-hidden="true">{meta.icon}</span>
            <span className="toast-msg">
              <span className="sr-only">{meta.label}: </span>
              {t.message}
              {t.repeat > 1 && <span className="toast-count">×{t.repeat}</span>}
            </span>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
