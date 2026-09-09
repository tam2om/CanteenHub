/**
 * Repository Layer - Lunch Selections
 * Database access functions for selection operations
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { LunchSelection, LunchChoice, SelectionSource, LunchSelectionHistory } from '../../shared/types/index.js';

export interface SelectionMutationResult {
  selection: LunchSelection;
  historyRecord: LunchSelectionHistory;
  beforeJson: string | null;
  afterJson: string | null;
}

/**
 * Get employee's selection for a specific date
 */
export async function getSelectionByEmployeeAndDate(
  db: D1Database,
  employeeId: number,
  mealDate: string
): Promise<LunchSelection | null> {
  const result = await db
    .prepare('SELECT * FROM lunch_selections WHERE employee_id = ? AND meal_date = ?')
    .bind(employeeId, mealDate)
    .first<LunchSelection>();
  
  return result || null;
}

/**
 * Get all selections for a specific date (admin view)
 */
export async function getSelectionsByDate(
  db: D1Database,
  mealDate: string
): Promise<Array<LunchSelection & { employee_name: string; employee_amco_id: string }>> {
  const result = await db
    .prepare(`
      SELECT ls.*, e.full_name as employee_name, e.amco_id as employee_amco_id
      FROM lunch_selections ls
      JOIN employees e ON ls.employee_id = e.id
      WHERE ls.meal_date = ?
      ORDER BY e.full_name
    `)
    .bind(mealDate)
    .all<LunchSelection & { employee_name: string; employee_amco_id: string }>();
  
  return result.results || [];
}

/**
 * Create or update employee's lunch selection
 * Also creates a history record
 */
export async function upsertSelection(
  db: D1Database,
  employeeId: number,
  mealDate: string,
  choice: LunchChoice,
  source: SelectionSource = 'employee',
  setBy: number | null = null,
  overrideReason: string | null = null,
  ipAddress: string | null = null
): Promise<SelectionMutationResult> {
  // Get existing selection for history
  const existing = await getSelectionByEmployeeAndDate(db, employeeId, mealDate);
  const beforeJson = existing ? JSON.stringify(existing) : null;
  const previousChoice = existing?.choice ?? null;
  
  // Upsert the selection
  if (existing) {
    await db
      .prepare(`
        UPDATE lunch_selections
        SET choice = ?, source = ?, set_by = ?, override_reason = ?, updated_at = datetime('now')
        WHERE employee_id = ? AND meal_date = ?
      `)
      .bind(choice, source, setBy, overrideReason, employeeId, mealDate)
      .run();
  } else {
    await db
      .prepare(`
        INSERT INTO lunch_selections (employee_id, meal_date, choice, source, set_by, override_reason)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(employeeId, mealDate, choice, source, setBy, overrideReason)
      .run();
  }
  
  // Retrieve the updated/created selection
  const selection = await getSelectionByEmployeeAndDate(db, employeeId, mealDate);
  if (!selection) {
    throw new Error('Failed to retrieve created/updated selection');
  }
  
  // Create history record
  const historyResult = await db
    .prepare(`
      INSERT INTO lunch_selection_history 
        (employee_id, meal_date, previous_choice, new_choice, changed_by, source, override_reason, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(employeeId, mealDate, previousChoice, choice, setBy, source, overrideReason, ipAddress)
    .run();
  
  const historyRecord: LunchSelectionHistory = {
    id: historyResult.meta?.last_row_id || 0,
    employee_id: employeeId,
    meal_date: mealDate,
    previous_choice: previousChoice,
    new_choice: choice,
    changed_at: new Date().toISOString(),
    changed_by: setBy,
    source: source,
    override_reason: overrideReason,
    ip_address: ipAddress
  };
  
  return {
    selection,
    historyRecord,
    beforeJson,
    afterJson: JSON.stringify(selection)
  };
}

/**
 * Admin override of selection
 * Requires admin authorization and reason
 */
export async function adminOverrideSelection(
  db: D1Database,
  employeeId: number,
  mealDate: string,
  choice: LunchChoice,
  adminId: number,
  overrideReason: string,
  ipAddress: string | null = null
): Promise<SelectionMutationResult> {
  return upsertSelection(
    db,
    employeeId,
    mealDate,
    choice,
    'admin_override',
    adminId,
    overrideReason,
    ipAddress
  );
}

/**
 * Get selection history for an employee/date
 */
export async function getSelectionHistory(
  db: D1Database,
  employeeId: number,
  mealDate: string
): Promise<LunchSelectionHistory[]> {
  const result = await db
    .prepare(`
      SELECT * FROM lunch_selection_history
      WHERE employee_id = ? AND meal_date = ?
      ORDER BY changed_at DESC
    `)
    .bind(employeeId, mealDate)
    .all<LunchSelectionHistory>();
  
  return result.results || [];
}

/**
 * Get all selections count by choice for a date (for reports)
 */
export async function getSelectionCountsByDate(
  db: D1Database,
  mealDate: string
): Promise<{ option_1: number; option_2: number; no_preference: number; total: number }> {
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
    option_1: result?.option_1 || 0,
    option_2: result?.option_2 || 0,
    no_preference: result?.no_preference || 0,
    total: result?.total || 0
  };
}
