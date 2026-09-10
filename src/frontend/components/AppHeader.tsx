/**
 * Header and primary navigation. Minimal by design: the employee's whole task is
 * one tap on the dashboard, so navigation must not compete with it.
 */

import { NavLink } from 'react-router-dom';
import { useLogout, useSession } from '../hooks/useSession.js';
import { isAdminRole } from './RequireAdmin.js';

export function AppHeader() {
  const { user } = useSession();
  const logout = useLogout();

  return (
    <header className="header">
      <div className="header__bar">
        <span className="header__brand">CanteenHub</span>
        <button
          type="button"
          className="header__logout"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
        >
          {logout.isPending ? 'Signing out…' : 'Sign out'}
        </button>
      </div>

      {user && (
        <p className="header__who">
          {user.full_name} · {user.amco_id}
        </p>
      )}

      <nav className="nav" aria-label="Main">
        <NavLink to="/" end className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}>
          Today
        </NavLink>
        <NavLink to="/history" className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}>
          History
        </NavLink>
        <NavLink to="/profile" className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}>
          Profile
        </NavLink>
        {/* Shown to admins as a convenience. Hiding it is NOT the control -
            the server rejects a non-admin at every /api/admin endpoint. */}
        {isAdminRole(user?.role) && (
          <NavLink
            to="/admin/employees"
            className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
          >
            Admin
          </NavLink>
        )}
      </nav>
    </header>
  );
}
