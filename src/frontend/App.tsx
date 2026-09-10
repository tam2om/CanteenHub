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

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
