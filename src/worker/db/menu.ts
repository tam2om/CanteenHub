/**
 * Database Access Layer - Menu
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { MenuDay, MenuOption, MenuComponent, MenuDayWithDetails, MenuStatus } from '../../shared/types/index.js';

export interface MenuDayDB extends MenuDay {}
export interface MenuOptionDB extends MenuOption {}
export interface MenuComponentDB extends MenuComponent {}

/**
 * Get menu day by date
 */
export async function getMenuDayByDate(db: D1Database, mealDate: string): Promise<MenuDayDB | null> {
  const result = await db
    .prepare('SELECT * FROM menu_days WHERE meal_date = ?')
    .bind(mealDate)
    .first<MenuDayDB>();
  
  return result || null;
}

/**
 * Get menu day with options and components
 */
export async function getMenuDayWithDetails(db: D1Database, mealDate: string): Promise<MenuDayWithDetails | null> {
  const menuDay = await getMenuDayByDate(db, mealDate);
  if (!menuDay) return null;
  
  // Get options
  const optionsResult = await db
    .prepare('SELECT * FROM menu_options WHERE menu_day_id = ? ORDER BY option_number')
    .bind(menuDay.id)
    .all<MenuOptionDB>();
  
  // Get components
  const componentsResult = await db
    .prepare('SELECT * FROM menu_components WHERE menu_day_id = ? ORDER BY sort_order, id')
    .bind(menuDay.id)
    .all<MenuComponentDB>();
  
  return {
    ...menuDay,
    options: optionsResult.results || [],
    components: componentsResult.results || [],
  };
}

/**
 * Create menu day
 */
export async function createMenuDay(
  db: D1Database,
  mealDate: string,
  status: MenuStatus = 'draft'
): Promise<MenuDayDB> {
  await db
    .prepare('INSERT INTO menu_days (meal_date, status) VALUES (?, ?)')
    .bind(mealDate, status)
    .run();
  
  return getMenuDayByDate(db, mealDate) as Promise<MenuDayDB>;
}

/**
 * Update menu day status
 */
export async function updateMenuDayStatus(
  db: D1Database,
  mealDate: string,
  status: MenuStatus
): Promise<MenuDayDB | null> {
  await db
    .prepare("UPDATE menu_days SET status = ?, updated_at = datetime('now') WHERE meal_date = ?")
    .bind(status, mealDate)
    .run();
  
  return getMenuDayByDate(db, mealDate);
}

/**
 * Create or update menu option
 */
export async function upsertMenuOption(
  db: D1Database,
  menuDayId: number,
  optionNumber: 1 | 2,
  name: string,
  description?: string | null
): Promise<MenuOptionDB> {
  const result = await db
    .prepare(`
      INSERT INTO menu_options (menu_day_id, option_number, name, description)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(menu_day_id, option_number) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        updated_at = datetime('now')
    `)
    .bind(menuDayId, optionNumber, name, description ?? null)
    .run();
  
  return getMenuOptionById(db, result.meta.last_row_id as number) as Promise<MenuOptionDB>;
}

/**
 * Get menu option by ID
 */
export async function getMenuOptionById(db: D1Database, id: number): Promise<MenuOptionDB | null> {
  const result = await db
    .prepare('SELECT * FROM menu_options WHERE id = ?')
    .bind(id)
    .first<MenuOptionDB>();
  
  return result || null;
}

/**
 * Create menu component
 */
export async function createMenuComponent(
  db: D1Database,
  menuDayId: number,
  componentType: string,
  name: string,
  sortOrder: number = 0
): Promise<MenuComponentDB> {
  const result = await db
    .prepare('INSERT INTO menu_components (menu_day_id, component_type, name, sort_order) VALUES (?, ?, ?, ?)')
    .bind(menuDayId, componentType, name, sortOrder)
    .run();
  
  return getMenuComponentById(db, result.meta.last_row_id as number) as Promise<MenuComponentDB>;
}

/**
 * Get menu component by ID
 */
export async function getMenuComponentById(db: D1Database, id: number): Promise<MenuComponentDB | null> {
  const result = await db
    .prepare('SELECT * FROM menu_components WHERE id = ?')
    .bind(id)
    .first<MenuComponentDB>();
  
  return result || null;
}

/**
 * Get published menu days in date range
 */
export async function getPublishedMenuDays(
  db: D1Database,
  startDate: string,
  endDate: string,
  limit: number = 30
): Promise<MenuDayDB[]> {
  const result = await db
    .prepare(`
      SELECT * FROM menu_days
      WHERE status = 'published'
        AND meal_date >= ?
        AND meal_date <= ?
      ORDER BY meal_date ASC
      LIMIT ?
    `)
    .bind(startDate, endDate, limit)
    .all<MenuDayDB>();
  
  return result.results || [];
}
