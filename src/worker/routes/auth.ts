/**
 * Authentication Routes
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { getEmployeeForAuth, setEmployeePassword } from '../db/employees.js';
import { createSession, deleteSessionByToken } from '../db/sessions.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { generateSessionToken, hashSessionToken } from '../lib/session.js';
import { checkLoginLockout, recordLoginAttempt } from '../lib/rateLimit.js';

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * POST /api/auth/login
 * Authenticate employee and create session
 */
authRoutes.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const { amco_id, password } = body;
    
    if (!amco_id || !password) {
      return c.json({ 
        success: false, 
        error: 'AMCO ID and password are required' 
      }, 400);
    }
    
    // Get client IP for rate limiting (if available)
    const clientIP = c.req.raw.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitIdentifier = `${clientIP}:${amco_id}`;
    
    // Check rate limiting - use combined IP+AMCO ID identifier
    const lockoutStatus = await checkLoginLockout(c.env.DB, rateLimitIdentifier);
    
    if (lockoutStatus.locked) {
      const retryAfterMinutes = Math.ceil((lockoutStatus.retryAfter ?? 0) / 60000);
      return c.json({ 
        success: false, 
        error: `Too many failed login attempts. Try again in ${retryAfterMinutes} minute(s).` 
      }, 429);
    }
    
    // Get employee with password hash
    const employee = await getEmployeeForAuth(c.env.DB, amco_id);
    
    if (!employee) {
      // Record failed attempt (don't reveal whether employee exists)
      await recordLoginAttempt(c.env.DB, rateLimitIdentifier, false);
      return c.json({ 
        success: false, 
        error: 'Invalid credentials' 
      }, 401);
    }
    
    if (!employee.password_hash) {
      await recordLoginAttempt(c.env.DB, rateLimitIdentifier, false);
      return c.json({ 
        success: false, 
        error: 'No password set. Contact administrator.' 
      }, 401);
    }
    
    // Verify password
    const valid = await verifyPassword(password, employee.password_hash);
    
    if (!valid) {
      await recordLoginAttempt(c.env.DB, rateLimitIdentifier, false);
      return c.json({ 
        success: false, 
        error: 'Invalid credentials' 
      }, 401);
    }
    
    // Successful login - record it and clear any previous failures
    await recordLoginAttempt(c.env.DB, rateLimitIdentifier, true);
    
    // Create session
    const sessionToken = generateSessionToken();
    const sessionTokenHash = await hashSessionToken(sessionToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours
    
    await createSession(c.env.DB, sessionTokenHash, employee.id, expiresAt);
    
    // Get role name
    const roleName = getRoleName(employee.role_id);
    
    // Set session cookie
    const cookieValue = `canteenhub_session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`;
    c.header('Set-Cookie', cookieValue);
    
    return c.json({
      success: true,
      data: {
        employee: {
          id: employee.id,
          amco_id: employee.amco_id,
          full_name: employee.full_name,
          role: roleName,
        },
      },
    });
    
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ 
      success: false, 
      error: 'Authentication failed' 
    }, 500);
  }
});

/**
 * POST /api/auth/logout
 * Destroy current session
 */
authRoutes.post('/logout', async (c) => {
  const sessionCookie = c.req.header('Cookie');
  
  if (sessionCookie) {
    const cookies = parseCookies(sessionCookie);
    const sessionToken = cookies.get('canteenhub_session');
    
    if (sessionToken) {
      await deleteSessionByToken(c.env.DB, sessionToken);
    }
  }
  
  // Clear cookie
  c.header('Set-Cookie', 'canteenhub_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  
  return c.json({ success: true });
});

/**
 * GET /api/auth/me
 * Get current authenticated user info
 */
authRoutes.get('/me', async (c) => {
  const employee = c.get('employee');
  
  if (!employee) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }
  
  return c.json({
    success: true,
    data: {
      id: employee.id,
      amco_id: employee.amco_id,
      full_name: employee.full_name,
      department: employee.department,
      section: employee.section,
      roster_type: employee.roster_type,
      role: employee.role,
    },
  });
});

/**
 * PUT /api/auth/change-password
 * Change own password
 */
authRoutes.put('/change-password', async (c) => {
  const employee = c.get('employee');
  
  if (!employee) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }
  
  try {
    const body = await c.req.json();
    const { current_password, new_password } = body;
    
    if (!current_password || !new_password) {
      return c.json({ 
        success: false, 
        error: 'Current and new password are required' 
      }, 400);
    }
    
    if (new_password.length < 8) {
      return c.json({ 
        success: false, 
        error: 'Password must be at least 8 characters' 
      }, 400);
    }
    
    // Get current employee with password hash
    const currentEmployee = await getEmployeeForAuth(c.env.DB, employee.amco_id);
    
    if (!currentEmployee || !currentEmployee.password_hash) {
      return c.json({ 
        success: false, 
        error: 'Cannot change password' 
      }, 400);
    }
    
    // Verify current password
    const valid = await verifyPassword(current_password, currentEmployee.password_hash);
    
    if (!valid) {
      return c.json({ 
        success: false, 
        error: 'Current password is incorrect' 
      }, 401);
    }
    
    // Hash and set new password
    const newPasswordHash = await hashPassword(new_password);
    await setEmployeePassword(c.env.DB, employee.id, newPasswordHash);
    
    return c.json({ success: true });
    
  } catch (error) {
    console.error('Change password error:', error);
    return c.json({ 
      success: false, 
      error: 'Failed to change password' 
    }, 500);
  }
});

/**
 * Generate a cryptographically secure random session token
 * Uses Web Crypto API for sufficient entropy (32 bytes = 256 bits)
 */
export function generateSessionToken(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(randomBytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
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
