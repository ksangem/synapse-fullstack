import { createContext, useState, useCallback, useRef } from 'react';

export const ToastContext = createContext();

export function ToastProvider({ children }) {
  const [toast, setToast] = useState({ message: '', visible: false });
  const timerRef = useRef(null);

  const showToast = useCallback((message) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    setToast({ message, visible: true });
    timerRef.current = setTimeout(() => {
      setToast({ message: '', visible: false });
      timerRef.current = null;
    }, 2500);
  }, []);

  return (
    <ToastContext.Provider value={{ ...toast, showToast }}>
      {children}
    </ToastContext.Provider>
  );
}
