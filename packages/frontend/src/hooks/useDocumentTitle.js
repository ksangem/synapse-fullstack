import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

const APP_NAME = 'Synapse';

// Route → tab title. Keep these matching the sidebar labels so a browser tab, a
// bookmark, and the nav all name the same thing.
const ROUTE_TITLES = {
  '/dashboard': 'Health Dashboard',
  '/registry': 'Integration Registry',
  '/monitor': 'Message Monitor',
  '/alerts': 'Alerts',
  '/studio': 'Connector Studio',
  '/wizard': 'Connection Wizard',
  '/canvas': 'Mapping Canvas',
  '/catalog': 'Entity Catalog',
  '/connected': 'My Connections',
  '/vault': 'Credential Vault',
  '/admin': 'Administration',
};

/* Sets document.title per route. The app previously shipped the Vite scaffold's
   `synapse-react` on every tab, bookmark and screenshot. */
export function useDocumentTitle(isAuthed) {
  const { pathname } = useLocation();

  useEffect(() => {
    if (!isAuthed) {
      document.title = `Sign in · ${APP_NAME}`;
      return;
    }
    let page = ROUTE_TITLES[pathname];
    if (!page && pathname.startsWith('/help/')) page = 'Help';
    document.title = page ? `${page} · ${APP_NAME}` : APP_NAME;
  }, [pathname, isAuthed]);
}
