/**
 * Employee self-service routes - Phase 3 Slice 2
 *
 * Everything the employee portal needs about the CURRENT employee, mounted at
 * /api/me. The employee id always comes from the session; no endpoint here
 * accepts an employee identifier from the client, which is what makes
 * "employee A cannot read employee B's data" a structural property rather than
 * a check someone has to remember.
 *
 * These endpoints exist because the portal genuinely could not be built without
 * them: eligibility was only ever computed inside POST /api/selections/me (so a
 * dashboard could not show it without attempting a selection), no endpoint
 * returned the business date (so the browser would have had to guess it from
 * its own clock), and the only selection-history endpoint was admin-only and
 * per-date. No existing behaviour is duplicated or replaced.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { requireAuth } from '../middleware/session.js';
import { getEmployeeById } from '../db/employees.js';
import { toPublicEmployee } from '../lib/employeeView.js';
import { getCurrentBusinessDate, isCutoffPassed } from '../services/settings.service.js';
import { getEligibilityWithNextDate } from '../services/eligibility.service.js';
import { getPublishedMenuByDate } from '../repositories/menu.repo.js';
import {
  getSelectionByEmployeeAndDate,
  getSelectionHistoryForEmployee,
} from '../repositories/selections.repo.js';
import { isValidBusinessDate } from '../lib/datetime.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Every route here requires an authenticated session.
app.use('*', requireAuth);

const MAX_HISTORY_LIMIT = 100;
const DEFAULT_HISTORY_LIMIT = 30;

/**
 * GET /api/me/today - everything the dashboard needs, in one request.
 *
 * Aggregated deliberately: a phone on a slow connection should make one call to
 * render the whole screen, and every value the UI shows (business date,
 * eligibility, cutoff) is computed server-side so the browser never derives any
 * of it from its own clock or timezone.
 *
 * `?date=YYYY-MM-DD` is accepted for viewing another day; it defaults to the
 * configured business date.
 */
app.get('/today', async (c) => {
  const db = c.env.DB;
  const employeeId = c.get('session')!.employee_id;

  const businessDate = await getCurrentBusinessDate(db);

  const requestedDate = c.req.query('date');
  if (requestedDate !== undefined && !isValidBusinessDate(requestedDate)) {
    return c.json({ success: false, error: 'Invalid date. Use YYYY-MM-DD' }, 400);
  }
  const mealDate = requestedDate ?? businessDate;

  const employee = await getEmployeeById(db, employeeId);
  if (!employee) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }

  const eligibility = await getEligibilityWithNextDate(db, employee, mealDate);

  // Employees only ever see published menus. `null` is a legitimate answer and
  // the UI renders an explicit empty state for it rather than inventing a menu.
  const menu = await getPublishedMenuByDate(db, mealDate);

  const selection = await getSelectionByEmployeeAndDate(db, employeeId, mealDate);

  // The cutoff is configuration, evaluated here in the business timezone. The
  // client is told the outcome so it never computes a cutoff itself; the server
  // still re-checks on every write, and remains the authority.
  const cutoffPassed = await isCutoffPassed(db, mealDate);

  return c.json({
    success: true,
    data: {
      businessDate,
      mealDate,
      employee: toPublicEmployee(employee),
      eligibility,
      menu,
      selection,
      cutoffPassed,
      // A single flag the UI can render from, rather than re-deriving the rule.
      canSelect: eligibility.eligible && !cutoffPassed && menu !== null,
    },
  });
});

/**
 * GET /api/me/selections/history - the caller's own selection history.
 *
 * Returns meal date, the choice, and how it was set. Internal audit columns are
 * not exposed: an employee needs to see what they chose and whether an
 * administrator changed it, not the audit trail's internals.
 */
app.get('/selections/history', async (c) => {
  const db = c.env.DB;
  const employeeId = c.get('session')!.employee_id;

  const rawLimit = Number.parseInt(c.req.query('limit') || String(DEFAULT_HISTORY_LIMIT), 10);
  const rawOffset = Number.parseInt(c.req.query('offset') || '0', 10);

  const limit = Number.isNaN(rawLimit) || rawLimit < 1
    ? DEFAULT_HISTORY_LIMIT
    : Math.min(rawLimit, MAX_HISTORY_LIMIT);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const { entries, total } = await getSelectionHistoryForEmployee(db, employeeId, limit, offset);

  return c.json({
    success: true,
    data: {
      entries: entries.map((entry) => ({
        id: entry.id,
        meal_date: entry.meal_date,
        previous_choice: entry.previous_choice,
        new_choice: entry.new_choice,
        changed_at: entry.changed_at,
        source: entry.source,
      })),
      total,
      limit,
      offset,
    },
  });
});

export { app as meRoutes };
