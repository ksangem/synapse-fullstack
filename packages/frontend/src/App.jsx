import { useState, useCallback } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider } from './contexts/ThemeContext';
import { ToastProvider } from './contexts/ToastContext';
import { DetailPaneProvider } from './contexts/DetailPaneContext';
import { SidebarProvider } from './contexts/SidebarContext';

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
import PushPage from './components/push/PushPage';

import './styles.css';

function App() {
  const [helpOpen, setHelpOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const toggleHelp = useCallback(() => {
    setHelpOpen((prev) => !prev);
  }, []);

  const toggleNotif = useCallback(() => {
    setNotifOpen((prev) => !prev);
  }, []);

  const closeNotif = useCallback(() => {
    setNotifOpen(false);
  }, []);

  return (
    <ThemeProvider>
      <ToastProvider>
        <DetailPaneProvider>
          <SidebarProvider>
            <CriticalBanner />
            <Topbar onNotificationToggle={toggleNotif} onHelpToggle={toggleHelp} />
            <ContextualToolbar />
            <HelpPanel isOpen={helpOpen} onClose={toggleHelp} />
            <NotificationDropdown isOpen={notifOpen} onClose={closeNotif} />
            <div className="app-body">
              <Sidebar />
              <div className="main-content-wrapper">
                <div className="main-content" id="mainContent">
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
                    <Route path="/admin" element={<AdminPage />} />
                    <Route path="/connected" element={<ConnectedPage />} />
                    <Route path="/push" element={<PushPage />} />
                  </Routes>
                </div>
                <DetailPane />
              </div>
            </div>
            <ToastNotification />
          </SidebarProvider>
        </DetailPaneProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}

export default App;
