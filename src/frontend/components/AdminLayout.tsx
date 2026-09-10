/**
 * Admin shell: header, navigation, content area, logout.
 * Deliberately the same visual language as the employee portal - one stylesheet,
 * no separate design system.
 */

import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useLogout, useSession } from '../hooks/useSession.js';

export function AdminLayout({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const logout = useLogout();

  return (
    <div className="shell shell--admin">
      <header className="header">
        <div className="header__bar">
          <span className="header__brand">
            CanteenHub <span className="header__tag">Admin</span>
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
            {user.full_name} · {user.amco_id} · {user.role === 'super_admin' ? 'Super admin' : 'Admin'}
          </p>
        )}

        <nav className="nav" aria-label="Admin">
          <NavLink
            to="/admin/employees"
            className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
          >
            Employees
          </NavLink>
          <NavLink
            to="/admin/menu"
            className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
          >
            Menus
          </NavLink>
          <NavLink
            to="/admin/imports/employees"
            className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
          >
            Employee import
          </NavLink>
          <NavLink
            to="/admin/imports/roster"
            className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
          >
            Roster import
          </NavLink>
          <NavLink
            to="/admin/imports/menu"
            className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
          >
            Menu import
          </NavLink>
          <NavLink
            to="/admin/settings"
            className={({ isActive }) => `nav__link ${isActive ? 'nav__link--active' : ''}`}
          >
            Settings
          </NavLink>
          <Link to="/" className="nav__link">
            My portal
          </Link>
        </nav>
      </header>

      {children}
    </div>
  );
}
