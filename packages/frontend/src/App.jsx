import { useState, useCallback } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import { ConfirmProvider } from './contexts/ConfirmContext';
import { DetailPaneProvider } from './contexts/DetailPaneContext';
import { SidebarProvider } from './contexts/SidebarContext';
import { AlertsProvider } from './contexts/AlertsContext';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './hooks/useAuth';
import { useDocumentTitle } from './hooks/useDocumentTitle';
import LoginPage from './components/auth/LoginPage';

import ErrorBoundary from './components/layout/ErrorBoundary';
import NotFoundPage from './components/layout/NotFoundPage';
import CriticalBanner from './components/layout/CriticalBanner';
import Topbar from './components/layout/Topbar';
import ContextualToolbar from './components/layout/ContextualToolbar';
import HelpPanel from './components/layout/HelpPanel';
import NotificationDropdown from './components/layout/NotificationDropdown';
import Sidebar from './components/layout/Sidebar';
import DetailPane from './components/layout/DetailPane';
import ToastNotification from './components/layout/ToastNotification';

import DashboardPage from './components/dashboard/DashboardPage';
import RegistryPage from './components/registry/RegistryPage';
import MonitorPage from './components/monitor/MonitorPage';
import AlertsPage from './components/alerts/AlertsPage';
import StudioPage from './components/studio/StudioPage';
import WizardPage from './components/wizard/WizardPage';
import CanvasPage from './components/canvas/CanvasPage';
import CatalogPage from './components/catalog/CatalogPage';
import VaultPage from './components/vault/VaultPage';
import AdminPage from './components/admin/AdminPage';
import ConnectedPage from './components/connected/ConnectedPage';
import HelpDocPage from './components/help/HelpDocPage';

import './styles.css';

function AppShell() {
  const { isAuthed, role } = useAuth();
  const location = useLocation();
  const [helpOpen, setHelpOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const toggleHelp = useCallback(() => setHelpOpen((prev) => !prev), []);
  const toggleNotif = useCallback(() => setNotifOpen((prev) => !prev), []);
  const closeNotif = useCallback(() => setNotifOpen(false), []);

  useDocumentTitle(isAuthed);

  // Unauthenticated → login screen only.
  if (!isAuthed) return <LoginPage />;

  return (
    <>
      {/* First element in the tab order: lets a keyboard user jump the topbar,
          toolbar and sidebar, which otherwise cost ~20 tab stops on every page. */}
      <a className="skip-link" href="#mainContent">Skip to main content</a>
      <CriticalBanner />
      <Topbar onNotificationToggle={toggleNotif} onHelpToggle={toggleHelp} />
      <ContextualToolbar />
      <HelpPanel isOpen={helpOpen} onClose={toggleHelp} />
      <NotificationDropdown isOpen={notifOpen} onClose={closeNotif} />
      <div className="app-body">
        <Sidebar />
        <div className="main-content-wrapper">
          <main className="main-content" id="mainContent" tabIndex={-1}>
            {/* One broken page must not white-screen the app. resetKey clears the
                error when the user navigates somewhere else. */}
            <ErrorBoundary resetKey={location.pathname}>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/registry" element={<RegistryPage />} />
                <Route path="/monitor" element={<MonitorPage />} />
                <Route path="/alerts" element={<AlertsPage />} />
                <Route path="/studio" element={<StudioPage />} />
                <Route path="/wizard" element={<WizardPage />} />
                <Route path="/canvas" element={<CanvasPage />} />
                <Route path="/catalog" element={<CatalogPage />} />
                <Route path="/vault" element={<VaultPage />} />
                {/* Admin is admin-only — others are redirected. */}
                <Route path="/admin" element={role === 'admin' ? <AdminPage /> : <Navigate to="/dashboard" replace />} />
                <Route path="/connected" element={<ConnectedPage />} />
                <Route path="/help/:slug" element={<HelpDocPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </ErrorBoundary>
          </main>
          <DetailPane />
        </div>
      </div>
      <ToastNotification />
    </>
  );
}

function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <ToastProvider>
         <ConfirmProvider>
          <DetailPaneProvider>
            <SidebarProvider>
              <AlertsProvider>
                <AppShell />
              </AlertsProvider>
            </SidebarProvider>
          </DetailPaneProvider>
         </ConfirmProvider>
        </ToastProvider>
      </ThemeProvider>
    </AuthProvider>
  );
}

export default App;
