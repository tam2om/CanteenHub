/**
 * Employee response shaping.
 *
 * `getEmployeeById` and friends run `SELECT *`, so the row they return includes
 * `password_hash`. Any route that serialises that row straight into a JSON
 * response leaks the stored credential to the client. This module is the single
 * place that strips it, so "did we remember to remove the hash here?" has one
 * answer instead of one per endpoint.
 */

import type { Employee } from '../../shared/types/index.js';

/** An employee row with any credential material removed. */
export type PublicEmployee<T> = Omit<T, 'password_hash'>;

/**
 * Strip credential material from an employee row before it leaves the Worker.
 *
 * Constrained to Employee rather than a record index signature, so it accepts
 * the concrete row types the db layer returns (EmployeeDB and friends) while
 * still guaranteeing the caller is passing an employee.
 */
export function toPublicEmployee<T extends Employee>(employee: T): PublicEmployee<T> {
  const { password_hash: _passwordHash, ...safe } = employee as T & { password_hash?: unknown };
  return safe as PublicEmployee<T>;
}

export function toPublicEmployees<T extends Employee>(employees: T[]): Array<PublicEmployee<T>> {
  return employees.map(toPublicEmployee);
}
