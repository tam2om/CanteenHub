/**
 * Employee portal shell: routing plus the authenticated layout.
 */

import { Navigate, Route, Routes } from 'react-router-dom';
import { AppHeader } from './components/AppHeader.js';
import { RequireAuth } from './components/RequireAuth.js';
import { LoginPage } from './pages/LoginPage.js';
import { EmployeeDashboard } from './pages/EmployeeDashboard.js';
import { SelectionHistoryPage } from './pages/SelectionHistoryPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { RequireAdmin } from './components/RequireAdmin.js';
import { AdminLayout } from './components/AdminLayout.js';
import { AdminEmployeesPage } from './pages/admin/AdminEmployeesPage.js';
import { AdminSettingsPage } from './pages/admin/AdminSettingsPage.js';
import { AdminEmployeeImportPage } from './pages/admin/AdminEmployeeImportPage.js';
import { AdminRosterImportPage } from './pages/admin/AdminRosterImportPage.js';
import { AdminMenuImportPage } from './pages/admin/AdminMenuImportPage.js';
import { AdminMenuPage } from './pages/admin/AdminMenuPage.js';

function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <AppHeader />
      {children}
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/"
        element={
          <RequireAuth>
            <AuthenticatedLayout>
              <EmployeeDashboard />
            </AuthenticatedLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/history"
        element={
          <RequireAuth>
            <AuthenticatedLayout>
              <SelectionHistoryPage />
            </AuthenticatedLayout>
          </RequireAuth>
        }
      />
      <Route
        path="/profile"
        element={
          <RequireAuth>
            <AuthenticatedLayout>
              <ProfilePage />
            </AuthenticatedLayout>
          </RequireAuth>
        }
      />

      {/* Admin area. RequireAdmin is a UX affordance; every /api/admin endpoint
          independently enforces requireAuth + requireRole server-side. */}
      <Route
        path="/admin"
        element={<Navigate to="/admin/employees" replace />}
      />
      <Route
        path="/admin/employees"
        element={
          <RequireAdmin>
            <AdminLayout>
              <AdminEmployeesPage />
            </AdminLayout>
          </RequireAdmin>
        }
      />
      <Route
        path="/admin/imports/employees"
        element={
          <RequireAdmin>
            <AdminLayout>
              <AdminEmployeeImportPage />
            </AdminLayout>
          </RequireAdmin>
        }
      />
      <Route
        path="/admin/imports/roster"
        element={
          <RequireAdmin>
            <AdminLayout>
              <AdminRosterImportPage />
            </AdminLayout>
          </RequireAdmin>
        }
      />
      <Route
        path="/admin/menu"
        element={
          <RequireAdmin>
            <AdminLayout>
              <AdminMenuPage />
            </AdminLayout>
          </RequireAdmin>
        }
      />
      <Route
        path="/admin/imports/menu"
        element={
          <RequireAdmin>
            <AdminLayout>
              <AdminMenuImportPage />
            </AdminLayout>
          </RequireAdmin>
        }
      />
      <Route
        path="/admin/settings"
        element={
          <RequireAdmin>
            <AdminLayout>
              <AdminSettingsPage />
            </AdminLayout>
          </RequireAdmin>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
