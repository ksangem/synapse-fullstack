import { createContext, useContext } from 'react';

// Context object lives with its hook so the provider file exports only its component
// (satisfies react-refresh/only-export-components).
export const DetailPaneContext = createContext();

export function useDetailPane() {
  const context = useContext(DetailPaneContext);
  if (!context) {
    throw new Error('useDetailPane must be used within a DetailPaneProvider');
  }
  return context;
}
