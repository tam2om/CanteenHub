/**
 * Session Middleware
 * Validates session tokens and loads employee data
 */

import { Context, Next } from 'hono';
import type { Env, Variables, AuthenticatedVariables } from '../types/env.js';
import { getSessionByToken } from '../db/sessions.js';
import { getEmployeeById } from '../db/employees.js';

/**
 * Session middleware factory
 * Extracts session token from cookie and validates it
 */
export async function sessionMiddleware(c: Context<{ Bindings: Env; Variables: Variables }>, next: Next) {
  // Get session token from cookie
  const sessionCookie = c.req.header('Cookie');
  
  if (!sessionCookie) {
    c.set('session', null);
    c.set('employee', null);
    return next();
  }
  
  // Parse cookies manually (Hono has cookie helpers but we'll be explicit)
  const cookies = parseCookies(sessionCookie);
  const sessionToken = cookies.get('canteenhub_session');
  
  if (!sessionToken) {
    c.set('session', null);
    c.set('employee', null);
    return next();
  }
  
  try {
    // Look up session in database
    const session = await getSessionByToken(c.env.DB, sessionToken);
    
    if (!session || new Date(session.expires_at) < new Date()) {
      c.set('session', null);
      c.set('employee', null);
      return next();
    }
    
    // Load employee data
    const employee = await getEmployeeById(c.env.DB, session.employee_id);
    
    if (!employee || !employee.is_active) {
      c.set('session', null);
      c.set('employee', null);
      return next();
    }
    
    // Set session and employee in context
    c.set('session', {
      employee_id: session.employee_id,
      amco_id: employee.amco_id,
      role: getRoleName(employee.role_id),
      issued_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(new Date(session.expires_at).getTime() / 1000),
    });
    
    c.set('employee', {
      ...employee,
      role: getRoleName(employee.role_id),
    });
    
  } catch (error) {
    console.error('Session middleware error:', error);
    c.set('session', null);
    c.set('employee', null);
  }
  
  return next();
}

/**
 * Require authentication middleware
 * Returns 401 if not authenticated
 */
export async function requireAuth(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  next: Next
) {
  const session = c.get('session');
  
  if (!session) {
    return c.json({ success: false, error: 'Authentication required' }, 401);
  }
  
  return next();
}

/**
 * Require specific role middleware
 * Returns 403 if user doesn't have required role
 */
export function requireRole(...roles: Array<'employee' | 'admin' | 'super_admin'>) {
  return async (
    c: Context<{ Bindings: Env; Variables: AuthenticatedVariables }>,
    next: Next
  ) => {
    const employee = c.get('employee');
    
    if (!employee || !roles.includes(employee.role)) {
      return c.json({ success: false, error: 'Insufficient permissions' }, 403);
    }
    
    return next();
  };
}

/**
 * Parse cookie string into Map
 */
function parseCookies(cookieString: string): Map<string, string> {
  const cookies = new Map<string, string>();
  
  if (!cookieString) {
    return cookies;
  }
  
  const pairs = cookieString.split(';');
  for (const pair of pairs) {
    const [key, ...valueParts] = pair.trim().split('=');
    if (key && valueParts.length > 0) {
      cookies.set(key.trim(), valueParts.join('=').trim());
    }
  }
  
  return cookies;
}

/**
 * Get role name from role_id
 */
function getRoleName(roleId: number): 'employee' | 'admin' | 'super_admin' {
  switch (roleId) {
    case 1: return 'employee';
    case 2: return 'admin';
    case 3: return 'super_admin';
    default: return 'employee';
  }
}
