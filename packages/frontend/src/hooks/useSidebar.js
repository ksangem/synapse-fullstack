import { createContext, useContext } from 'react';

// Context object lives with its hook (a non-component module) so the provider file can export
// only its component — satisfies react-refresh/only-export-components.
export const SidebarContext = createContext();

export function useSidebar() {
  return useContext(SidebarContext);
}
