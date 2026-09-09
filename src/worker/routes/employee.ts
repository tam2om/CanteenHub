/**
 * Employee Routes
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { getEmployeeById } from '../db/employees.js';

export const employeeRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/employees
 * List employees (admin only in Phase 2, for now returns current user's info)
 */
employeeRoutes.get('/', async (c) => {
  const employee = c.get('employee');
  
  if (!employee) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }
  
  // For Phase 1, just return the current employee's info
  // Full employee listing will be admin-only in Phase 2
  return c.json({
    success: true,
    data: {
      employees: [employee],
      total: 1,
    },
  });
});

/**
 * GET /api/employees/:id
 * Get employee by ID
 */
employeeRoutes.get('/:id', async (c) => {
  const employee = c.get('employee');
  
  if (!employee) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }
  
  const id = parseInt(c.req.param('id'), 10);
  
  if (isNaN(id)) {
    return c.json({ success: false, error: 'Invalid employee ID' }, 400);
  }
  
  // In Phase 1, employees can only view their own profile
  if (id !== employee.id && employee.role === 'employee') {
    return c.json({ success: false, error: 'Insufficient permissions' }, 403);
  }
  
  const targetEmployee = await getEmployeeById(c.env.DB, id);
  
  if (!targetEmployee) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }
  
  return c.json({
    success: true,
    data: targetEmployee,
  });
});
