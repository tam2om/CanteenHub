/**
 * Roles: the one place role ids and role names are related.
 *
 * `employees.role_id` stores a number; every permission check works on a name.
 * This mapping used to be written out twice - once for login, once for the
 * session middleware - which is exactly how a new role ends up recognised on
 * one path and silently treated as a plain employee on the other. It exists
 * once now, and both paths import it.
 *
 * The ids must agree with the `roles` table (migrations 0001 and 0006).
 */

import type { Role } from '../../shared/types/index.js';

export const ROLE_IDS = {
  employee: 1,
  admin: 2,
  super_admin: 3,
  supervisor: 4,
} as const satisfies Record<Role, number>;

const NAME_BY_ID = new Map<number, Role>(
  (Object.entries(ROLE_IDS) as Array<[Role, number]>).map(([name, id]) => [id, name])
);

/** Every role id an administrator may assign. */
export const ASSIGNABLE_ROLE_IDS: readonly number[] = Object.values(ROLE_IDS);

/**
 * The role name for an id. An id this code does not know falls back to the
 * LEAST privileged role rather than guessing upwards.
 */
export function roleName(roleId: number): Role {
  return NAME_BY_ID.get(roleId) ?? 'employee';
}

/** Full administrators: everything in the admin area. */
export const ADMIN_ROLES: readonly Role[] = ['admin', 'super_admin'];

/**
 * Everyone allowed into the admin area at all. A supervisor is let in, then
 * limited to an explicit allowlist of endpoints - see routes/admin.ts.
 */
export const BACK_OFFICE_ROLES: readonly Role[] = ['admin', 'super_admin', 'supervisor'];
