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
  return logAudit(db, {
    actorId,
    action: `${action}_ROSTER_ENTRY`,
    entityType: 'ROSTER_ENTRY',
    entityId: null, // ID may not exist for deletes
    beforeJson,
    afterJson,
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
    afterJson,
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
  return logAudit(db, {
    actorId,
    action: 'ADMIN_OVERRIDE_SELECTION',
    entityType: 'LUNCH_SELECTION',
    entityId: null,
    beforeJson,
    afterJson,
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
