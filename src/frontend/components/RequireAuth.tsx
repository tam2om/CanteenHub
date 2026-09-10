/**
 * Route guard.
 *
 * This is a usability affordance, not a security control: every endpoint the
 * portal calls enforces authentication server-side and returns 401 regardless
 * of what the browser renders.
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../hooks/useSession.js';
import { LoadingState } from './States.js';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isAuthenticated, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) return <LoadingState label="Checking your session…" />;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
