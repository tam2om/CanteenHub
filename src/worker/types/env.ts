/**
 * Cloudflare Worker Environment Types
 */

import type { D1Database, Fetcher, R2Bucket } from '@cloudflare/workers-types';
import type { EmployeeWithRole, SessionData } from '../../shared/types/index.js';

export interface Env {
  // Cloudflare Bindings
  DB: D1Database;

  // R2 bucket holding the original uploaded import files. Optional in the type
  // so a deployment without the binding fails with a clear, handled error
  // rather than a runtime crash deep inside a request.
  IMPORTS?: R2Bucket;

  // The built SPA, so the Worker can serve index.html for a client-side route.
  // Optional in the type: a deployment without it still serves the API, and the
  // notFound handler degrades to a plain JSON 404 rather than crashing.
  ASSETS?: Fetcher;
  
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
