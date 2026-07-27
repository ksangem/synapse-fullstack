import { createContext, useContext } from 'react';

// Context object lives with its hook so the provider file exports only its component
// (satisfies react-refresh/only-export-components).
export const AlertsContext = createContext();

export function useAlerts() {
  const context = useContext(AlertsContext);
  if (!context) {
    throw new Error('useAlerts must be used within an AlertsProvider');
  }
  return context;
}
