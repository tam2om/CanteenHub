/**
 * Repository Layer - Menu
 * Database access functions for menu operations
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { MenuDay, MenuOption, MenuComponent, MenuStatus, ComponentType, MenuDayWithDetails } from '../../shared/types/index.js';

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
    await db
      .prepare(`
        UPDATE menu_days
        SET status = ?, updated_at = datetime('now')
        WHERE meal_date = ?
      `)
      .bind(status, mealDate)
      .run();
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
): Promise<MenuOption> {
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
  
  return result;
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
): Promise<MenuComponent> {
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
  
  return result;
}

/**
 * Publish menu day
 */
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
