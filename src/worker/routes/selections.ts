/**
 * Selection Routes
 * Handles lunch selection creation, retrieval, and admin override
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { requireAuth, requireRole } from '../middleware/session.js';
import { getSelectionByEmployeeAndDate, getSelectionsByDate, upsertSelection, adminOverrideSelection, getSelectionHistory } from '../repositories/selections.repo.js';
import {
  isMealLocation,
  isLunchChoice,
  isSelectableLunchChoice,
  LUNCH_CHOICES,
  MEAL_LOCATIONS,
  SELECTABLE_LUNCH_CHOICES,
  type LunchChoice,
  type MealLocation,
} from '../../shared/types/index.js';
import { getEligibilityWithNextDate } from '../services/eligibility.service.js';
import {
  getCurrentBusinessDate,
  getSelectableMealDate,
  isCutoffPassed,
} from '../services/settings.service.js';
import { getMenuDayByDate } from '../repositories/menu.repo.js';
import { getEmployeeById } from '../db/employees.js';
import { logSelectionOverride } from '../services/audit.service.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/selections/me/:date - Get current employee's selection for a date
 */
app.get('/me/:date', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const employeeId = session!.employee_id;
  const mealDate = c.req.param('date')!;
  
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate)) {
    return c.json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
  }
  
  const selection = await getSelectionByEmployeeAndDate(db, employeeId, mealDate);
  
  return c.json({ success: true, data: selection || null });
});

/**
 * POST /api/selections/me - Create/update own lunch selection
 */
app.post('/me', requireAuth, async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const employeeId = session!.employee_id;
  const ipAddress = c.req.header('X-Forwarded-For') || null;
  
  const body = await c.req.json();
  const { meal_date, choice, pickup_location } = body;
  
  // Validation
  if (!meal_date || !/^\d{4}-\d{2}-\d{2}$/.test(meal_date)) {
    return c.json({ success: false, error: 'Invalid or missing meal_date' }, 400);
  }
  
  // WHERE the meal is collected is now required, not inferred. A portion has to
  // be sent to one canteen and only the employee knows which; defaulting it
  // quietly put food at the wrong site for anyone whose day was not typical.
  if (!isMealLocation(pickup_location)) {
    return c.json(
      {
        success: false,
        error:
          pickup_location === undefined || pickup_location === null
            ? 'Choose where you will collect this meal.'
            : `pickup_location must be one of: ${MEAL_LOCATIONS.join(', ')}`,
      },
      400
    );
  }
  const location: MealLocation = pickup_location;

  // Get employee details
  const employee = await getEmployeeById(db, employeeId);
  if (!employee || !employee.is_active) {
    return c.json({ success: false, error: 'Employee not found or inactive' }, 403);
  }

  // WHAT they eat. Decided only once we know who is asking, because the answer
  // depends on the person:
  //
  //   - An employee on the healthy meal does not choose between the menu
  //     options. Their meal is recorded as `healthy` whatever the request says
  //     - their own screen sends 'healthy', a stale tab might send option_2 -
  //     so nobody but an administrator can move them back onto the menu.
  //   - Everyone else chooses Option 1 or Option 2, and nothing else. In
  //     particular they cannot put THEMSELVES on the healthy meal.
  let effectiveChoice: LunchChoice;
  if (employee.meal_preference === 'healthy') {
    effectiveChoice = 'healthy';
  } else if (isSelectableLunchChoice(choice)) {
    effectiveChoice = choice;
  } else {
    return c.json(
      { success: false, error: `choice must be one of: ${SELECTABLE_LUNCH_CHOICES.join(', ')}` },
      400
    );
  }

  // Check eligibility server-side
  const eligibility = await getEligibilityWithNextDate(db, employee, meal_date);
  if (!eligibility.eligible) {
    return c.json({ 
      success: false, 
      error: `Not eligible: ${eligibility.reason}`,
      nextEligibleDate: eligibility.nextEligibleDate
    }, 403);
  }
  
  // Check menu exists and is published
  const menu = await getMenuDayByDate(db, meal_date);
  if (!menu) {
    return c.json({ success: false, error: 'No menu defined for this date' }, 400);
  }
  
  if (menu.status !== 'published') {
    return c.json({ success: false, error: 'Menu is not yet published' }, 400);
  }
  
  // Check the deadline. Lunch is ordered a day ahead, so the window for a meal
  // closes at the cutoff on the day BEFORE it. Two different situations end up
  // here, and they deserve different explanations:
  //
  //   - the meal is today or earlier: it was never orderable today at all, so
  //     "the cutoff has passed" would read as a near miss that it is not;
  //   - the meal is in the future, but its deadline (the cutoff yesterday-of-
  //     it, i.e. today) has just gone by: that IS the ordinary cutoff case.
  const cutoffPassed = await isCutoffPassed(db, meal_date);
  if (cutoffPassed) {
    const [today, selectable] = await Promise.all([
      getCurrentBusinessDate(db),
      getSelectableMealDate(db),
    ]);
    return c.json(
      {
        success: false,
        error:
          meal_date <= today
            ? `Lunch is chosen a day ahead. ${meal_date} can no longer be ordered; the next date you can choose is ${selectable}.`
            : `The selection cutoff for ${meal_date} has passed - orders close at the cutoff time the day before. The next date you can choose is ${selectable}.`,
        selectableDate: selectable,
      },
      400
    );
  }
  
  try {
    const result = await upsertSelection(
      db,
      employeeId,
      meal_date,
      effectiveChoice,
      'employee',
      null,
      null,
      ipAddress,
      location
    );
    
    // `changed: false` means the employee re-submitted the choice they already
    // had: nothing was written and no history row was created. Reported as 200
    // with the flag, so the client can distinguish "saved" from "already set".
    return c.json(
      { success: true, data: result.selection, changed: result.changed },
      result.changed && !result.beforeJson ? 201 : 200
    );
  } catch (error) {
    console.error('Error saving selection:', error);
    return c.json({ success: false, error: 'Failed to save selection' }, 500);
  }
});

/**
 * GET /api/selections/:date - Get all selections for a date (Admin only)
 */
app.get('/:date', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const mealDate = c.req.param('date')!;
  
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate)) {
    return c.json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
  }
  
  const db = c.env.DB;
  const selections = await getSelectionsByDate(db, mealDate);
  
  return c.json({ success: true, data: selections });
});

/**
 * GET /api/selections/:employeeId/:date/history - Get selection history (Admin only)
 */
app.get('/:employeeId/:date/history', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const employeeId = parseInt(c.req.param('employeeId')!, 10);
  const mealDate = c.req.param('date')!;
  
  if (!employeeId || isNaN(employeeId)) {
    return c.json({ success: false, error: 'Invalid employee_id' }, 400);
  }
  
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate)) {
    return c.json({ success: false, error: 'Invalid date format' }, 400);
  }
  
  const db = c.env.DB;
  const history = await getSelectionHistory(db, employeeId, mealDate);
  
  return c.json({ success: true, data: history });
});

/**
 * POST /api/selections/admin/override - Admin override of employee selection
 */
app.post('/admin/override', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const adminId = session!.employee_id;
  const ipAddress = c.req.header('X-Forwarded-For') || null;
  
  const body = await c.req.json();
  const { employee_id, meal_date, choice, override_reason } = body;
  
  // Validation
  if (!employee_id || typeof employee_id !== 'number') {
    return c.json({ success: false, error: 'employee_id is required' }, 400);
  }
  
  if (!meal_date || !/^\d{4}-\d{2}-\d{2}$/.test(meal_date)) {
    return c.json({ success: false, error: 'Invalid or missing meal_date' }, 400);
  }
  
  // An administrator MAY set 'healthy' here - they are the only one who can,
  // and an override is exactly the case where they need to.
  if (!isLunchChoice(choice)) {
    return c.json({ success: false, error: `choice must be one of: ${LUNCH_CHOICES.join(', ')}` }, 400);
  }

  if (!override_reason || override_reason.trim().length === 0) {
    return c.json({ success: false, error: 'override_reason is required for admin overrides' }, 400);
  }
  
  // Get employee being modified
  const employee = await getEmployeeById(db, employee_id);
  if (!employee) {
    return c.json({ success: false, error: 'Employee not found' }, 404);
  }
  
  try {
    const result = await adminOverrideSelection(
      db,
      employee_id,
      meal_date,
      choice,
      adminId,
      override_reason.trim(),
      ipAddress
    );
    
    // Audit only a real change. Re-submitting an identical override (same
    // choice, same reason) wrote nothing, so recording an audit entry for it
    // would put "an admin changed this" in the trail when they did not.
    if (result.changed) {
      await logSelectionOverride(
        db,
        adminId,
        employee_id,
        meal_date,
        result.beforeJson,
        result.afterJson,
        override_reason.trim(),
        ipAddress
      );
    }

    return c.json(
      { success: true, data: result.selection, changed: result.changed },
      result.changed && !result.beforeJson ? 201 : 200
    );
  } catch (error) {
    console.error('Error overriding selection:', error);
    return c.json({ success: false, error: 'Failed to override selection' }, 500);
  }
});

export { app as selectionRoutes };
