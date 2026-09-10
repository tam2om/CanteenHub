/**
 * Roster Routes
 * Handles roster retrieval and admin management
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { requireAuth, requireRole } from '../middleware/session.js';
import { getRosterEntriesForEmployee, getRosterEntriesByDate, getRosterForDate, upsertRosterEntry, deleteRosterEntry } from '../repositories/roster.repo.js';
import { getEmployeeById } from '../db/employees.js';
import { logRosterChange } from '../services/audit.service.js';
import { getCurrentBusinessDate } from '../services/settings.service.js';
import { addBusinessDays, isValidBusinessDate } from '../lib/datetime.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/roster/me - Get current employee's roster entries
 * Employees can only see their own roster
 */
app.get('/me', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');

  // The employee id comes from the SESSION only. There is no code path here
  // that accepts an employee id from the client, which is what makes "employee
  // A cannot read employee B's roster" structural rather than a check to forget.
  const employeeId = session!.employee_id;

  // Default range: the business day in the configured timezone, plus 30 days.
  // Derived from the business date, not from the UTC date or the server's clock.
  const startDate = c.req.query('from') ?? (await getCurrentBusinessDate(db));
  if (!isValidBusinessDate(startDate)) {
    return c.json({ success: false, error: 'Invalid from date. Use YYYY-MM-DD' }, 400);
  }

  const endDate = c.req.query('to') ?? addBusinessDays(startDate, 30);
  if (!isValidBusinessDate(endDate)) {
    return c.json({ success: false, error: 'Invalid to date. Use YYYY-MM-DD' }, 400);
  }

  const entries = await getRosterEntriesForEmployee(db, employeeId, startDate, endDate);

  return c.json({ success: true, data: entries });
});

/**
 * GET /api/roster/admin/day?date=&search=&roster_type= (Admin only)
 *
 * Every employee's roster standing for one date, including the ones with NO
 * entry. The existing /:date endpoint lists roster ENTRIES; this lists
 * EMPLOYEES, which is what an administrator hunting a missing roster needs -
 * an employee without an entry cannot appear in a list of entries.
 *
 * Registered before /:date deliberately: a single-segment param route would
 * otherwise swallow anything shaped like a date.
 *
 * Read-only. No password hash, no session data, no IP - the query names the
 * columns it returns and none of those are among them.
 */
app.get('/admin/day', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const requested = c.req.query('date');

  if (requested !== undefined && !isValidBusinessDate(requested)) {
    return c.json({ success: false, error: 'Invalid date. Use YYYY-MM-DD' }, 400);
  }

  // The server owns "today": a browser clock in another timezone would open
  // the wrong day.
  const date = requested ?? (await getCurrentBusinessDate(db));

  const rosterType = c.req.query('roster_type');
  if (rosterType !== undefined && !['regular', 'shift', 'amman_hq'].includes(rosterType)) {
    return c.json({ success: false, error: 'Invalid roster_type' }, 400);
  }

  const search = c.req.query('search')?.trim();

  const employees = await getRosterForDate(db, date, {
    ...(search ? { search } : {}),
    ...(rosterType ? { rosterType } : {}),
  });

  return c.json({ success: true, data: { date, employees } });
});

/**
 * GET /api/roster/:date - Get all roster entries for a date (Admin only)
 */
app.get('/:date', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const workDate = c.req.param('date')!;
  
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    return c.json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
  }
  
  const db = c.env.DB;
  const entries = await getRosterEntriesByDate(db, workDate);
  
  return c.json({ success: true, data: entries });
});

/**
 * POST /api/roster - Create/update roster entry (Admin only)
 */
app.post('/', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const actorId = session!.employee_id;
  const ipAddress = c.req.header('X-Forwarded-For') || null;
  
  const body = await c.req.json();
  const { employee_id, work_date, shift_value } = body;
  
  // Validation
  if (!employee_id || typeof employee_id !== 'number') {
    return c.json({ success: false, error: 'employee_id is required' }, 400);
  }
  
  // A calendar date, not merely a well-shaped string: 2027-02-30 is refused.
  if (!isValidBusinessDate(work_date)) {
    return c.json({ success: false, error: 'Invalid or missing work_date' }, 400);
  }
  
  const validShifts = ['day', 'night', 'off'];
  if (!shift_value || !validShifts.includes(shift_value)) {
    return c.json({ success: false, error: `shift_value must be one of: ${validShifts.join(', ')}` }, 400);
  }

  // `source` is deliberately NOT read from the request. Anything written here
  // is a manual edit by definition; letting a caller label it 'import' would
  // make a hand correction indistinguishable from the bulk file it came from.
  if (body.source !== undefined) {
    return c.json(
      { success: false, error: 'source cannot be set here; manual edits are always recorded as manual.' },
      400
    );
  }

  // A missing employee would otherwise surface as a foreign-key 500.
  const employee = await getEmployeeById(db, employee_id);
  if (!employee) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }
  
  try {
    const result = await upsertRosterEntry(db, employee_id, work_date, shift_value, 'manual');

    // `changed: false` means the entry already held this value: nothing was
    // written, so nothing is audited. An audit trail full of non-changes hides
    // the changes that matter.
    if (!result.changed) {
      return c.json({ success: true, data: result.entry, changed: false }, 200);
    }
    
    await logRosterChange(
      db,
      actorId,
      employee_id,
      work_date,
      result.beforeJson,
      result.afterJson,
      result.beforeJson ? 'UPDATE' : 'CREATE',
      ipAddress
    );
    
    return c.json({ success: true, data: result.entry, changed: true }, result.beforeJson ? 200 : 201);
  } catch (error) {
    console.error('Error saving roster entry:', error);
    return c.json({ success: false, error: 'Failed to save roster entry' }, 500);
  }
});

/**
 * DELETE /api/roster/:employeeId/:workDate - Soft delete roster entry (Admin only)
 */
app.delete('/:employeeId/:workDate', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const actorId = session!.employee_id;
  const ipAddress = c.req.header('X-Forwarded-For') || null;
  
  const employeeId = parseInt(c.req.param('employeeId')!, 10);
  const workDate = c.req.param('workDate')!;
  
  if (!employeeId || isNaN(employeeId)) {
    return c.json({ success: false, error: 'Invalid employee_id' }, 400);
  }
  
  if (!workDate || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
    return c.json({ success: false, error: 'Invalid work_date' }, 400);
  }
  
  try {
    const result = await deleteRosterEntry(db, employeeId, workDate);
    
    if (!result.deleted) {
      return c.json({ success: false, error: 'Roster entry not found' }, 404);
    }
    
    await logRosterChange(
      db,
      actorId,
      employeeId,
      workDate,
      result.beforeJson,
      null,
      'DELETE',
      ipAddress
    );
    
    return c.json({ success: true, message: 'Roster entry deleted successfully', data: result.deleted });
  } catch (error) {
    console.error('Error deleting roster entry:', error);
    return c.json({ success: false, error: 'Failed to delete roster entry' }, 500);
  }
});

export { app as rosterRoutes };
