/**
 * CanteenHub Worker Entry Point
 * Cloudflare Worker handling API requests
 */

import { Hono, Context } from 'hono';
import { cors } from 'hono/cors';
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

export default app;
