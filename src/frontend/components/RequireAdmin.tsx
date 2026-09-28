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

import { isBackOfficeRole, isFullAdminRole } from '../lib/permissions.js';

/** Kept for existing callers: a FULL administrator (not a supervisor). */
export function isAdminRole(role: string | undefined): boolean {
  return isFullAdminRole(role);
}

interface Props {
  children: ReactNode;
  /**
   * Let a supervisor in too. Off by default, so a new admin page is closed to
   * supervisors unless someone deliberately opens it - the same default the
   * server's endpoint allowlist has.
   */
  allowSupervisor?: boolean;
}

export function RequireAdmin({ children, allowSupervisor = false }: Props) {
  const { user, isAuthenticated, isLoading } = useSession();

  if (isLoading) return <LoadingState label="Checking your session…" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  if (!isBackOfficeRole(user?.role)) {
    // Send a signed-in non-admin back to their own portal rather than to login:
    // their session is perfectly valid, this area just is not theirs.
    return <Navigate to="/" replace />;
  }

  if (!allowSupervisor && !isFullAdminRole(user?.role)) {
    // A supervisor who follows an old link to, say, Settings lands on the page
    // they CAN use rather than on an error.
    return <Navigate to="/admin/employees" replace />;
  }

  return <>{children}</>;
}
