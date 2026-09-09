/**
 * Shared integration-test fixtures.
 *
 * All data here is synthetic. No production employee names, AMCO IDs, menus or
 * rosters appear anywhere in the test suite.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { hashSessionToken } from '../../src/worker/lib/session.js';
import type { Env } from '../../src/worker/types/env.js';

export const ROLE_EMPLOYEE = 1;
export const ROLE_ADMIN = 2;
export const ROLE_SUPER_ADMIN = 3;

export interface SeededEmployee {
  id: number;
  amcoId: string;
  token: string;
  cookie: string;
}

export function testEnv(db: D1Database): Env {
  return {
    DB: db,
    ENVIRONMENT: 'local',
    FRONTEND_URL: 'http://localhost:5173',
  } as unknown as Env;
}

/**
 * Insert an employee and give them a live session, returning the Cookie header
 * that authenticates them. Requests in these tests go through the real session
 * middleware, so authorization is genuinely exercised rather than stubbed.
 */
export async function seedEmployee(
  db: D1Database,
  options: {
    amcoId: string;
    fullName?: string;
    rosterType?: 'regular' | 'shift' | 'amman_hq';
    roleId?: number;
    isActive?: boolean;
    department?: string;
    section?: string;
  }
): Promise<SeededEmployee> {
  const {
    amcoId,
    fullName = `Test ${amcoId}`,
    rosterType = 'regular',
    roleId = ROLE_EMPLOYEE,
    isActive = true,
    department = 'Test Department',
    section = 'Test Section',
  } = options;

  const inserted = await db
    .prepare(
      `INSERT INTO employees (amco_id, full_name, department, section, roster_type, is_active, role_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(amcoId, fullName, department, section, rosterType, isActive ? 1 : 0, roleId)
    .run();

  const id = inserted.meta.last_row_id as number;

  // A real opaque token, hashed at rest exactly as the app does.
  const token = `test-token-${amcoId}-${id}`;
  const tokenHash = await hashSessionToken(token);
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

  await db
    .prepare('INSERT INTO sessions (session_token_hash, employee_id, expires_at) VALUES (?, ?, ?)')
    .bind(tokenHash, id, expiresAt)
    .run();

  return { id, amcoId, token, cookie: `canteenhub_session=${token}` };
}

/** Create a menu day, returning its id. */
export async function seedMenuDay(
  db: D1Database,
  mealDate: string,
  status: 'draft' | 'published' | 'archived' = 'published'
): Promise<number> {
  const result = await db
    .prepare('INSERT INTO menu_days (meal_date, status) VALUES (?, ?)')
    .bind(mealDate, status)
    .run();
  return result.meta.last_row_id as number;
}

export async function seedRosterEntry(
  db: D1Database,
  employeeId: number,
  workDate: string,
  shiftValue: 'day' | 'night' | 'off'
): Promise<void> {
  await db
    .prepare('INSERT INTO roster_entries (employee_id, work_date, shift_value, source) VALUES (?, ?, ?, ?)')
    .bind(employeeId, workDate, shiftValue, 'manual')
    .run();
}

export async function setSetting(
  db: D1Database,
  key: string,
  value: string,
  valueType = 'string'
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value, value_type) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(key, value, valueType)
    .run();
}

export async function countRows(db: D1Database, sql: string, ...binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** JSON request helper for app.request(). */
export function jsonRequest(body: unknown, cookie?: string): RequestInit {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

/**
 * A future date that is comfortably beyond the old hard-coded 365-day horizon,
 * used to prove the next-eligible-date search is data-driven rather than capped.
 */
export function farFutureSunday(): string {
  // 2028-09-03 is a Sunday, ~730 days past 2026-09-09.
  return '2028-09-03';
}

/**
 * Standard API envelope returned by every route, for typed test assertions.
 */
export interface ApiBody {
  success: boolean;
  error?: string;
  message?: string;
  changed?: boolean;
  nextEligibleDate?: string | null;
  // Route payloads vary by endpoint; tests assert on specific fields.
  data?: any;
}

export async function readJson<T = ApiBody>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
