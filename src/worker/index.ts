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
import { sessionMiddleware } from './middleware/session.js';

// Create the main application
const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Global middleware
app.use('*', secureHeaders());

// CORS configuration - only needed if frontend and API are on different origins
// For Cloudflare Pages + Workers on the same account, same-origin is preferred
const allowedOrigins = (c: Context<{ Bindings: Env }>) => {
  const origin = c.req.header('Origin');
  const env = c.env.ENVIRONMENT;
  
  // In production, use configured Frontend URL
  if (env === 'production' && c.env.FRONTEND_URL) {
    return origin === c.env.FRONTEND_URL ? c.env.FRONTEND_URL : c.env.FRONTEND_URL;
  }
  
  // In local development, allow localhost
  if (env === 'local') {
    return origin === 'http://localhost:5173' ? 'http://localhost:5173' : 'http://localhost:5173';
  }
  
  return c.env.FRONTEND_URL || '*';
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
