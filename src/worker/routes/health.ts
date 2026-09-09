/**
 * Health Check Routes
 */

import { Hono } from 'hono';
import type { Env } from '../types/env.js';

export const healthRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/health
 * Returns worker status and database connectivity
 */
healthRoutes.get('/', async (c) => {
  const dbAvailable = c.env.DB !== undefined;
  
  let dbStatus = 'unknown';
  try {
    if (dbAvailable) {
      // Simple query to verify D1 is accessible
      await c.env.DB.prepare('SELECT 1 as ok').first();
      dbStatus = 'connected';
    } else {
      dbStatus = 'not_configured';
    }
  } catch (error) {
    console.error('Health check DB error:', error);
    dbStatus = 'error';
  }
  
  return c.json({
    success: true,
    data: {
      status: 'healthy',
      environment: c.env.ENVIRONMENT,
      timestamp: new Date().toISOString(),
      database: dbStatus,
    },
  });
});

/**
 * GET /api/health/ready
 * Kubernetes-style readiness probe
 */
healthRoutes.get('/ready', async (c) => {
  try {
    await c.env.DB.prepare('SELECT 1 as ok').first();
    return c.json({ ready: true });
  } catch {
    return c.json({ ready: false }, 503);
  }
});
