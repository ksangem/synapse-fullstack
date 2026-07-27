import { createContext, useContext } from 'react';

// Context object lives with its hook so the provider file exports only its component
// (satisfies react-refresh/only-export-components).
export const ToastContext = createContext();

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
