/**
 * Admin Routes - Phase 3 Slice 1
 *
 * Employee management, administrative password setting, application settings,
 * and company holidays. Mounted at /api/admin.
 *
 * Every route in this file sits behind requireAuth + requireRole, applied to the
 * whole router rather than per-endpoint, so a newly added admin endpoint
 * inherits the guard instead of needing someone to remember it.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { requireAuth, requireRole } from '../middleware/session.js';
import {
  getEmployeeById,
  getEmployeeByAmcoId,
  createEmployee,
  updateEmployee,
  setEmployeePassword,
  listEmployees,
} from '../db/employees.js';
import { deleteSessionsForEmployee } from '../db/sessions.js';
import { hashPassword } from '../lib/auth.js';
import { validatePassword } from '../lib/password.js';
import { toPublicEmployee, toPublicEmployees } from '../lib/employeeView.js';
import { isValidBusinessDate } from '../lib/datetime.js';
import { getAllSettings, getCurrentBusinessDate, getSetting, updateSetting } from '../services/settings.service.js';
import { buildLunchReport, buildLunchReportDetail } from '../services/reports.service.js';
import { isMealLocation, MEAL_LOCATIONS } from '../../shared/types/index.js';
import { buildXlsx, XLSX_CONTENT_TYPE, type CellValue } from '../lib/xlsxWrite.js';
import { listHolidays, upsertHoliday, deleteHoliday } from '../repositories/holidays.repo.js';
import {
  logEmployeeChange,
  logPasswordChange,
  logSettingsChange,
  logHolidayChange,
} from '../services/audit.service.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Guard the entire router. Authentication first, then role.
app.use('*', requireAuth);
app.use('*', requireRole(['admin', 'super_admin']));

const ROSTER_TYPES = ['regular', 'shift', 'amman_hq'] as const;
const CUTOFF_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header('X-Forwarded-For') || null;

/** roles.id, as seeded by migration 0001. */
const ROLE_SUPER_ADMIN = 3;

/**
 * Only a super administrator may create one, or change one.
 *
 * WHY THIS EXISTS: the role was previously settable by any administrator, which
 * meant `admin` and `super_admin` were the same privilege in practice - any
 * admin could promote themselves and hold the top role permanently. Both
 * directions are guarded: granting the role, and altering the role of someone
 * who already holds it, because stripping a super administrator is the other
 * half of the same power.
 *
 * Returns an error message when the action is refused, or null when allowed.
 */
function refuseSuperAdminChange(
  actorRole: string,
  requestedRoleId: number | undefined,
  targetCurrentRoleId: number | null
): string | null {
  if (actorRole === 'super_admin') return null;

  if (requestedRoleId === ROLE_SUPER_ADMIN) {
    return 'Only a super administrator can grant the super administrator role.';
  }
  if (
    targetCurrentRoleId === ROLE_SUPER_ADMIN &&
    requestedRoleId !== undefined &&
    requestedRoleId !== ROLE_SUPER_ADMIN
  ) {
    return 'Only a super administrator can change a super administrator\'s role.';
  }
  return null;
}

// ============================================================================
// EMPLOYEES
// ============================================================================

/**
 * GET /api/admin/employees - list and search employees
 *
 * Query: search, roster_type, is_active, page, page_size
 */
app.get('/employees', async (c) => {
  const db = c.env.DB;

  const rosterType = c.req.query('roster_type');
  if (rosterType && !ROSTER_TYPES.includes(rosterType as (typeof ROSTER_TYPES)[number])) {
    return c.json({ success: false, error: `roster_type must be one of: ${ROSTER_TYPES.join(', ')}` }, 400);
  }

  const isActiveParam = c.req.query('is_active');
  let isActive: boolean | undefined;
  if (isActiveParam === 'true') isActive = true;
  else if (isActiveParam === 'false') isActive = false;
  else if (isActiveParam !== undefined) {
    return c.json({ success: false, error: 'is_active must be true or false' }, 400);
  }

  const page = Number.parseInt(c.req.query('page') || '1', 10);
  const pageSize = Number.parseInt(c.req.query('page_size') || '20', 10);

  const { employees, total } = await listEmployees(db, {
    page: Number.isNaN(page) || page < 1 ? 1 : page,
    pageSize: Number.isNaN(pageSize) || pageSize < 1 ? 20 : Math.min(pageSize, 100),
    search: c.req.query('search') || undefined,
    rosterType: rosterType as (typeof ROSTER_TYPES)[number] | undefined,
    isActive,
  });

  return c.json({ success: true, data: { employees: toPublicEmployees(employees), total } });
});

/**
 * POST /api/admin/employees - create an employee
 *
 * The employee is created WITHOUT a password and therefore cannot log in until
 * an administrator sets one via the password endpoint below.
 */
app.post('/employees', async (c) => {
  const db = c.env.DB;
  const actorId = c.get('session')!.employee_id;

  const body = await c.req.json();
  const { amco_id, full_name, department, section, roster_type, role_id, default_location } = body;

  if (!amco_id || typeof amco_id !== 'string' || amco_id.trim().length === 0) {
    return c.json({ success: false, error: 'amco_id is required' }, 400);
  }
  if (!full_name || typeof full_name !== 'string' || full_name.trim().length === 0) {
    return c.json({ success: false, error: 'full_name is required' }, 400);
  }
  if (!roster_type || !ROSTER_TYPES.includes(roster_type)) {
    return c.json({ success: false, error: `roster_type must be one of: ${ROSTER_TYPES.join(', ')}` }, 400);
  }
  if (role_id !== undefined && ![1, 2, 3].includes(role_id)) {
    return c.json({ success: false, error: 'role_id must be 1 (employee), 2 (admin) or 3 (super_admin)' }, 400);
  }
  if (default_location !== undefined && !isMealLocation(default_location)) {
    return c.json(
      { success: false, error: `default_location must be one of: ${MEAL_LOCATIONS.join(', ')}` },
      400
    );
  }

  const refusal = refuseSuperAdminChange(c.get('session')!.role, role_id, null);
  if (refusal) return c.json({ success: false, error: refusal }, 403);

  const trimmedAmcoId = amco_id.trim();
  if (await getEmployeeByAmcoId(db, trimmedAmcoId)) {
    return c.json({ success: false, error: 'An employee with this amco_id already exists' }, 409);
  }

  try {
    // Text fields are trimmed: the source workbooks contain stray leading and
    // trailing whitespace, and untrimmed values split department reports.
    const employee = await createEmployee(db, {
      amco_id: trimmedAmcoId,
      full_name: full_name.trim(),
      department: typeof department === 'string' ? department.trim() : null,
      section: typeof section === 'string' ? section.trim() : null,
      roster_type,
      role_id,
      default_location,
    });

    const publicEmployee = toPublicEmployee(employee);

    await logEmployeeChange(
      db, actorId, employee.id, null, JSON.stringify(publicEmployee), 'CREATE', clientIp(c)
    );

    return c.json({ success: true, data: publicEmployee }, 201);
  } catch (error) {
    console.error('Error creating employee:', error);
    return c.json({ success: false, error: 'Failed to create employee' }, 500);
  }
});

/**
 * PUT /api/admin/employees/:id - update employee details
 *
 * `is_active` is deliberately NOT accepted here; activation has its own endpoint
 * so that it produces its own audit action and can revoke sessions.
 */
app.put('/employees/:id', async (c) => {
  const db = c.env.DB;
  const actorId = c.get('session')!.employee_id;
  const id = Number.parseInt(c.req.param('id')!, 10);

  if (Number.isNaN(id)) {
    return c.json({ success: false, error: 'Invalid employee id' }, 400);
  }

  const existing = await getEmployeeById(db, id);
  if (!existing) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }

  const body = await c.req.json();
  const { full_name, department, section, roster_type, role_id, default_location } = body;

  if (full_name !== undefined && (typeof full_name !== 'string' || full_name.trim().length === 0)) {
    return c.json({ success: false, error: 'full_name cannot be empty' }, 400);
  }
  if (roster_type !== undefined && !ROSTER_TYPES.includes(roster_type)) {
    return c.json({ success: false, error: `roster_type must be one of: ${ROSTER_TYPES.join(', ')}` }, 400);
  }
  if (role_id !== undefined && ![1, 2, 3].includes(role_id)) {
    return c.json({ success: false, error: 'role_id must be 1 (employee), 2 (admin) or 3 (super_admin)' }, 400);
  }
  if (default_location !== undefined && !isMealLocation(default_location)) {
    return c.json(
      { success: false, error: `default_location must be one of: ${MEAL_LOCATIONS.join(', ')}` },
      400
    );
  }
  if (body.is_active !== undefined) {
    return c.json(
      { success: false, error: 'Use PUT /api/admin/employees/:id/status to activate or deactivate' },
      400
    );
  }

  const refusal = refuseSuperAdminChange(c.get('session')!.role, role_id, existing.role_id);
  if (refusal) return c.json({ success: false, error: refusal }, 403);

  const beforeJson = JSON.stringify(toPublicEmployee(existing));

  const updated = await updateEmployee(db, id, {
    ...(full_name !== undefined ? { full_name: full_name.trim() } : {}),
    ...(department !== undefined ? { department: typeof department === 'string' ? department.trim() : null } : {}),
    ...(section !== undefined ? { section: typeof section === 'string' ? section.trim() : null } : {}),
    ...(roster_type !== undefined ? { roster_type } : {}),
    ...(role_id !== undefined ? { role_id } : {}),
    ...(default_location !== undefined ? { default_location } : {}),
  });

  if (!updated) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }

  const publicEmployee = toPublicEmployee(updated);

  await logEmployeeChange(
    db, actorId, id, beforeJson, JSON.stringify(publicEmployee), 'UPDATE', clientIp(c)
  );

  return c.json({ success: true, data: publicEmployee });
});

/**
 * PUT /api/admin/employees/:id/status - activate or deactivate
 *
 * Deactivation revokes the employee's sessions immediately. Without that, a
 * departed employee keeps a working cookie until it expires, which defeats the
 * point of deactivating them.
 */
app.put('/employees/:id/status', async (c) => {
  const db = c.env.DB;
  const actorId = c.get('session')!.employee_id;
  const id = Number.parseInt(c.req.param('id')!, 10);

  if (Number.isNaN(id)) {
    return c.json({ success: false, error: 'Invalid employee id' }, 400);
  }

  const body = await c.req.json();
  const { is_active } = body;

  if (typeof is_active !== 'boolean') {
    return c.json({ success: false, error: 'is_active must be a boolean' }, 400);
  }

  const existing = await getEmployeeById(db, id);
  if (!existing) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }

  const beforeJson = JSON.stringify(toPublicEmployee(existing));
  const updated = await updateEmployee(db, id, { is_active });
  if (!updated) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }

  let sessionsRevoked = 0;
  if (!is_active) {
    sessionsRevoked = await deleteSessionsForEmployee(db, id);
  }

  const publicEmployee = toPublicEmployee(updated);

  await logEmployeeChange(
    db,
    actorId,
    id,
    beforeJson,
    JSON.stringify({ ...publicEmployee, sessions_revoked: sessionsRevoked }),
    is_active ? 'REACTIVATE' : 'DEACTIVATE',
    clientIp(c)
  );

  return c.json({ success: true, data: publicEmployee, sessionsRevoked });
});

/**
 * PUT /api/admin/employees/:id/password - administrator sets an employee password
 *
 * CanteenHub has no email or SMS channel and therefore no self-service recovery,
 * no reset links and no reset tokens. The administrator sets the password and
 * hands it to the employee in person; that is the whole flow, by design.
 *
 * The plaintext is used to derive a hash and is then discarded. It is never
 * stored, never returned, never logged, and never placed in audit JSON.
 */
app.put('/employees/:id/password', async (c) => {
  const db = c.env.DB;
  const actorId = c.get('session')!.employee_id;
  const id = Number.parseInt(c.req.param('id')!, 10);

  if (Number.isNaN(id)) {
    return c.json({ success: false, error: 'Invalid employee id' }, 400);
  }

  const body = await c.req.json();
  const { password } = body;

  const validation = validatePassword(password);
  if (!validation.valid) {
    // The rejection names the rule, never the submitted value.
    return c.json({ success: false, error: validation.error }, 400);
  }

  const employee = await getEmployeeById(db, id);
  if (!employee) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }

  try {
    // The EXISTING hashing implementation (PBKDF2-SHA-256, 100k iterations).
    // No second password-hashing scheme is introduced.
    const passwordHash = await hashPassword(password as string);
    await setEmployeePassword(db, id, passwordHash);

    // Revoke every existing session for this employee. The old password must
    // stop granting access immediately, and a live cookie would otherwise
    // outlive it.
    const sessionsRevoked = await deleteSessionsForEmployee(db, id);

    await logPasswordChange(db, actorId, id, employee.amco_id, sessionsRevoked, clientIp(c));

    // Note the response body: a confirmation and a session count. No password,
    // no hash.
    return c.json({
      success: true,
      data: { employee_id: id, amco_id: employee.amco_id, password_set: true, sessionsRevoked },
    });
  } catch (error) {
    // Logged without the request body, which holds the plaintext.
    console.error('Error setting employee password for employee id', id);
    if (error instanceof Error) {
      console.error('Password set failure:', error.name);
    }
    return c.json({ success: false, error: 'Failed to set password' }, 500);
  }
});

// ============================================================================
// SETTINGS
// ============================================================================

/**
 * GET /api/admin/settings - read all application settings
 */
app.get('/settings', async (c) => {
  const settings = await getAllSettings(c.env.DB);
  return c.json({ success: true, data: settings });
});

/**
 * PUT /api/admin/settings/cutoff - configure the lunch selection cutoff time
 *
 * Stored as HH:MM and interpreted in the configured business timezone by
 * isCutoffPassed. The selection route reads this setting on every request, so a
 * change takes effect immediately with no deployment.
 */
app.put('/settings/cutoff', async (c) => {
  const db = c.env.DB;
  const actorId = c.get('session')!.employee_id;

  const body = await c.req.json();
  const { cutoff_time } = body;

  if (typeof cutoff_time !== 'string' || !CUTOFF_PATTERN.test(cutoff_time)) {
    return c.json({ success: false, error: 'cutoff_time must be in HH:MM 24-hour format' }, 400);
  }

  const previous = await getSetting(db, 'lunch_cutoff_time');

  // Settings values are JSON-encoded, matching how the migration seeds them.
  const stored = JSON.stringify(cutoff_time);
  const updated = await updateSetting(db, 'lunch_cutoff_time', stored, 'time', actorId);

  await logSettingsChange(
    db, actorId, 'lunch_cutoff_time', previous?.value ?? null, stored, clientIp(c)
  );

  return c.json({ success: true, data: updated });
});

// ============================================================================
// HOLIDAYS
// ============================================================================

/**
 * GET /api/admin/holidays - list configured company holidays
 */
app.get('/holidays', async (c) => {
  const holidays = await listHolidays(c.env.DB);
  return c.json({ success: true, data: holidays });
});

/**
 * POST /api/admin/holidays - add (or rename) a company holiday
 *
 * Every employee becomes ineligible on this date with reason HOLIDAY. This adds
 * data the existing eligibility rules already understood; it does not change
 * those rules.
 */
app.post('/holidays', async (c) => {
  const db = c.env.DB;
  const actorId = c.get('session')!.employee_id;

  const body = await c.req.json();
  const { holiday_date, name } = body;

  if (!isValidBusinessDate(holiday_date)) {
    return c.json({ success: false, error: 'holiday_date must be a valid date in YYYY-MM-DD format' }, 400);
  }
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return c.json({ success: false, error: 'name is required' }, 400);
  }

  const result = await upsertHoliday(db, holiday_date, name.trim(), actorId);

  await logHolidayChange(
    db, actorId, holiday_date, result.beforeJson, result.afterJson, result.action, clientIp(c)
  );

  return c.json({ success: true, data: result.holiday }, result.action === 'CREATE' ? 201 : 200);
});

/**
 * DELETE /api/admin/holidays/:date - remove a company holiday
 */
app.delete('/holidays/:date', async (c) => {
  const db = c.env.DB;
  const actorId = c.get('session')!.employee_id;
  const date = c.req.param('date')!;

  if (!isValidBusinessDate(date)) {
    return c.json({ success: false, error: 'date must be a valid date in YYYY-MM-DD format' }, 400);
  }

  const deleted = await deleteHoliday(db, date);
  if (!deleted) {
    return c.json({ success: false, error: 'Holiday not found' }, 404);
  }

  await logHolidayChange(db, actorId, date, JSON.stringify(deleted), null, 'DELETE', clientIp(c));

  return c.json({ success: true, message: 'Holiday removed' });
});

/**
 * GET /api/admin/reports/lunch?date=YYYY-MM-DD - lunch report for one date
 *
 * Read-only, and deliberately unaudited: a report read changes nothing, and
 * logging every view would bury the mutations the audit trail exists for.
 *
 * Counts only - no employee-level rows. Nobody needs a list of names to tell
 * the caterer how many portions to cook, and the smallest response that answers
 * the question is the one that cannot leak.
 *
 * Omitting `date` reports the server's current business date, so the browser
 * never decides which day "today" is.
 */
app.get('/reports/lunch', async (c) => {
  const db = c.env.DB;
  const requested = c.req.query('date');

  if (requested !== undefined && !isValidBusinessDate(requested)) {
    return c.json({ success: false, error: 'Invalid date. Use YYYY-MM-DD' }, 400);
  }

  // A validated business date, always bound as a parameter downstream - never
  // interpolated into SQL.
  const date = requested ?? (await getCurrentBusinessDate(db));

  const report = await buildLunchReport(db, date);
  return c.json({ success: true, data: report });
});

/**
 * GET /api/admin/reports/lunch.xlsx?date=YYYY-MM-DD - the same report as a
 * workbook the kitchen can print.
 *
 * TWO SHEETS, because two different people read this:
 *   "Totals"  - portions per option per canteen. What the kitchen dispatches on.
 *   "Detail"  - one row per employee behind those numbers, so a disputed count
 *               can be traced to the people in it.
 *
 * Read-only and deliberately unaudited, exactly like the JSON report it mirrors:
 * exporting changes nothing, and an audit row per export would bury the entries
 * that record real changes.
 *
 * The detail sheet carries names, so this endpoint is admin-only - which it
 * already is, by the router-level requireRole above.
 */
app.get('/reports/lunch.xlsx', async (c) => {
  const db = c.env.DB;
  const requested = c.req.query('date');

  if (requested !== undefined && !isValidBusinessDate(requested)) {
    return c.json({ success: false, error: 'Invalid date. Use YYYY-MM-DD' }, 400);
  }

  const date = requested ?? (await getCurrentBusinessDate(db));
  const [report, detail] = await Promise.all([
    buildLunchReport(db, date),
    buildLunchReportDetail(db, date),
  ]);

  const CHOICE_LABELS: Record<string, string> = {
    option_1: 'Option 1',
    option_2: 'Option 2',
    no_preference: 'No preference',
  };

  const totals: CellValue[][] = [
    ['Canteen', 'Option 1', 'Option 2', 'No preference', 'Total portions', 'Eligible, not selected'],
    ...report.by_location.map((row) => [
      row.label,
      row.option_1,
      row.option_2,
      row.no_preference,
      row.total,
      row.eligible_not_selected,
    ]),
    [
      'All canteens',
      report.selections.option_1,
      report.selections.option_2,
      report.selections.no_preference,
      report.selections.option_1 + report.selections.option_2 + report.selections.no_preference,
      report.selections.eligible_not_selected,
    ],
    [],
    ['Lunch report', date],
    ['Timezone', report.timezone],
    ['Menu', report.menu.exists ? (report.menu.status ?? 'unknown') : 'no menu for this date'],
    ['Employees considered', report.totals.employees_considered],
    ['Eligible', report.totals.eligible],
    ['Not eligible', report.totals.not_eligible],
    ['Selections held by ineligible employees', report.selections.ineligible_with_selection],
  ];

  const detailRows: CellValue[][] = [
    ['AMCO ID', 'Name', 'Department', 'Section', 'Roster', 'Eligible', 'Reason', 'Choice', 'Canteen'],
    ...detail.map((row) => [
      row.amco_id,
      row.full_name,
      row.department ?? '',
      row.section ?? '',
      row.roster_type,
      row.eligible ? 'Yes' : 'No',
      row.reason_label,
      row.choice ? (CHOICE_LABELS[row.choice] ?? row.choice) : '',
      row.location_label,
    ]),
  ];

  const bytes = buildXlsx([
    { name: 'Totals', rows: totals, columnWidths: [26, 10, 10, 15, 15, 22] },
    { name: 'Detail', rows: detailRows, columnWidths: [12, 28, 22, 22, 10, 9, 26, 15, 16] },
  ]);

  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="canteenhub-lunch-${date}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
});

export { app as adminRoutes };
