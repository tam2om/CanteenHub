/**
 * Settings Service Layer
 * Database access for application settings
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Setting } from '../../shared/types/index.js';

/**
 * Get setting by key
 */
export async function getSetting(
  db: D1Database,
  key: string
): Promise<Setting | null> {
  const result = await db
    .prepare('SELECT * FROM settings WHERE key = ?')
    .bind(key)
    .first<Setting>();
  
  return result || null;
}

/**
 * Get all settings
 */
export async function getAllSettings(db: D1Database): Promise<Setting[]> {
  const result = await db
    .prepare('SELECT * FROM settings ORDER BY key')
    .all<Setting>();
  
  return result.results || [];
}

/**
 * Update setting value
 */
export async function updateSetting(
  db: D1Database,
  key: string,
  value: string,
  valueType: 'string' | 'number' | 'boolean' | 'json' | 'time',
  updatedBy: number | null = null
): Promise<Setting> {
  await db
    .prepare(`
      INSERT INTO settings (key, value, value_type, updated_at, updated_by)
      VALUES (?, ?, ?, datetime('now'), ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        value_type = excluded.value_type,
        updated_at = datetime('now'),
        updated_by = excluded.updated_by
    `)
    .bind(key, value, valueType, updatedBy)
    .run();
  
  const result = await getSetting(db, key);
  if (!result) {
    throw new Error('Failed to retrieve updated setting');
  }
  
  return result;
}

/**
 * Get lunch cutoff time as minutes since midnight (Asia/Amman timezone)
 */
export async function getCutoffMinutes(db: D1Database): Promise<number> {
  const setting = await getSetting(db, 'lunch_cutoff_time');
  if (!setting) {
    return 600; // Default 10:00 AM = 600 minutes
  }
  
  const [hours, minutes] = setting.value.replace(/"/g, '').split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Check if current time (Asia/Amman) is before cutoff
 */
export async function isCutoffPassed(db: D1Database, mealDate: string): Promise<boolean> {
  const cutoffMinutes = await getCutoffMinutes(db);
  
  // Get current time in Asia/Amman timezone
  const now = new Date();
  const ammanTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Amman' }));
  
  // If the meal date is in the past, cutoff has passed
  const mealDateObj = parseDate(mealDate);
  const today = new Date(ammanTime.getFullYear(), ammanTime.getMonth(), ammanTime.getDate());
  
  if (mealDateObj < today) {
    return true;
  }
  
  // If the meal date is in the future, cutoff has not passed
  if (mealDateObj > today) {
    return false;
  }
  
  // Same day: compare minutes since midnight
  const currentMinutes = ammanTime.getHours() * 60 + ammanTime.getMinutes();
  return currentMinutes >= cutoffMinutes;
}

function parseDate(dateString: string): Date {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day);
}
