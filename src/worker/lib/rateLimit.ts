/**
 * Rate Limiting for Login Attempts
 * Prevents brute-force password guessing attacks
 */

import type { D1Database } from '@cloudflare/workers-types';

const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export interface LoginAttemptRecord {
  id: number;
  identifier: string; // IP address or AMCO ID
  attempt_time: string;
  success: number;
}

/**
 * Record a login attempt
 */
export async function recordLoginAttempt(
  db: D1Database,
  identifier: string,
  success: boolean
): Promise<void> {
  const now = new Date().toISOString();
  
  await db
    .prepare(`
      INSERT INTO login_attempts (identifier, attempt_time, success)
      VALUES (?, ?, ?)
    `)
    .bind(identifier, now, success ? 1 : 0)
    .run();
}

/**
 * Check if an identifier is locked out due to too many failed attempts
 * Returns { locked: true, retryAfter: milliseconds } if locked out
 * Returns { locked: false } if not locked out
 */
export async function checkLoginLockout(
  db: D1Database,
  identifier: string
): Promise<{ locked: boolean; retryAfter?: number }> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - ATTEMPT_WINDOW_MS).toISOString();
  
  // Count failed attempts in the window
  const result = await db
    .prepare(`
      SELECT COUNT(*) as failed_count, 
             MAX(attempt_time) as last_attempt
      FROM login_attempts
      WHERE identifier = ?
        AND success = 0
        AND attempt_time >= ?
    `)
    .bind(identifier, windowStart)
    .first<{ failed_count: number; last_attempt: string | null }>();
  
  const failedCount = result?.failed_count ?? 0;
  
  if (failedCount >= MAX_ATTEMPTS) {
    // Get the time of the first failed attempt in the current burst
    const firstFailed = await db
      .prepare(`
        SELECT MIN(attempt_time) as first_attempt
        FROM login_attempts
        WHERE identifier = ?
          AND success = 0
          AND attempt_time >= ?
      `)
      .bind(identifier, windowStart)
      .first<{ first_attempt: string }>();
    
    if (firstFailed?.first_attempt) {
      const firstAttemptTime = new Date(firstFailed.first_attempt).getTime();
      const lockoutEnd = firstAttemptTime + LOCKOUT_DURATION_MS;
      const retryAfter = Math.max(0, lockoutEnd - now.getTime());
      
      if (retryAfter > 0) {
        return { locked: true, retryAfter };
      }
    }
  }
  
  return { locked: false };
}

/**
 * Clean up old login attempt records
 * Should be called periodically (e.g., once per hour)
 */
export async function cleanupLoginAttempts(db: D1Database): Promise<number> {
  const cutoff = new Date(Date.now() - LOCKOUT_DURATION_MS * 2).toISOString();
  
  const result = await db
    .prepare('DELETE FROM login_attempts WHERE attempt_time < ?')
    .bind(cutoff)
    .run();
  
  return result.meta.changes ?? 0;
}

/**
 * Get recent login attempts for auditing
 */
export async function getRecentLoginAttempts(
  db: D1Database,
  limit: number = 100
): Promise<LoginAttemptRecord[]> {
  const result = await db
    .prepare(`
      SELECT * FROM login_attempts
      ORDER BY attempt_time DESC
      LIMIT ?
    `)
    .bind(limit)
    .all<LoginAttemptRecord>();
  
  return result.results || [];
}
