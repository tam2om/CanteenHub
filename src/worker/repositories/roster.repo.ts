/**
 * Repository Layer - Roster
 * Database access functions for roster operations
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { RosterEntry, ShiftValue, ImportSource } from '../../shared/types/index.js';

export interface RosterEntryWithDetails extends RosterEntry {
  employee_name: string;
  employee_amco_id: string;
}

export interface RosterMutationResult {
  entry: RosterEntry;
  beforeJson: string | null;
  afterJson: string | null;
}

export interface RosterDeleteResult {
  deleted: RosterEntry | null;
  beforeJson: string | null;
}

/**
 * Get roster entry for employee on specific date
 */
export async function getRosterEntry(
  db: D1Database,
  employeeId: number,
  workDate: string
): Promise<RosterEntry | null> {
  const result = await db
    .prepare('SELECT * FROM roster_entries WHERE employee_id = ? AND work_date = ? AND deleted_at IS NULL')
    .bind(employeeId, workDate)
    .first<RosterEntry>();
  
  return result || null;
}

/**
 * Get future roster entries for an employee (for next eligible date calculation)
 * Returns only Day/Night shifts, ordered by date ascending
 */
export async function getFutureEligibleShifts(
  db: D1Database,
  employeeId: number,
  fromDate: string // exclusive: > this date
): Promise<RosterEntry[]> {
  const result = await db
    .prepare(`
      SELECT * FROM roster_entries
      WHERE employee_id = ?
        AND work_date > ?
        AND shift_value IN ('day', 'night')
        AND deleted_at IS NULL
      ORDER BY work_date ASC
    `)
    .bind(employeeId, fromDate)
    .all<RosterEntry>();
  
  return result.results || [];
}

/**
 * Get all future published menu dates
 */
export async function getPublishedMenuDates(
  db: D1Database,
  fromDate: string // inclusive: >= this date
): Promise<Set<string>> {
  const result = await db
    .prepare(`
      SELECT meal_date FROM menu_days
      WHERE meal_date >= ? AND status = 'published'
      ORDER BY meal_date ASC
    `)
    .bind(fromDate)
    .all<{ meal_date: string }>();
  
  const dates = new Set<string>();
  (result.results || []).forEach(row => dates.add(row.meal_date));
  return dates;
}

/**
 * Create or update roster entry (returns the created/updated entry with audit info)
 */
export async function upsertRosterEntry(
  db: D1Database,
  employeeId: number,
  workDate: string,
  shiftValue: ShiftValue,
  source: ImportSource = 'manual'
): Promise<RosterMutationResult> {
  // Check if entry exists for audit purposes
  const existing = await db
    .prepare('SELECT * FROM roster_entries WHERE employee_id = ? AND work_date = ? AND deleted_at IS NULL')
    .bind(employeeId, workDate)
    .first<RosterEntry>();
  
  const beforeJson = existing ? JSON.stringify(existing) : null;
  
  await db
    .prepare(`
      INSERT INTO roster_entries (employee_id, work_date, shift_value, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(employee_id, work_date) DO UPDATE SET
        shift_value = excluded.shift_value,
        source = excluded.source,
        updated_at = datetime('now'),
        deleted_at = NULL
    `)
    .bind(employeeId, workDate, shiftValue, source)
    .run();
  
  const result = await getRosterEntry(db, employeeId, workDate);
  
  if (!result) {
    throw new Error('Failed to retrieve created/updated roster entry');
  }
  
  return {
    entry: result,
    beforeJson,
    afterJson: JSON.stringify(result)
  };
}

/**
 * Get roster entries for employee in date range
 */
export async function getRosterEntriesForEmployee(
  db: D1Database,
  employeeId: number,
  startDate: string,
  endDate: string
): Promise<RosterEntry[]> {
  const result = await db
    .prepare(`
      SELECT * FROM roster_entries
      WHERE employee_id = ?
        AND work_date >= ?
        AND work_date <= ?
        AND deleted_at IS NULL
      ORDER BY work_date ASC
    `)
    .bind(employeeId, startDate, endDate)
    .all<RosterEntry>();
  
  return result.results || [];
}

/**
 * Get all roster entries for a specific date
 */
export async function getRosterEntriesByDate(
  db: D1Database,
  workDate: string
): Promise<RosterEntryWithDetails[]> {
  const result = await db
    .prepare(`
      SELECT r.*, e.full_name as employee_name, e.amco_id as employee_amco_id
      FROM roster_entries r
      JOIN employees e ON r.employee_id = e.id
      WHERE r.work_date = ? AND r.deleted_at IS NULL
      ORDER BY e.full_name
    `)
    .bind(workDate)
    .all<RosterEntryWithDetails>();
  
  return result.results || [];
}

/**
 * Soft delete roster entry (preserves history via deleted_at)
 * Returns the deleted entry for audit logging
 */
export async function deleteRosterEntry(
  db: D1Database,
  employeeId: number,
  workDate: string
): Promise<RosterDeleteResult> {
  const existing = await db
    .prepare('SELECT * FROM roster_entries WHERE employee_id = ? AND work_date = ? AND deleted_at IS NULL')
    .bind(employeeId, workDate)
    .first<RosterEntry>();
  
  if (!existing) {
    return { deleted: null, beforeJson: null };
  }
  
  const beforeJson = JSON.stringify(existing);
  
  // Soft delete: set deleted_at instead of hard DELETE
  await db
    .prepare(`
      UPDATE roster_entries
      SET deleted_at = datetime('now'),
          updated_at = datetime('now')
      WHERE employee_id = ? AND work_date = ? AND deleted_at IS NULL
    `)
    .bind(employeeId, workDate)
    .run();
  
  return { deleted: existing, beforeJson };
}

/**
 * Bulk insert roster entries (for imports)
 */
export async function bulkInsertRosterEntries(
  db: D1Database,
  entries: Array<{
    employee_id: number;
    work_date: string;
    shift_value: ShiftValue;
    source: ImportSource;
  }>
): Promise<{ inserted: number; errors: Array<{ employee_id: number; work_date: string; error: string }> }> {
  let inserted = 0;
  const errors: Array<{ employee_id: number; work_date: string; error: string }> = [];
  
  const stmt = db.prepare(`
    INSERT INTO roster_entries (employee_id, work_date, shift_value, source)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(employee_id, work_date) DO UPDATE SET
      shift_value = excluded.shift_value,
      source = excluded.source,
      updated_at = datetime('now'),
      deleted_at = NULL
  `);
  
  const batch = entries.map(e => [e.employee_id, e.work_date, e.shift_value, e.source]);
  const results = await db.batch(batch.map(args => stmt.bind(...args)));
  
  results.forEach((result, index) => {
    if (result.success) {
      inserted++;
    } else {
      const entry = entries[index];
      errors.push({
        employee_id: entry.employee_id,
        work_date: entry.work_date,
        error: result.error?.message || 'Unknown error'
      });
    }
  });
  
  return { inserted, errors };
}
