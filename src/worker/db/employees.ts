/**
 * Database Access Layer - Employees
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Employee } from '../../shared/types/index.js';

export interface EmployeeDB extends Employee {
  role_id: number;
}

/**
 * Get employee by ID
 */
export async function getEmployeeById(db: D1Database, id: number): Promise<EmployeeDB | null> {
  const result = await db
    .prepare('SELECT * FROM employees WHERE id = ?')
    .bind(id)
    .first<EmployeeDB>();
  
  return result || null;
}

/**
 * Get employee by AMCO ID
 */
export async function getEmployeeByAmcoId(db: D1Database, amcoId: string): Promise<EmployeeDB | null> {
  const result = await db
    .prepare('SELECT * FROM employees WHERE amco_id = ?')
    .bind(amcoId)
    .first<EmployeeDB>();
  
  return result || null;
}

/**
 * Get employee with password hash for authentication
 * Only used internally during login
 */
export async function getEmployeeForAuth(db: D1Database, amcoId: string): Promise<(EmployeeDB & { password_hash: string | null }) | null> {
  const result = await db
    .prepare('SELECT * FROM employees WHERE amco_id = ? AND is_active = 1')
    .bind(amcoId)
    .first<EmployeeDB & { password_hash: string | null }>();
  
  return result || null;
}

/**
 * Create new employee
 */
export async function createEmployee(
  db: D1Database,
  data: {
    amco_id: string;
    full_name: string;
    department?: string | null;
    section?: string | null;
    roster_type: 'regular' | 'shift' | 'amman_hq';
    role_id?: number;
  }
): Promise<EmployeeDB> {
  const roleId = data.role_id ?? 1; // Default to employee role
  
  const result = await db
    .prepare(`
      INSERT INTO employees (amco_id, full_name, department, section, roster_type, role_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .bind(data.amco_id, data.full_name, data.department ?? null, data.section ?? null, data.roster_type, roleId)
    .run();
  
  return getEmployeeById(db, result.meta.last_row_id as number) as Promise<EmployeeDB>;
}

/**
 * Update employee
 */
export async function updateEmployee(
  db: D1Database,
  id: number,
  data: Partial<{
    full_name: string;
    department: string | null;
    section: string | null;
    roster_type: 'regular' | 'shift' | 'amman_hq';
    is_active: boolean;
    role_id: number;
  }>
): Promise<EmployeeDB | null> {
  const updates: string[] = [];
  const binds: Array<string | number | null> = [];
  
  if (data.full_name !== undefined) {
    updates.push('full_name = ?');
    binds.push(data.full_name);
  }
  if (data.department !== undefined) {
    updates.push('department = ?');
    binds.push(data.department);
  }
  if (data.section !== undefined) {
    updates.push('section = ?');
    binds.push(data.section);
  }
  if (data.roster_type !== undefined) {
    updates.push('roster_type = ?');
    binds.push(data.roster_type);
  }
  if (data.is_active !== undefined) {
    updates.push('is_active = ?');
    binds.push(data.is_active ? 1 : 0);
  }
  if (data.role_id !== undefined) {
    updates.push('role_id = ?');
    binds.push(data.role_id);
  }
  
  if (updates.length === 0) {
    return getEmployeeById(db, id);
  }
  
  updates.push('updated_at = datetime(\'now\')');
  binds.push(id);
  
  await db
    .prepare(`UPDATE employees SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  
  return getEmployeeById(db, id);
}

/**
 * Set employee password hash
 */
export async function setEmployeePassword(
  db: D1Database,
  id: number,
  passwordHash: string
): Promise<void> {
  await db
    .prepare('UPDATE employees SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(passwordHash, id)
    .run();
}

/**
 * List employees with pagination
 */
export async function listEmployees(
  db: D1Database,
  options: {
    page?: number;
    pageSize?: number;
    search?: string;
    rosterType?: 'regular' | 'shift' | 'amman_hq';
    isActive?: boolean;
  } = {}
): Promise<{ employees: EmployeeDB[]; total: number }> {
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 20;
  const offset = (page - 1) * pageSize;
  
  const whereClauses: string[] = [];
  const binds: Array<string | number | null> = [];
  
  if (options.search) {
    whereClauses.push('(full_name LIKE ? OR amco_id LIKE ? OR department LIKE ?)');
    const searchTerm = `%${options.search}%`;
    binds.push(searchTerm, searchTerm, searchTerm);
  }
  
  if (options.rosterType) {
    whereClauses.push('roster_type = ?');
    binds.push(options.rosterType);
  }
  
  if (options.isActive !== undefined) {
    whereClauses.push('is_active = ?');
    binds.push(options.isActive ? 1 : 0);
  }
  
  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  
  // Get total count
  const countQuery = `SELECT COUNT(*) as count FROM employees ${whereClause}`;
  const countResult = await db.prepare(countQuery).bind(...binds).first<{ count: number }>();
  const total = countResult?.count ?? 0;
  
  // Get paginated results
  binds.push(pageSize, offset);
  const query = `
    SELECT * FROM employees 
    ${whereClause}
    ORDER BY full_name ASC
    LIMIT ? OFFSET ?
  `;
  
  const { results } = await db.prepare(query).bind(...binds).all<EmployeeDB>();
  
  return {
    employees: results || [],
    total,
  };
}
