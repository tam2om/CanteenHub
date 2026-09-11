/**
 * Cloudflare Worker Environment Types
 */

import type { D1Database, Fetcher } from '@cloudflare/workers-types';
import type { EmployeeWithRole, SessionData } from '../../shared/types/index.js';

export interface Env {
  // Cloudflare Bindings.
  //
  // D1 is the ONLY durable store. There is no object store: uploaded workbooks
  // are validated in the request that carries them and are never persisted, so
  // everything CanteenHub can recover lives in this database.
  DB: D1Database;

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
