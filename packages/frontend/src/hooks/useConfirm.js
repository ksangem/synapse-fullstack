import { createContext, useContext } from 'react';

// Context object lives with its hook so the provider file exports only its component
// (satisfies react-refresh/only-export-components).
export const ConfirmContext = createContext();

export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error('useConfirm must be used within a ConfirmProvider');
  }
  return confirm;
}
