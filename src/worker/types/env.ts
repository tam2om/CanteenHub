/**
 * Cloudflare Worker Environment Types
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { EmployeeWithRole, SessionData } from '../../shared/types/index.js';

export interface Env {
  // Cloudflare Bindings
  DB: D1Database;
  // BUCKET?: R2Bucket;  // Phase 2
  
  // Environment Variables
  ENVIRONMENT: 'local' | 'production';
  FRONTEND_URL: string;
  
  // Secrets (set via Wrangler, not in wrangler.toml)
  // SESSION_SECRET: string;  // Set via `wrangler secret put SESSION_SECRET`
}

export interface Variables {
  session: SessionData | null;
  employee: EmployeeWithRole | null;
}

export interface AuthenticatedVariables extends Variables {
  session: SessionData;
  employee: EmployeeWithRole;
}
