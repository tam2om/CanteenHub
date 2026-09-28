/**
 * What each role may do in the admin area - for DISPLAY only.
 *
 * The server is the authority: routes/admin.ts refuses every one of these
 * actions whatever the browser shows. This module exists so the screen never
 * offers a button that can only produce a 403, and so those rules live in one
 * place rather than as `role === ...` checks scattered across pages. It mirrors
 * `refuseActingOn` and SUPERVISOR_ENDPOINTS on the server.
 */

import { ROLE_IDS } from '../types/index.js';

const FULL_ADMIN = ['admin', 'super_admin'];
const BACK_OFFICE = ['admin', 'super_admin', 'supervisor'];

/** Allowed into the admin area at all. */
export function isBackOfficeRole(role: string | undefined): boolean {
  return role !== undefined && BACK_OFFICE.includes(role);
}

/** Everything in the admin area: imports, menus, roster, settings, passwords... */
export function isFullAdminRole(role: string | undefined): boolean {
  return role !== undefined && FULL_ADMIN.includes(role);
}

/**
 * May this actor change this person's account at all?
 *
 * A supervisor looks after employees only; a super administrator's account is
 * changed only by a super administrator.
 */
export function canActOn(actorRole: string | undefined, targetRoleId: number | undefined): boolean {
  const target = targetRoleId ?? ROLE_IDS.employee;
  if (actorRole === 'supervisor') return target === ROLE_IDS.employee;
  if (target === ROLE_IDS.super_admin) return actorRole === 'super_admin';
  return isFullAdminRole(actorRole);
}

/** Actions only a full administrator has - never a supervisor. */
export function canManageAccounts(actorRole: string | undefined): boolean {
  return isFullAdminRole(actorRole);
}

export function roleLabel(role: string | undefined): string {
  switch (role) {
    case 'super_admin':
      return 'Super admin';
    case 'admin':
      return 'Admin';
    case 'supervisor':
      return 'Supervisor';
    default:
      return 'Employee';
  }
}
