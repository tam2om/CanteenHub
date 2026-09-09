/**
 * Audit Service Layer
 * Reusable audit logging for admin actions
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { AuditLog } from '../../shared/types/index.js';

export interface AuditEntry {
  actorId: number | null;
  action: string;
  entityType: string | null;
  entityId: number | null;
  beforeJson: string | null;
  afterJson: string | null;
  ipAddress: string | null;
}

/**
 * Log an audit entry
 */
export async function logAudit(
  db: D1Database,
  entry: AuditEntry
): Promise<AuditLog> {
  const result = await db
    .prepare(`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_json, after_json, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      entry.actorId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.beforeJson,
      entry.afterJson,
      entry.ipAddress
    )
    .run();
  
  return {
    id: result.meta?.last_row_id || 0,
    actor_id: entry.actorId,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId,
    before_json: entry.beforeJson,
    after_json: entry.afterJson,
    ip_address: entry.ipAddress,
    created_at: new Date().toISOString()
  };
}

/**
 * Get audit log entries with optional filtering
 */
export async function getAuditLog(
  db: D1Database,
  options?: {
    actorId?: number;
    entityType?: string;
    entityId?: number;
    limit?: number;
    offset?: number;
  }
): Promise<AuditLog[]> {
  let query = 'SELECT * FROM audit_log WHERE 1=1';
  const params: Array<string | number> = [];
  
  if (options?.actorId !== undefined) {
    query += ' AND actor_id = ?';
    params.push(options.actorId);
  }
  
  if (options?.entityType) {
    query += ' AND entity_type = ?';
    params.push(options.entityType);
  }
  
  if (options?.entityId !== undefined) {
    query += ' AND entity_id = ?';
    params.push(options.entityId);
  }
  
  query += ' ORDER BY created_at DESC';
  
  if (options?.limit !== undefined) {
    query += ' LIMIT ?';
    params.push(options.limit);
  }
  
  if (options?.offset !== undefined) {
    query += ' OFFSET ?';
    params.push(options.offset);
  }
  
  const result = await db
    .prepare(query)
    .bind(...params)
    .all<AuditLog>();
  
  return result.results || [];
}

/**
 * Create audit entry for roster change
 */
export async function logRosterChange(
  db: D1Database,
  actorId: number,
  employeeId: number,
  workDate: string,
  beforeJson: string | null,
  afterJson: string | null,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  ipAddress: string | null = null
): Promise<AuditLog> {
  // The roster entry's own id is unstable across a delete, so the audit row is
  // keyed by the employee and date that identify it. These were previously
  // accepted as parameters and silently dropped, which left audit rows that
  // could not be traced back to a person or a day.
  return logAudit(db, {
    actorId,
    action: `${action}_ROSTER_ENTRY`,
    entityType: 'ROSTER_ENTRY',
    entityId: employeeId,
    beforeJson,
    afterJson: afterJson
      ? JSON.stringify({ employee_id: employeeId, work_date: workDate, entry: JSON.parse(afterJson) })
      : JSON.stringify({ employee_id: employeeId, work_date: workDate, entry: null }),
    ipAddress
  });
}

/**
 * Create audit entry for menu change
 */
export async function logMenuChange(
  db: D1Database,
  actorId: number,
  menuDayId: number,
  mealDate: string,
  beforeJson: string | null,
  afterJson: string | null,
  action: 'CREATE' | 'UPDATE' | 'PUBLISH' | 'ARCHIVE' | 'DELETE',
  ipAddress: string | null = null
): Promise<AuditLog> {
  return logAudit(db, {
    actorId,
    action: `${action}_MENU_DAY`,
    entityType: 'MENU_DAY',
    entityId: menuDayId,
    beforeJson,
    afterJson: afterJson
      ? JSON.stringify({ meal_date: mealDate, menu_day: JSON.parse(afterJson) })
      : JSON.stringify({ meal_date: mealDate, menu_day: null }),
    ipAddress
  });
}

/**
 * Create audit entry for a menu OPTION mutation (Option 1 / Option 2).
 *
 * Options are what employees actually choose between, so changing one silently
 * would let the meaning of every existing selection shift with no record of who
 * changed it. Follows the same `${ACTION}_${ENTITY}` naming as the menu-day
 * audit, and carries the owning menu day's id and date so an investigation can
 * start from a date rather than an internal option id.
 */
export async function logMenuOptionChange(
  db: D1Database,
  actorId: number,
  menuDayId: number,
  mealDate: string,
  optionNumber: number,
  beforeJson: string | null,
  afterJson: string | null,
  action: 'CREATE' | 'UPDATE',
  ipAddress: string | null = null
): Promise<AuditLog> {
  return logAudit(db, {
    actorId,
    action: `${action}_MENU_OPTION`,
    entityType: 'MENU_OPTION',
    entityId: menuDayId,
    beforeJson,
    afterJson: afterJson
      ? JSON.stringify({ meal_date: mealDate, option_number: optionNumber, option: JSON.parse(afterJson) })
      : null,
    ipAddress
  });
}

/**
 * Create audit entry for a menu COMPONENT mutation
 * (condiment / beverage / dessert / salad and friends).
 */
export async function logMenuComponentChange(
  db: D1Database,
  actorId: number,
  menuDayId: number,
  mealDate: string,
  beforeJson: string | null,
  afterJson: string | null,
  action: 'CREATE' | 'UPDATE',
  ipAddress: string | null = null
): Promise<AuditLog> {
  return logAudit(db, {
    actorId,
    action: `${action}_MENU_COMPONENT`,
    entityType: 'MENU_COMPONENT',
    entityId: menuDayId,
    beforeJson,
    afterJson: afterJson
      ? JSON.stringify({ meal_date: mealDate, component: JSON.parse(afterJson) })
      : null,
    ipAddress
  });
}

/**
 * Create audit entry for selection override
 */
export async function logSelectionOverride(
  db: D1Database,
  actorId: number,
  employeeId: number,
  mealDate: string,
  beforeJson: string | null,
  afterJson: string | null,
  overrideReason: string,
  ipAddress: string | null = null
): Promise<AuditLog> {
  // Record WHO was overridden, for WHICH date, and WHY. Without these the audit
  // row says only "an admin overrode something", which is not an audit trail.
  return logAudit(db, {
    actorId,
    action: 'ADMIN_OVERRIDE_SELECTION',
    entityType: 'LUNCH_SELECTION',
    entityId: employeeId,
    beforeJson,
    afterJson: afterJson
      ? JSON.stringify({
          employee_id: employeeId,
          meal_date: mealDate,
          override_reason: overrideReason,
          selection: JSON.parse(afterJson),
        })
      : null,
    ipAddress
  });
}

/**
 * Create audit entry for an administrative password change.
 *
 * SECURITY: the plaintext password is never a parameter of this function, so it
 * cannot reach the audit table even by mistake. Nor is the resulting hash
 * recorded - a stored hash in an audit row is a credential sitting in a table
 * that is deliberately never deleted. The audit answers who changed whose
 * password, when, and how many sessions that revoked; the secret itself is not
 * part of that answer.
 */
export async function logPasswordChange(
  db: D1Database,
  actorId: number,
  targetEmployeeId: number,
  targetAmcoId: string,
  sessionsRevoked: number,
  ipAddress: string | null = null
): Promise<AuditLog> {
  return logAudit(db, {
    actorId,
    action: 'ADMIN_SET_EMPLOYEE_PASSWORD',
    entityType: 'EMPLOYEE',
    entityId: targetEmployeeId,
    beforeJson: null,
    afterJson: JSON.stringify({
      employee_id: targetEmployeeId,
      amco_id: targetAmcoId,
      password_changed: true,
      sessions_revoked: sessionsRevoked,
    }),
    ipAddress
  });
}

/**
 * Create audit entry for an application setting change.
 */
export async function logSettingsChange(
  db: D1Database,
  actorId: number,
  key: string,
  beforeValue: string | null,
  afterValue: string,
  ipAddress: string | null = null
): Promise<AuditLog> {
  return logAudit(db, {
    actorId,
    action: 'UPDATE_SETTING',
    entityType: 'SETTING',
    entityId: null,
    beforeJson: beforeValue === null ? null : JSON.stringify({ key, value: beforeValue }),
    afterJson: JSON.stringify({ key, value: afterValue }),
    ipAddress
  });
}

/**
 * Create audit entry for a holiday change.
 */
export async function logHolidayChange(
  db: D1Database,
  actorId: number,
  holidayDate: string,
  beforeJson: string | null,
  afterJson: string | null,
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  ipAddress: string | null = null
): Promise<AuditLog> {
  return logAudit(db, {
    actorId,
    action: `${action}_HOLIDAY`,
    entityType: 'HOLIDAY',
    entityId: null, // holidays are keyed by date, not by an integer id
    beforeJson,
    afterJson: afterJson
      ? JSON.stringify({ holiday_date: holidayDate, holiday: JSON.parse(afterJson) })
      : JSON.stringify({ holiday_date: holidayDate, holiday: null }),
    ipAddress
  });
}

/**
 * Create audit entry for employee change
 */
export async function logEmployeeChange(
  db: D1Database,
  actorId: number,
  employeeId: number,
  beforeJson: string | null,
  afterJson: string | null,
  action: 'CREATE' | 'UPDATE' | 'DEACTIVATE' | 'REACTIVATE',
  ipAddress: string | null = null
): Promise<AuditLog> {
  return logAudit(db, {
    actorId,
    action: `${action}_EMPLOYEE`,
    entityType: 'EMPLOYEE',
    entityId: employeeId,
    beforeJson,
    afterJson,
    ipAddress
  });
}
