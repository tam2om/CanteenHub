/**
 * Admin shell: header, navigation, content area, logout.
 * Deliberately the same visual language as the employee portal - one stylesheet,
 * no separate design system.
 */

import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useLogout, useSession } from '../hooks/useSession.js';
import amcoMark from '../assets/amco-mark.png';
import { isFullAdminRole, roleLabel } from '../lib/permissions.js';

export function AdminLayout({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const logout = useLogout();
  // A supervisor sees only the pages they can use: Employees and Reports.
  const fullAdmin = isFullAdminRole(user?.role);

  return (
    <div className="shell shell--admin">
      <header className="header">
        <div className="header__bar">
          <span className="header__brand">
            <img className="header__mark" src={amcoMark} alt="AMCO" />
            CanteenHub <span className="header__tag">{fullAdmin ? 'Admin' : 'Supervisor'}</span>
          </span>
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
            {user.full_name} · {user.amco_id} · {roleLabel(user.role)}
          </p>
        )}

        <nav className="nav" aria-label="Admin">
          <NavLink
            to="/admin/employees"
            className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
          >
            Employees
          </NavLink>
          {fullAdmin && (
            <NavLink
              to="/admin/roster"
              className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
            >
              Roster
            </NavLink>
          )}
          <NavLink
            to="/admin/reports"
            className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
          >
            Reports
          </NavLink>
          {fullAdmin && (
            <>
              <NavLink
                to="/admin/menu"
                className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
              >
                Menus
              </NavLink>
              <NavLink
                to="/admin/imports"
                className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
              >
                Imports
              </NavLink>
              <NavLink
                to="/admin/settings"
                className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
              >
                Settings
              </NavLink>
            </>
          )}
          <Link to="/" className="nav__link">
            My portal
          </Link>
        </nav>
      </header>

      {children}
    </div>
  );
}
