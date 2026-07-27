import { useState, useCallback } from 'react';
import { SidebarContext } from '../hooks/useSidebar';

export function SidebarProvider({ children }) {
  const [collapsed, setCollapsed] = useState(false);
  // Off-canvas drawer state for tablet/mobile (independent of desktop collapse).
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleSidebar = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  const openMobile = useCallback(() => setMobileOpen(true), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);
  const toggleMobile = useCallback(() => setMobileOpen((prev) => !prev), []);

  return (
    <SidebarContext.Provider
      value={{ collapsed, toggleSidebar, mobileOpen, openMobile, closeMobile, toggleMobile }}
    >
      {children}
    </SidebarContext.Provider>
  );
}
