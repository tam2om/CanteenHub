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
  /**
   * False when the entry already held this value, so nothing was written.
   *
   * Mirrors the convention selections.repo.ts established: an audit trail full
   * of "changed day to day" entries hides the changes that matter, so the
   * caller skips the audit record when nothing actually changed.
   */
  changed: boolean;
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
 * Get published menu dates on or after `fromDate`, in ascending order.
 *
 * Returned as an ordered array rather than a Set because the next-eligible-date
 * calculation walks the ACTUAL published menu dates. That is what allows it to
 * work without an arbitrary calendar search horizon: the data bounds the search,
 * not a magic number.
 */
export async function getPublishedMenuDates(
  db: D1Database,
  fromDate: string // inclusive: >= this date
): Promise<string[]> {
  const result = await db
    .prepare(`
      SELECT meal_date FROM menu_days
      WHERE meal_date >= ? AND status = 'published'
      ORDER BY meal_date ASC
    `)
    .bind(fromDate)
    .all<{ meal_date: string }>();

  return (result.results || []).map(row => row.meal_date);
}

/**
 * Escape the characters LIKE treats as wildcards, for use with ESCAPE '\\'.
 *
 * The backslash goes first: escaping it after % and _ would double-escape the
 * markers just added.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** One employee's roster standing for a date. `shift_value` null = no entry. */
export interface RosterDayRow {
  employee_id: number;
  amco_id: string;
  full_name: string;
  department: string | null;
  section: string | null;
  roster_type: string;
  is_active: number;
  /** The roster entry's own id, or null when there is no entry. */
  roster_entry_id: number | null;
  /** 'day' | 'night' | 'off', or NULL meaning the roster is genuinely missing. */
  shift_value: string | null;
  source: string | null;
}

export interface RosterDayFilters {
  /** Matched against name and AMCO ID, case-insensitively. */
  search?: string;
  rosterType?: string;
}

/**
 * Every employee's roster standing for one date, in ONE query.
 *
 * A LEFT JOIN, deliberately: getRosterEntriesByDate joins the other way and so
 * can only show employees who already HAVE an entry. The employees who do not
 * are exactly the ones an administrator opens this screen to find - they are
 * the ROSTER_MISSING cases - and an inner join renders them invisible.
 *
 * `shift_value` is NULL for them rather than 'off'. The distinction matters:
 * 'off' is a roster decision someone made, missing is the absence of one, and
 * the eligibility engine reports them as different reasons.
 */
export async function getRosterForDate(
  db: D1Database,
  workDate: string,
  filters: RosterDayFilters = {}
): Promise<RosterDayRow[]> {
  const where: string[] = [];
  const binds: Array<string | number> = [workDate];

  if (filters.search) {
    // Bound as a parameter, so the term can never alter the SQL. It is also
    // escaped: LIKE treats % and _ as wildcards, so an administrator searching
    // for "50%" would otherwise match everybody rather than nobody.
    where.push(
      "(LOWER(e.full_name) LIKE ? ESCAPE '\\' OR LOWER(e.amco_id) LIKE ? ESCAPE '\\')"
    );
    const term = `%${escapeLikeTerm(filters.search.toLowerCase())}%`;
    binds.push(term, term);
  }

  if (filters.rosterType) {
    where.push('e.roster_type = ?');
    binds.push(filters.rosterType);
  }

  const result = await db
    .prepare(
      `SELECT
         e.id            AS employee_id,
         e.amco_id       AS amco_id,
         e.full_name     AS full_name,
         e.department    AS department,
         e.section       AS section,
         e.roster_type   AS roster_type,
         e.is_active     AS is_active,
         r.id            AS roster_entry_id,
         r.shift_value   AS shift_value,
         r.source        AS source
       FROM employees e
       LEFT JOIN roster_entries r
         ON r.employee_id = e.id
        AND r.work_date = ?
        AND r.deleted_at IS NULL
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.full_name, e.amco_id`
    )
    .bind(...binds)
    .all<RosterDayRow>();

  return result.results || [];
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

  // Re-setting the value an entry already holds writes nothing. The AFTER
  // UPDATE trigger would otherwise rewrite updated_at, and the route would
  // record an audit entry describing a change that did not happen.
  if (existing && existing.shift_value === shiftValue && existing.source === source) {
    return {
      entry: existing,
      beforeJson,
      afterJson: beforeJson,
      changed: false,
    };
  }
  
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
    afterJson: JSON.stringify(result),
    changed: true,
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
        error: (result as { error?: { message?: string } }).error?.message || 'Unknown error'
      });
    }
  });
  
  return { inserted, errors };
}
