/**
 * Authentication Routes
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { getEmployeeForAuth, setEmployeePassword } from '../db/employees.js';
import { createSession, deleteSessionByToken, deleteSessionsForEmployee } from '../db/sessions.js';
import { hashPassword, verifyPassword } from '../lib/auth.js';
import { generateSessionToken, hashSessionToken } from '../lib/session.js';
import { checkLoginLockout, recordLoginAttempt } from '../lib/rateLimit.js';
import { validatePassword } from '../lib/password.js';
import { logSelfPasswordChange } from '../services/audit.service.js';

export const authRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

/** Same shape the admin routes use, so audit rows record the IP uniformly. */
const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null;

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
        error: 'ID and password are required' 
      }, 400);
    }
    
    // Get client IP for rate limiting (if available)
    const clientIP = c.req.raw.headers.get('CF-Connecting-IP') || 'unknown';
    // NORMALISED. The AMCO ID is matched case-insensitively, so the lockout
    // bucket must be too: otherwise "admin001", "Admin001" and "ADMIN001" are
    // three separate buckets and an attacker gets the full attempt allowance
    // once per spelling.
    const rateLimitIdentifier = `${clientIP}:${String(amco_id).trim().toUpperCase()}`;
    
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
 * PUT /api/auth/change-password - change YOUR OWN password.
 *
 * WHOSE PASSWORD IS CHANGED: the one belonging to the session that made the
 * request. There is no id in the path, none is read from the body, and the
 * route never looks one up from client input - so there is no parameter an
 * attacker could aim at somebody else's account.
 *
 * Open to any authenticated user, not administrators only. An employee whose
 * password was handed to them in person needs to be able to replace it with
 * something only they know; restricting that to admins would leave every
 * employee permanently using a credential a third party has seen.
 *
 * The current password is verified SERVER-SIDE against the stored hash before
 * anything is written. A live session alone is not sufficient authority to
 * replace the credential that session was created with.
 *
 * Handling of the plaintext: both values exist only for the duration of this
 * request. They are used to verify and to derive a hash, then discarded. They
 * are never stored, returned, logged, or written into audit JSON - which is why
 * the catch block below logs the error NAME and not the request body.
 */
authRoutes.put('/change-password', async (c) => {
  const employee = c.get('employee');
  const session = c.get('session');

  if (!employee || !session) {
    return c.json({ success: false, error: 'Not authenticated' }, 401);
  }

  let body: { current_password?: unknown; new_password?: unknown; confirm_password?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'A JSON body is required' }, 400);
  }

  const { current_password, new_password, confirm_password } = body;

  if (typeof current_password !== 'string' || current_password.length === 0) {
    return c.json({ success: false, error: 'Current password is required' }, 400);
  }
  if (typeof new_password !== 'string' || new_password.length === 0) {
    return c.json({ success: false, error: 'New password is required' }, 400);
  }
  if (typeof confirm_password !== 'string' || confirm_password.length === 0) {
    return c.json({ success: false, error: 'Confirm the new password' }, 400);
  }

  // Checked before the policy so a simple typo is reported as a typo rather
  // than as whichever rule the mistyped value happens to break.
  if (new_password !== confirm_password) {
    return c.json({ success: false, error: 'The new passwords do not match' }, 400);
  }

  // The SHARED validator - the same one the administrator path uses. This
  // route used to carry its own `< 8` check, which silently disagreed with the
  // policy module and let a password through that no other path would accept.
  const validation = validatePassword(new_password);
  if (!validation.valid) {
    // Names the rule that was broken, never the value that broke it.
    return c.json({ success: false, error: validation.error }, 400);
  }

  if (new_password === current_password) {
    return c.json(
      { success: false, error: 'The new password must be different from the current one' },
      400
    );
  }

  try {
    const currentEmployee = await getEmployeeForAuth(c.env.DB, employee.amco_id);

    if (!currentEmployee || !currentEmployee.password_hash) {
      // An account with no password set cannot prove a "current" one. The
      // administrator sets the first password; that path is unchanged.
      return c.json({ success: false, error: 'Cannot change password' }, 400);
    }

    const valid = await verifyPassword(current_password, currentEmployee.password_hash);
    if (!valid) {
      return c.json({ success: false, error: 'Current password is incorrect' }, 401);
    }

    // The EXISTING hashing implementation (PBKDF2-SHA-256, 100k iterations).
    // No second scheme is introduced here.
    const newPasswordHash = await hashPassword(new_password);
    await setEmployeePassword(c.env.DB, employee.id, newPasswordHash);

    // Revoke every session this employee holds, exactly as the administrator
    // path does. The old password must stop granting access immediately, and a
    // live cookie would otherwise outlive it - including the caller's own,
    // which is why the client has to sign in again.
    const sessionsRevoked = await deleteSessionsForEmployee(c.env.DB, employee.id);

    await logSelfPasswordChange(
      c.env.DB,
      employee.id,
      employee.amco_id,
      sessionsRevoked,
      clientIp(c)
    );

    // A confirmation and a count. No password, no hash.
    return c.json({
      success: true,
      data: { password_changed: true, sessionsRevoked },
    });
  } catch (error) {
    // Logged WITHOUT the request body, which holds both plaintexts.
    console.error('Change password failed for employee id', employee.id);
    if (error instanceof Error) console.error('Change password failure:', error.name);
    return c.json({ success: false, error: 'Failed to change password' }, 500);
  }
});

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
