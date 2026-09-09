/**
 * Database Access Layer - Lunch Selections
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { LunchSelection, LunchChoice, SelectionSource, LunchSelectionHistory } from '../../shared/types/index.js';

export interface LunchSelectionDB extends LunchSelection {}
export interface LunchSelectionHistoryDB extends LunchSelectionHistory {}

/**
 * Get lunch selection for employee on specific date
 */
export async function getLunchSelection(
  db: D1Database,
  employeeId: number,
  mealDate: string
): Promise<LunchSelectionDB | null> {
  const result = await db
    .prepare('SELECT * FROM lunch_selections WHERE employee_id = ? AND meal_date = ?')
    .bind(employeeId, mealDate)
    .first<LunchSelectionDB>();
  
  return result || null;
}

/**
 * Create or update lunch selection
 */
export async function upsertLunchSelection(
  db: D1Database,
  employeeId: number,
  mealDate: string,
  choice: LunchChoice,
  source: SelectionSource = 'employee',
  setBy: number | null = null,
  overrideReason?: string | null
): Promise<LunchSelectionDB> {
  // Get existing selection for history
  const existing = await getLunchSelection(db, employeeId, mealDate);
  
  await db
    .prepare(`
      INSERT INTO lunch_selections (employee_id, meal_date, choice, source, set_by, override_reason)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(employee_id, meal_date) DO UPDATE SET
        choice = excluded.choice,
        source = excluded.source,
        set_by = excluded.set_by,
        override_reason = excluded.override_reason,
        updated_at = datetime('now')
    `)
    .bind(employeeId, mealDate, choice, source, setBy, overrideReason ?? null)
    .run();
  
  // Record history if there was a previous selection
  if (existing && existing.choice !== choice) {
    await recordSelectionHistory(db, {
      employee_id: employeeId,
      meal_date: mealDate,
      previous_choice: existing.choice,
      new_choice: choice,
      changed_by: setBy,
      source: source,
      override_reason: overrideReason ?? null,
      ip_address: null, // Will be set by caller if available
    });
  }
  
  return getLunchSelection(db, employeeId, mealDate) as Promise<LunchSelectionDB>;
}

/**
 * Record selection change in history
 */
async function recordSelectionHistory(
  db: D1Database,
  history: Omit<LunchSelectionHistoryDB, 'id' | 'changed_at'>
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO lunch_selection_history (
        employee_id, meal_date, previous_choice, new_choice,
        changed_by, source, override_reason, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      history.employee_id,
      history.meal_date,
      history.previous_choice ?? null,
      history.new_choice,
      history.changed_by ?? null,
      history.source,
      history.override_reason ?? null,
      history.ip_address ?? null
    )
    .run();
}

/**
 * Get selection history for employee
 */
export async function getSelectionHistory(
  db: D1Database,
  employeeId: number,
  limit: number = 50
): Promise<LunchSelectionHistoryDB[]> {
  const result = await db
    .prepare(`
      SELECT * FROM lunch_selection_history
      WHERE employee_id = ?
      ORDER BY changed_at DESC, meal_date DESC
      LIMIT ?
    `)
    .bind(employeeId, limit)
    .all<LunchSelectionHistoryDB>();
  
  return result.results || [];
}

/**
 * Get all selections for a specific date
 */
export async function getSelectionsByDate(
  db: D1Database,
  mealDate: string
): Promise<LunchSelectionDB[]> {
  const result = await db
    .prepare('SELECT * FROM lunch_selections WHERE meal_date = ? ORDER BY employee_id')
    .bind(mealDate)
    .all<LunchSelectionDB>();
  
  return result.results || [];
}

/**
 * Get selections summary for a date
 */
export async function getSelectionsSummary(
  db: D1Database,
  mealDate: string
): Promise<{
  option_1: number;
  option_2: number;
  no_preference: number;
  total: number;
}> {
  const result = await db
    .prepare(`
      SELECT 
        SUM(CASE WHEN choice = 'option_1' THEN 1 ELSE 0 END) as option_1,
        SUM(CASE WHEN choice = 'option_2' THEN 1 ELSE 0 END) as option_2,
        SUM(CASE WHEN choice = 'no_preference' THEN 1 ELSE 0 END) as no_preference,
        COUNT(*) as total
      FROM lunch_selections
      WHERE meal_date = ?
    `)
    .bind(mealDate)
    .first<{ option_1: number; option_2: number; no_preference: number; total: number }>();
  
  return {
    option_1: result?.option_1 ?? 0,
    option_2: result?.option_2 ?? 0,
    no_preference: result?.no_preference ?? 0,
    total: result?.total ?? 0,
  };
}

/**
 * Delete lunch selection
 */
export async function deleteLunchSelection(
  db: D1Database,
  employeeId: number,
  mealDate: string
): Promise<void> {
  await db
    .prepare('DELETE FROM lunch_selections WHERE employee_id = ? AND meal_date = ?')
    .bind(employeeId, mealDate)
    .run();
}
