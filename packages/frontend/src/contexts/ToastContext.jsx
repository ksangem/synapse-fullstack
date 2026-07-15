import { createContext, useState, useCallback, useRef } from 'react';

export const ToastContext = createContext();

// Most call sites pass only a message. When the type is omitted, infer it from the
// message so failures don't render as a green success (they used to). An EXPLICIT
// type always wins; this is only the fallback. Kept conservative (strong error/warn
// signals only) so neutral messages stay 'success'.
function inferToastType(message) {
  const m = String(message ?? '').toLowerCase();
  if (/(fail|error|unable|cannot|can't|couldn'?t|could not|denied|invalid|not valid|blocked|rejected|require|not found|timed? ?out|network error)/.test(m)) return 'error';
  if (/(already in progress|not available|isn'?t available|not yet|nothing to|no connections|no users|no credentials|cancelled|canceled)/.test(m)) return 'warning';
  return 'success';
}

export function ToastProvider({ children }) {
  const [toast, setToast] = useState({ message: '', type: 'success', visible: false });
  const timerRef = useRef(null);

  // type: 'success' | 'error' | 'warning' | 'info'. Omit it to auto-infer from the message.
  const showToast = useCallback((message, type) => {
    const resolved = type || inferToastType(message);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setToast({ message, type: resolved, visible: true });
    timerRef.current = setTimeout(() => {
      setToast({ message: '', type: 'success', visible: false });
      timerRef.current = null;
    }, 2500);
  }, []);

  return (
    <ToastContext.Provider value={{ ...toast, showToast }}>
      {children}
    </ToastContext.Provider>
  );
}
