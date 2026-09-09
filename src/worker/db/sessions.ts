/**
 * Database Access Layer - Sessions
 */

import type { D1Database } from '@cloudflare/workers-types';
import { hashSessionToken } from '../lib/session.js';

export interface SessionDB {
  id: number;
  session_token_hash: string;
  employee_id: number;
  expires_at: string;
  created_at: string;
}

/**
 * Create a new session
 */
export async function createSession(
  db: D1Database,
  sessionTokenHash: string,
  employeeId: number,
  expiresAt: string
): Promise<SessionDB> {
  const result = await db
    .prepare(`
      INSERT INTO sessions (session_token_hash, employee_id, expires_at)
      VALUES (?, ?, ?)
    `)
    .bind(sessionTokenHash, employeeId, expiresAt)
    .run();
  
  return getSessionById(db, result.meta.last_row_id as number) as Promise<SessionDB>;
}

/**
 * Get session by ID
 */
export async function getSessionById(db: D1Database, id: number): Promise<SessionDB | null> {
  const result = await db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .bind(id)
    .first<SessionDB>();
  
  return result || null;
}

/**
 * Get session by token hash
 */
export async function getSessionByToken(db: D1Database, token: string): Promise<SessionDB | null> {
  // Hash the incoming token to compare with stored hash
  const tokenHash = await hashSessionToken(token);
  
  const result = await db
    .prepare('SELECT * FROM sessions WHERE session_token_hash = ?')
    .bind(tokenHash)
    .first<SessionDB>();
  
  return result || null;
}

/**
 * Delete session by token
 */
export async function deleteSessionByToken(db: D1Database, token: string): Promise<void> {
  const tokenHash = await hashSessionToken(token);
  
  await db
    .prepare('DELETE FROM sessions WHERE session_token_hash = ?')
    .bind(tokenHash)
    .run();
}

/**
 * Delete EVERY session belonging to one employee.
 *
 * Used when an administrator sets a new password, and when an employee is
 * deactivated: the point of both actions is that the old credential stops
 * working immediately, which it does not if a previously issued session cookie
 * still authenticates. Sessions are opaque server-side rows (the token is stored
 * only as a SHA-256 hash), so deleting the rows is what revocation means here -
 * there is no stateless token left to keep working.
 *
 * Returns the number of sessions revoked.
 */
export async function deleteSessionsForEmployee(
  db: D1Database,
  employeeId: number
): Promise<number> {
  const result = await db
    .prepare('DELETE FROM sessions WHERE employee_id = ?')
    .bind(employeeId)
    .run();

  return (result.meta?.changes as number | undefined) ?? 0;
}

/**
 * Delete expired sessions (cleanup)
 */
export async function deleteExpiredSessions(db: D1Database): Promise<number> {
  const result = await db
    .prepare("DELETE FROM sessions WHERE expires_at < datetime('now')")
    .run();
  
  return result.meta.changes ?? 0;
}
