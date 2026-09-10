/**
 * CanteenHub Worker Entry Point
 * Cloudflare Worker handling API requests
 */

import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
import type { ScheduledController } from '@cloudflare/workers-types';
import { deleteExpiredSessions } from './db/sessions.js';
import { cleanupLoginAttempts } from './lib/rateLimit.js';
import { secureHeaders } from 'hono/secure-headers';
import type { Env, Variables } from './types/env.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { employeeRoutes } from './routes/employee.js';
import { menuRoutes } from './routes/menu.js';
import { rosterRoutes } from './routes/roster.js';
import { selectionRoutes } from './routes/selections.js';
import { adminRoutes } from './routes/admin.js';
import { meRoutes } from './routes/me.js';
import { importRoutes } from './routes/imports.js';
import { sessionMiddleware } from './middleware/session.js';

// Create the main application
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global middleware
app.use('*', secureHeaders());

// CORS configuration - only needed if frontend and API are on different origins.
// For Cloudflare Pages + Workers on the same account, same-origin is preferred.
//
// Hono calls this with (origin, context) - the request origin FIRST. The previous
// signature took the context as its only parameter, so `c.req` was undefined and
// every single request through the app threw a 500 before reaching a route.
const allowedOrigins = (origin: string, c: Context<{ Bindings: Env }>): string => {
  const env = c.env.ENVIRONMENT;

  // In production, only the configured frontend origin is echoed back.
  if (env === 'production') {
    return c.env.FRONTEND_URL ?? '';
  }

  // In local development, allow the Vite dev server.
  if (env === 'local') {
    return origin === 'http://localhost:5173' ? origin : 'http://localhost:5173';
  }

  return c.env.FRONTEND_URL || origin || '*';
};

app.use('*', cors({
  origin: allowedOrigins,
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// Health check endpoint (no auth required)
app.route('/api/health', healthRoutes);

// Authentication endpoints (no auth required)
app.route('/api/auth', authRoutes);

// Protected routes - all other API endpoints require authentication
app.use('/api/*', sessionMiddleware);

// Employee routes
app.route('/api/employees', employeeRoutes);

// Menu routes
app.route('/api/menu', menuRoutes);

// Roster routes
app.route('/api/roster', rosterRoutes);

// Selection routes
app.route('/api/selections', selectionRoutes);

// Employee self-service routes for the portal. Identity always comes from the
// session, never from the request.
app.route('/api/me', meRoutes);

// Admin import routes. Mounted BEFORE /api/admin so the more specific prefix
// wins; the router applies requireAuth + requireRole to everything it owns.
app.route('/api/admin/imports', importRoutes);

// Admin routes (employees, password, settings, holidays).
// The router applies requireAuth + requireRole to every endpoint it owns.
app.route('/api/admin', adminRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ success: false, error: 'Not Found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ 
    success: false, 
    error: c.env.ENVIRONMENT === 'production' ? 'Internal Server Error' : err.message 
  }, 500);
});

/**
 * Scheduled maintenance.
 *
 * Two tables accumulate rows that stop being useful the moment they expire:
 * `sessions` past their expiry, and `login_attempts` past the rate-limit
 * window. Neither is a record of anything - an expired session is already
 * refused on every read, and a stale attempt no longer counts toward a lockout
 * - so both grow without bound and without purpose until something removes
 * them. Nightly is often enough; the exact minute is offset so it does not
 * collide with every other Worker scheduled on the hour.
 *
 * DELIBERATELY NOT PURGED: audit_log, lunch_selection_history, roster_entries,
 * import_batches and import_batch_rows. Those ARE the record. Deleting them
 * needs a stated retention policy and an operator's decision, not a cron job
 * quietly making one.
 */
async function scheduled(_event: ScheduledController, env: Env): Promise<void> {
  try {
    const sessions = await deleteExpiredSessions(env.DB);
    const attempts = await cleanupLoginAttempts(env.DB);
    // Counts only - no identifiers, no tokens.
    console.log(
      JSON.stringify({ event: 'maintenance', expired_sessions: sessions, stale_login_attempts: attempts })
    );
  } catch (error) {
    // A failed cleanup must never take the Worker down; the next run retries.
    console.error('Scheduled maintenance failed:', error instanceof Error ? error.name : 'unknown');
  }
}

/**
 * The Hono app itself is the default export, with `scheduled` attached rather
 * than wrapped in a fresh object literal: the app carries `fetch` for the
 * runtime and `request` for tests, and replacing it with `{ fetch, scheduled }`
 * would take `app.request` away from every integration test in the suite.
 */
export default Object.assign(app, { scheduled });
