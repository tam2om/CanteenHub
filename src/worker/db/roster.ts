/**
 * Database Access Layer - Roster
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { RosterEntry, ShiftValue, ImportSource } from '../../shared/types/index.js';

export interface RosterEntryDB extends RosterEntry {}

/**
 * Get roster entry for employee on specific date
 */
export async function getRosterEntry(
  db: D1Database,
  employeeId: number,
  workDate: string
): Promise<RosterEntryDB | null> {
  const result = await db
    .prepare('SELECT * FROM roster_entries WHERE employee_id = ? AND work_date = ?')
    .bind(employeeId, workDate)
    .first<RosterEntryDB>();
  
  return result || null;
}

/**
 * Create or update roster entry
 */
export async function upsertRosterEntry(
  db: D1Database,
  employeeId: number,
  workDate: string,
  shiftValue: ShiftValue,
  source: ImportSource = 'manual'
): Promise<RosterEntryDB> {
  const result = await db
    .prepare(`
      INSERT INTO roster_entries (employee_id, work_date, shift_value, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(employee_id, work_date) DO UPDATE SET
        shift_value = excluded.shift_value,
        source = excluded.source,
        updated_at = datetime('now')
    `)
    .bind(employeeId, workDate, shiftValue, source)
    .run();
  
  return getRosterEntry(db, employeeId, workDate) as Promise<RosterEntryDB>;
}

/**
 * Get roster entries for employee in date range
 */
export async function getRosterEntriesForEmployee(
  db: D1Database,
  employeeId: number,
  startDate: string,
  endDate: string
): Promise<RosterEntryDB[]> {
  const result = await db
    .prepare(`
      SELECT * FROM roster_entries
      WHERE employee_id = ?
        AND work_date >= ?
        AND work_date <= ?
      ORDER BY work_date ASC
    `)
    .bind(employeeId, startDate, endDate)
    .all<RosterEntryDB>();
  
  return result.results || [];
}

/**
 * Get all roster entries for a specific date
 */
export async function getRosterEntriesByDate(
  db: D1Database,
  workDate: string
): Promise<RosterEntryDB[]> {
  const result = await db
    .prepare('SELECT * FROM roster_entries WHERE work_date = ? ORDER BY employee_id')
    .bind(workDate)
    .all<RosterEntryDB>();
  
  return result.results || [];
}

/**
 * Delete roster entry
 */
export async function deleteRosterEntry(
  db: D1Database,
  employeeId: number,
  workDate: string
): Promise<void> {
  await db
    .prepare('DELETE FROM roster_entries WHERE employee_id = ? AND work_date = ?')
    .bind(employeeId, workDate)
    .run();
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
): Promise<number> {
  let inserted = 0;
  
  const stmt = db.prepare(`
    INSERT INTO roster_entries (employee_id, work_date, shift_value, source)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(employee_id, work_date) DO UPDATE SET
      shift_value = excluded.shift_value,
      source = excluded.source,
      updated_at = datetime('now')
  `);
  
  const batch = entries.map(e => [e.employee_id, e.work_date, e.shift_value, e.source]);
  const result = await db.batch(batch.map(args => stmt.bind(...args)));
  
  return result.filter(r => r.success).length;
}
