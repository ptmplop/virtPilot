import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { DashboardPage } from '@/pages/Dashboard';
import { VmsPage } from '@/pages/Vms';
import { VmCreatePage } from '@/pages/VmCreate';
import { VmDetailPage } from '@/pages/VmDetail';
// Lazy: pulls in noVNC (heavy + top-level await), so keep it out of the main
// bundle/module graph until the console is actually opened.
const VmConsolePage = lazy(() => import('@/pages/VmConsole').then((m) => ({ default: m.VmConsolePage })));
import { NetworksPage } from '@/pages/Networks';
import { TemplatesPage } from '@/pages/Templates';
import { IsosPage } from '@/pages/Isos';
import { StoragePage } from '@/pages/Storage';
import { SettingsPage } from '@/pages/Settings';
import { LogsPage } from '@/pages/Logs';
import { SshKeysPage } from '@/pages/SshKeys';
import { BackupsPage } from '@/pages/Backups';
import { LoginPage } from '@/pages/Login';
import { ProtectedRoute } from '@/components/ProtectedRoute';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/vms"
        element={
          <ProtectedRoute>
            <VmsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/vms/new"
        element={
          <ProtectedRoute>
            <VmCreatePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/vms/:uuid"
        element={
          <ProtectedRoute>
            <VmDetailPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/vms/:uuid/console"
        element={
          <ProtectedRoute>
            <Suspense fallback={null}>
              <VmConsolePage />
            </Suspense>
          </ProtectedRoute>
        }
      />
      <Route
        path="/networks"
        element={
          <ProtectedRoute>
            <NetworksPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/templates"
        element={
          <ProtectedRoute>
            <TemplatesPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/isos"
        element={
          <ProtectedRoute>
            <IsosPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/storage"
        element={
          <ProtectedRoute>
            <StoragePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <SettingsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/logs"
        element={
          <ProtectedRoute>
            <LogsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/ssh-keys"
        element={
          <ProtectedRoute>
            <SshKeysPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/backups"
        element={
          <ProtectedRoute>
            <BackupsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/backups/:vmUuid"
        element={
          <ProtectedRoute>
            <BackupsPage />
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
