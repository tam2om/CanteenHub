/**
 * Repository Layer - Menu
 * Database access functions for menu operations
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { MenuDay, MenuOption, MenuComponent, MenuStatus, ComponentType, MenuDayWithDetails } from '../../shared/types/index.js';

export interface MenuOptionMutationResult {
  option: MenuOption;
  beforeJson: string | null;
  afterJson: string;
  action: 'CREATE' | 'UPDATE';
}

export interface MenuComponentMutationResult {
  component: MenuComponent;
  beforeJson: string | null;
  afterJson: string;
  action: 'CREATE' | 'UPDATE';
}

export interface MenuMutationResult {
  menuDay: MenuDay;
  beforeJson: string | null;
  afterJson: string | null;
}

/**
 * Get menu day by date
 */
export async function getMenuDayByDate(
  db: D1Database,
  mealDate: string
): Promise<MenuDay | null> {
  const result = await db
    .prepare('SELECT * FROM menu_days WHERE meal_date = ?')
    .bind(mealDate)
    .first<MenuDay>();
  
  return result || null;
}

/**
 * Get full menu details (day + options + components) by date
 */
/**
 * Get a menu day by its primary key. Used by mutation routes that must record
 * the owning day's date in the audit trail.
 */
export async function getMenuDayById(
  db: D1Database,
  menuDayId: number
): Promise<MenuDay | null> {
  const result = await db
    .prepare('SELECT * FROM menu_days WHERE id = ?')
    .bind(menuDayId)
    .first<MenuDay>();

  return result || null;
}

export async function getFullMenuByDate(
  db: D1Database,
  mealDate: string
): Promise<MenuDayWithDetails | null> {
  const menuDay = await getMenuDayByDate(db, mealDate);
  if (!menuDay) return null;
  
  const [options, components] = await Promise.all([
    db
      .prepare('SELECT * FROM menu_options WHERE menu_day_id = ? ORDER BY option_number')
      .bind(menuDay.id)
      .all<MenuOption>(),
    db
      .prepare('SELECT * FROM menu_components WHERE menu_day_id = ? ORDER BY sort_order, component_type')
      .bind(menuDay.id)
      .all<MenuComponent>()
  ]);
  
  return {
    ...menuDay,
    options: options.results || [],
    components: components.results || []
  };
}

/**
 * Get published menu by date (returns null if not published)
 */
export async function getPublishedMenuByDate(
  db: D1Database,
  mealDate: string
): Promise<MenuDayWithDetails | null> {
  const menu = await getFullMenuByDate(db, mealDate);
  if (!menu || menu.status !== 'published') {
    return null;
  }
  return menu;
}

/**
 * Get upcoming published menus
 */
export async function getUpcomingPublishedMenus(
  db: D1Database,
  fromDate: string,
  limit: number = 7
): Promise<MenuDayWithDetails[]> {
  const result = await db
    .prepare(`
      SELECT * FROM menu_days
      WHERE meal_date >= ? AND status = 'published'
      ORDER BY meal_date ASC
      LIMIT ?
    `)
    .bind(fromDate, limit)
    .all<MenuDay>();
  
  const menus: MenuDayWithDetails[] = [];
  for (const menuDay of (result.results || [])) {
    const [options, components] = await Promise.all([
      db
        .prepare('SELECT * FROM menu_options WHERE menu_day_id = ? ORDER BY option_number')
        .bind(menuDay.id)
        .all<MenuOption>(),
      db
        .prepare('SELECT * FROM menu_components WHERE menu_day_id = ? ORDER BY sort_order, component_type')
        .bind(menuDay.id)
        .all<MenuComponent>()
    ]);
    
    menus.push({
      ...menuDay,
      options: options.results || [],
      components: components.results || []
    });
  }
  
  return menus;
}

/**
 * Create or update menu day
 */
export async function upsertMenuDay(
  db: D1Database,
  mealDate: string,
  status: MenuStatus = 'draft'
): Promise<MenuMutationResult> {
  const existing = await getMenuDayByDate(db, mealDate);
  const beforeJson = existing ? JSON.stringify(existing) : null;
  
  if (existing) {
    // Deliberately a no-op for an existing day: `status` applies on creation
    // only. Status transitions belong to publishMenuDay/archiveMenuDay, which
    // check the menu is complete and audit the change as a PUBLISH rather than
    // an incidental UPDATE. Without this, ensuring a menu day exists before
    // editing it would silently unpublish a live menu.
    void status;
  } else {
    await db
      .prepare(`
        INSERT INTO menu_days (meal_date, status)
        VALUES (?, ?)
      `)
      .bind(mealDate, status)
      .run();
  }
  
  const updated = await getMenuDayByDate(db, mealDate);
  if (!updated) {
    throw new Error('Failed to retrieve created/updated menu day');
  }
  
  return {
    menuDay: updated,
    beforeJson,
    afterJson: JSON.stringify(updated)
  };
}

/**
 * Add/update menu option
 */
export async function upsertMenuOption(
  db: D1Database,
  menuDayId: number,
  optionNumber: 1 | 2,
  name: string,
  description: string | null = null
): Promise<MenuOptionMutationResult> {
  // Capture the pre-mutation state so the caller can write a truthful audit
  // record. Reading it here (rather than in the route) keeps the before/after
  // pair atomic with respect to the write.
  const existing = await db
    .prepare('SELECT * FROM menu_options WHERE menu_day_id = ? AND option_number = ?')
    .bind(menuDayId, optionNumber)
    .first<MenuOption>();

  const beforeJson = existing ? JSON.stringify(existing) : null;

  await db
    .prepare(`
      INSERT INTO menu_options (menu_day_id, option_number, name, description)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(menu_day_id, option_number) DO UPDATE SET
        name = excluded.name,
        description = excluded.description
    `)
    .bind(menuDayId, optionNumber, name, description)
    .run();
  
  const result = await db
    .prepare('SELECT * FROM menu_options WHERE menu_day_id = ? AND option_number = ?')
    .bind(menuDayId, optionNumber)
    .first<MenuOption>();
  
  if (!result) {
    throw new Error('Failed to retrieve created/updated menu option');
  }

  return {
    option: result,
    beforeJson,
    afterJson: JSON.stringify(result),
    action: existing ? 'UPDATE' : 'CREATE'
  };
}

/**
 * Add menu component
 */
export async function addMenuComponent(
  db: D1Database,
  menuDayId: number,
  componentType: ComponentType,
  name: string,
  sortOrder: number = 0
): Promise<MenuComponentMutationResult> {
  await db
    .prepare(`
      INSERT INTO menu_components (menu_day_id, component_type, name, sort_order)
      VALUES (?, ?, ?, ?)
    `)
    .bind(menuDayId, componentType, name, sortOrder)
    .run();

  const result = await db
    .prepare('SELECT * FROM menu_components WHERE menu_day_id = ? AND id = last_insert_rowid()')
    .bind(menuDayId)
    .first<MenuComponent>();

  if (!result) {
    throw new Error('Failed to retrieve created menu component');
  }

  return {
    component: result,
    beforeJson: null,
    afterJson: JSON.stringify(result),
    action: 'CREATE'
  };
}

/**
 * Update an existing menu component in place, returning before/after for audit.
 * Returns null when the component does not exist or belongs to another menu day.
 */
export async function updateMenuComponent(
  db: D1Database,
  menuDayId: number,
  componentId: number,
  componentType: ComponentType,
  name: string,
  sortOrder: number = 0
): Promise<MenuComponentMutationResult | null> {
  const existing = await db
    .prepare('SELECT * FROM menu_components WHERE id = ? AND menu_day_id = ?')
    .bind(componentId, menuDayId)
    .first<MenuComponent>();

  if (!existing) {
    return null;
  }

  const beforeJson = JSON.stringify(existing);

  await db
    .prepare(`
      UPDATE menu_components
      SET component_type = ?, name = ?, sort_order = ?
      WHERE id = ? AND menu_day_id = ?
    `)
    .bind(componentType, name, sortOrder, componentId, menuDayId)
    .run();

  const result = await db
    .prepare('SELECT * FROM menu_components WHERE id = ? AND menu_day_id = ?')
    .bind(componentId, menuDayId)
    .first<MenuComponent>();

  if (!result) {
    throw new Error('Failed to retrieve updated menu component');
  }

  return {
    component: result,
    beforeJson,
    afterJson: JSON.stringify(result),
    action: 'UPDATE'
  };
}

/**
 * Publish menu day
 */
/**
 * Why a menu day may not be published yet, or null when it is ready.
 *
 * A lunch menu day is exactly two selectable options. Publishing one with a
 * missing option puts a half-built menu in front of employees and, worse, in
 * front of the caterer.
 */
export async function menuPublishBlocker(
  db: D1Database,
  menuDayId: number
): Promise<string | null> {
  const options = await db
    .prepare('SELECT option_number, name FROM menu_options WHERE menu_day_id = ? ORDER BY option_number')
    .bind(menuDayId)
    .all<{ option_number: number; name: string }>();

  const rows = options.results || [];
  const byNumber = new Map(rows.map((row) => [row.option_number, row.name]));

  const missing = ([1, 2] as const).filter((n) => {
    const name = byNumber.get(n);
    return name === undefined || name.trim() === '';
  });

  if (missing.length > 0) {
    return `This menu cannot be published yet: Option ${missing.join(' and Option ')} ${
      missing.length > 1 ? 'are' : 'is'
    } missing. A lunch menu day needs both options.`;
  }

  return null;
}

/**
 * Every menu day in a date range, WHATEVER its status, with options and
 * components.
 *
 * Distinct from getUpcomingPublishedMenus, which is the employee-facing view
 * and shows published days only. Administrators must see drafts - reviewing
 * them is the whole point of the screen.
 */
export async function getMenuDaysInRange(
  db: D1Database,
  fromDate: string,
  toDate: string
): Promise<MenuDayWithDetails[]> {
  const result = await db
    .prepare(
      `SELECT * FROM menu_days
        WHERE meal_date >= ? AND meal_date <= ?
        ORDER BY meal_date ASC`
    )
    .bind(fromDate, toDate)
    .all<MenuDay>();

  const days = result.results || [];
  if (days.length === 0) return [];

  // Two queries for the whole range rather than two per day: a month view of
  // 31 days would otherwise cost 62 round trips against a 50-query budget.
  const ids = days.map((day) => day.id);
  const placeholders = ids.map(() => '?').join(', ');

  const [optionRows, componentRows] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM menu_options WHERE menu_day_id IN (${placeholders})
          ORDER BY menu_day_id, option_number`
      )
      .bind(...ids)
      .all<MenuOption>(),
    db
      .prepare(
        `SELECT * FROM menu_components WHERE menu_day_id IN (${placeholders})
          ORDER BY menu_day_id, sort_order, id`
      )
      .bind(...ids)
      .all<MenuComponent>(),
  ]);

  const optionsByDay = new Map<number, MenuOption[]>();
  for (const option of optionRows.results || []) {
    const list = optionsByDay.get(option.menu_day_id) ?? [];
    list.push(option);
    optionsByDay.set(option.menu_day_id, list);
  }

  const componentsByDay = new Map<number, MenuComponent[]>();
  for (const component of componentRows.results || []) {
    const list = componentsByDay.get(component.menu_day_id) ?? [];
    list.push(component);
    componentsByDay.set(component.menu_day_id, list);
  }

  return days.map((day) => ({
    ...day,
    options: optionsByDay.get(day.id) ?? [],
    components: componentsByDay.get(day.id) ?? [],
  }));
}

export async function publishMenuDay(
  db: D1Database,
  menuDayId: number
): Promise<MenuMutationResult> {
  const existing = await db
    .prepare('SELECT * FROM menu_days WHERE id = ?')
    .bind(menuDayId)
    .first<MenuDay>();
  
  if (!existing) {
    throw new Error('Menu day not found');
  }
  
  const beforeJson = JSON.stringify(existing);
  
  await db
    .prepare(`
      UPDATE menu_days
      SET status = 'published', updated_at = datetime('now')
      WHERE id = ?
    `)
    .bind(menuDayId)
    .run();
  
  const updated = await db
    .prepare('SELECT * FROM menu_days WHERE id = ?')
    .bind(menuDayId)
    .first<MenuDay>();
  
  if (!updated) {
    throw new Error('Failed to retrieve updated menu day');
  }
  
  return {
    menuDay: updated,
    beforeJson,
    afterJson: JSON.stringify(updated)
  };
}

/**
 * Archive menu day (soft delete alternative)
 */
export async function archiveMenuDay(
  db: D1Database,
  menuDayId: number
): Promise<MenuMutationResult> {
  const existing = await db
    .prepare('SELECT * FROM menu_days WHERE id = ?')
    .bind(menuDayId)
    .first<MenuDay>();
  
  if (!existing) {
    throw new Error('Menu day not found');
  }
  
  const beforeJson = JSON.stringify(existing);
  
  await db
    .prepare(`
      UPDATE menu_days
      SET status = 'archived', updated_at = datetime('now')
      WHERE id = ?
    `)
    .bind(menuDayId)
    .run();
  
  const updated = await db
    .prepare('SELECT * FROM menu_days WHERE id = ?')
    .bind(menuDayId)
    .first<MenuDay>();
  
  if (!updated) {
    throw new Error('Failed to retrieve updated menu day');
  }
  
  return {
    menuDay: updated,
    beforeJson,
    afterJson: JSON.stringify(updated)
  };
}

/**
 * Delete menu day (only if no selections exist)
 */
export async function deleteMenuDay(
  db: D1Database,
  menuDayId: number
): Promise<{ success: boolean; error?: string }> {
  // Check if any selections reference this menu day
  const menuDay = await db
    .prepare('SELECT meal_date FROM menu_days WHERE id = ?')
    .bind(menuDayId)
    .first<{ meal_date: string }>();
  
  if (!menuDay) {
    return { success: false, error: 'Menu day not found' };
  }
  
  const selectionCount = await db
    .prepare('SELECT COUNT(*) as count FROM lunch_selections WHERE meal_date = ?')
    .bind(menuDay.meal_date)
    .first<{ count: number }>();
  
  if ((selectionCount?.count || 0) > 0) {
    return { 
      success: false, 
      error: 'Cannot delete menu day with existing selections. Archive instead.' 
    };
  }
  
  // Delete options and components first (they have ON DELETE CASCADE, but being explicit)
  await db
    .prepare('DELETE FROM menu_options WHERE menu_day_id = ?')
    .bind(menuDayId)
    .run();
  
  await db
    .prepare('DELETE FROM menu_components WHERE menu_day_id = ?')
    .bind(menuDayId)
    .run();
  
  // Delete menu day
  await db
    .prepare('DELETE FROM menu_days WHERE id = ?')
    .bind(menuDayId)
    .run();
  
  return { success: true };
}
