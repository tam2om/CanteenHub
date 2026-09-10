/**
 * Admin route guard.
 *
 * This is a UX affordance only. Every /api/admin endpoint sits behind
 * requireAuth + requireRole server-side and rejects a non-admin regardless of
 * what the browser renders; hiding the screen simply spares an employee a
 * pointless 403. It is never the security boundary.
 */

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useSession } from '../hooks/useSession.js';
import { LoadingState } from './States.js';

const ADMIN_ROLES = ['admin', 'super_admin'];

export function isAdminRole(role: string | undefined): boolean {
  return role !== undefined && ADMIN_ROLES.includes(role);
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, isAuthenticated, isLoading } = useSession();

  if (isLoading) return <LoadingState label="Checking your session…" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (!isAdminRole(user?.role)) {
    // Send a signed-in non-admin back to their own portal rather than to login:
    // their session is perfectly valid, this area just is not theirs.
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
