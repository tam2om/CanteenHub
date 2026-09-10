/**
 * Menu Routes
 * Handles menu retrieval and admin management
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { requireAuth, requireRole } from '../middleware/session.js';
import { getPublishedMenuByDate, getFullMenuByDate, getUpcomingPublishedMenus, getMenuDaysInRange, getMenuDayById, menuPublishBlocker, upsertMenuDay, upsertMenuOption, addMenuComponent, updateMenuComponent, publishMenuDay, archiveMenuDay, deleteMenuDay } from '../repositories/menu.repo.js';
import { logMenuChange, logMenuOptionChange, logMenuComponentChange } from '../services/audit.service.js';
import { getCurrentBusinessDate } from '../services/settings.service.js';
import { isValidBusinessDate } from '../lib/datetime.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * GET /api/menu/upcoming - Get upcoming published menus
 *
 * Registered BEFORE /:date because Hono matches routes in registration order;
 * with /:date first, "/upcoming" was swallowed by the date param route and
 * rejected as a malformed date, making this endpoint unreachable.
 */
app.get('/upcoming', async (c) => {
  const db = c.env.DB;

  // Default to the business date in the configured timezone, never the UTC date.
  const requestedFrom = c.req.query('from');
  if (requestedFrom !== undefined && !isValidBusinessDate(requestedFrom)) {
    return c.json({ success: false, error: 'Invalid from date. Use YYYY-MM-DD' }, 400);
  }
  const fromDate = requestedFrom ?? (await getCurrentBusinessDate(db));

  const limit = parseInt(c.req.query('limit') || '7', 10);
  const safeLimit = Number.isNaN(limit) || limit < 1 ? 7 : Math.min(limit, 30);

  const menus = await getUpcomingPublishedMenus(db, fromDate, safeLimit);

  return c.json({ success: true, data: menus });
});

/**
 * Days in a YYYY-MM month, by pure calendar arithmetic.
 *
 * Date.UTC is used as a calendar probe, never as a clock: day 0 of the next
 * month is the last day of this one. No timezone is involved because no
 * "now" is involved.
 */
function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

/**
 * GET /api/menu/admin/range?from=&to= - every menu day in a range (Admin only)
 *
 * The administrative counterpart to /upcoming: that one is employee-facing and
 * shows published days only, which is exactly the wrong thing for a screen
 * whose job is reviewing drafts before they go live.
 *
 * Registered before /:date deliberately - a single-segment param route would
 * otherwise be tried first for anything shaped like a date.
 */
app.get('/admin/range', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const monthParam = c.req.query('month');

  // The server owns every date semantic here, including "which month is it
  // now". The browser never decides that: a client clock in another timezone
  // would silently open the wrong month.
  const today = await getCurrentBusinessDate(db);
  const month = monthParam ?? today.slice(0, 7);

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return c.json({ success: false, error: 'Invalid month. Use YYYY-MM' }, 400);
  }

  const from = `${month}-01`;
  const to = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;

  const menus = await getMenuDaysInRange(db, from, to);
  return c.json({ success: true, data: { menus, month, from, to, today } });
});

/**
 * GET /api/menu/:date - Get published menu for a date
 * Employees can only see published menus
 */
app.get('/:date', async (c) => {
  const mealDate = c.req.param('date')!;
  
  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDate)) {
    return c.json({ success: false, error: 'Invalid date format. Use YYYY-MM-DD' }, 400);
  }
  
  const db = c.env.DB;
  const session = c.get('session');
  const isAdmin = session?.role === 'admin' || session?.role === 'super_admin';
  
  // Admins can see all menus, employees only published
  const menu = isAdmin 
    ? await getFullMenuByDate(db, mealDate)
    : await getPublishedMenuByDate(db, mealDate);
  
  if (!menu) {
    return c.json({ success: false, error: 'Menu not found' + (isAdmin ? '' : ' or not published') }, 404);
  }
  
  return c.json({ success: true, data: menu });
});

/**
 * POST /api/menu - Create/update menu day (Admin only)
 */
app.post('/', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const actorId = session!.employee_id;
  const ipAddress = c.req.header('X-Forwarded-For') || null;
  
  const body = await c.req.json();
  const { meal_date } = body;
  
  // A calendar date, not merely a well-shaped string: 2027-02-30 is refused.
  if (!isValidBusinessDate(meal_date)) {
    return c.json({ success: false, error: 'Invalid or missing meal_date' }, 400);
  }

  // `status` is deliberately NOT read from the request. A menu day is created
  // as a draft and reaches `published` only through the publish endpoint, which
  // checks the menu is complete and audits the transition as a PUBLISH. Letting
  // a create call set status would both bypass that check and, on an existing
  // day, silently unpublish a live menu.
  if (body.status !== undefined) {
    return c.json(
      {
        success: false,
        error: 'status cannot be set here. Use PUT /api/menu/:id/publish or /archive.',
      },
      400
    );
  }
  
  try {
    const result = await upsertMenuDay(db, meal_date);
    
    await logMenuChange(
      db,
      actorId,
      result.menuDay.id,
      meal_date,
      result.beforeJson,
      result.afterJson,
      result.beforeJson ? 'UPDATE' : 'CREATE',
      ipAddress
    );
    
    return c.json({ success: true, data: result.menuDay }, result.beforeJson ? 200 : 201);
  } catch (error) {
    console.error('Error creating/updating menu day:', error);
    return c.json({ success: false, error: 'Failed to save menu day' }, 500);
  }
});

/**
 * POST /api/menu/:id/options - Add/update menu option (Admin only)
 */
app.post('/:id/options', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const actorId = session!.employee_id;
  const ipAddress = c.req.header('X-Forwarded-For') || null;
  const menuDayId = parseInt(c.req.param('id')!, 10);

  const body = await c.req.json();
  const { option_number, name, description } = body;
  
  if (!option_number || ![1, 2].includes(option_number)) {
    return c.json({ success: false, error: 'option_number must be 1 or 2' }, 400);
  }
  
  if (!name) {
    return c.json({ success: false, error: 'name is required' }, 400);
  }
  
  const menuDay = await getMenuDayById(db, menuDayId);
  if (!menuDay) {
    return c.json({ success: false, error: 'Menu day not found' }, 404);
  }

  try {
    // The repository captures the pre-mutation state, performs the write, and
    // re-reads the result, so before/after are a true pair around the change.
    const result = await upsertMenuOption(db, menuDayId, option_number, name, description || null);

    await logMenuOptionChange(
      db,
      actorId,
      menuDayId,
      menuDay.meal_date,
      option_number,
      result.beforeJson,
      result.afterJson,
      result.action,
      ipAddress
    );

    return c.json({ success: true, data: result.option }, result.action === 'CREATE' ? 201 : 200);
  } catch (error) {
    console.error('Error saving menu option:', error);
    return c.json({ success: false, error: 'Failed to save menu option' }, 500);
  }
});

/**
 * POST /api/menu/:id/components - Add menu component (Admin only)
 */
app.post('/:id/components', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const session = c.get('session');
  const actorId = session!.employee_id;
  const ipAddress = c.req.header('X-Forwarded-For') || null;
  const menuDayId = parseInt(c.req.param('id')!, 10);

  const body = await c.req.json();
  const { component_type, name, sort_order = 0, component_id } = body;
  
  const validTypes = ['condiment', 'beverage', 'dessert', 'salad', 'soup', 'bread', 'other'];
  if (!component_type || !validTypes.includes(component_type)) {
    return c.json({ success: false, error: `component_type must be one of: ${validTypes.join(', ')}` }, 400);
  }
  
  if (!name) {
    return c.json({ success: false, error: 'name is required' }, 400);
  }
  
  const menuDay = await getMenuDayById(db, menuDayId);
  if (!menuDay) {
    return c.json({ success: false, error: 'Menu day not found' }, 404);
  }

  try {
    // Passing component_id updates that component in place; omitting it creates
    // a new one. Both paths are audited with a real before/after pair.
    const result = component_id
      ? await updateMenuComponent(db, menuDayId, component_id, component_type, name, sort_order)
      : await addMenuComponent(db, menuDayId, component_type, name, sort_order);

    if (!result) {
      return c.json({ success: false, error: 'Menu component not found for this menu day' }, 404);
    }

    await logMenuComponentChange(
      db,
      actorId,
      menuDayId,
      menuDay.meal_date,
      result.beforeJson,
      result.afterJson,
      result.action,
      ipAddress
    );

    return c.json({ success: true, data: result.component }, result.action === 'CREATE' ? 201 : 200);
  } catch (error) {
    console.error('Error saving menu component:', error);
    return c.json({ success: false, error: 'Failed to save menu component' }, 500);
  }
});

/**
 * PUT /api/menu/:id/publish - Publish menu (Admin only)
 */
app.put('/:id/publish', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const menuDayId = parseInt(c.req.param('id')!, 10);
  const session = c.get('session');
  const ipAddress = c.req.header('X-Forwarded-For') || null;

  if (Number.isNaN(menuDayId)) {
    return c.json({ success: false, error: 'Invalid menu id' }, 400);
  }

  const existing = await getMenuDayById(db, menuDayId);
  if (!existing) {
    return c.json({ success: false, error: 'Menu day not found' }, 404);
  }

  // Completeness is checked HERE rather than in the UI: the API must refuse a
  // half-built menu even when called directly.
  const blocker = await menuPublishBlocker(db, menuDayId);
  if (blocker) {
    return c.json({ success: false, error: blocker }, 400);
  }
  
  try {
    const result = await publishMenuDay(db, menuDayId);
    
    await logMenuChange(
      db,
      session.employee_id,
      menuDayId,
      result.menuDay.meal_date,
      result.beforeJson,
      result.afterJson,
      'PUBLISH',
      ipAddress
    );
    
    return c.json({ success: true, data: result.menuDay });
  } catch (error) {
    console.error('Error publishing menu:', error);
    return c.json({ success: false, error: 'Failed to publish menu' }, 500);
  }
});

/**
 * PUT /api/menu/:id/archive - Archive menu (Admin only)
 */
app.put('/:id/archive', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const menuDayId = parseInt(c.req.param('id')!, 10);
  const session = c.get('session');
  const ipAddress = c.req.header('X-Forwarded-For') || null;

  if (Number.isNaN(menuDayId)) {
    return c.json({ success: false, error: 'Invalid menu id' }, 400);
  }

  const existing = await getMenuDayById(db, menuDayId);
  if (!existing) {
    return c.json({ success: false, error: 'Menu day not found' }, 404);
  }
  
  try {
    const result = await archiveMenuDay(db, menuDayId);
    
    await logMenuChange(
      db,
      session.employee_id,
      menuDayId,
      result.menuDay.meal_date,
      result.beforeJson,
      result.afterJson,
      'ARCHIVE',
      ipAddress
    );
    
    return c.json({ success: true, data: result.menuDay });
  } catch (error) {
    console.error('Error archiving menu:', error);
    return c.json({ success: false, error: 'Failed to archive menu' }, 500);
  }
});

/**
 * DELETE /api/menu/:id - Delete menu (Admin only, only if no selections)
 */
app.delete('/:id', requireAuth, requireRole(['admin', 'super_admin']), async (c) => {
  const db = c.env.DB;
  const menuDayId = parseInt(c.req.param('id')!, 10);
  const session = c.get('session');
  const ipAddress = c.req.header('X-Forwarded-For') || null;
  
  // Get menu day before deletion for audit
  const menuDay = await db
    .prepare('SELECT * FROM menu_days WHERE id = ?')
    .bind(menuDayId)
    .first<{ meal_date: string }>();
  
  if (!menuDay) {
    return c.json({ success: false, error: 'Menu day not found' }, 404);
  }
  
  try {
    const result = await deleteMenuDay(db, menuDayId);
    
    if (!result.success) {
      return c.json({ success: false, error: result.error }, 400);
    }
    
    await logMenuChange(
      db,
      session.employee_id,
      menuDayId,
      menuDay.meal_date,
      JSON.stringify(menuDay),
      null,
      'DELETE',
      ipAddress
    );
    
    return c.json({ success: true, message: 'Menu deleted successfully' });
  } catch (error) {
    console.error('Error deleting menu:', error);
    return c.json({ success: false, error: 'Failed to delete menu' }, 500);
  }
});

export { app as menuRoutes };
