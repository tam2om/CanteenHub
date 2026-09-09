/**
 * Settings Service Layer
 * Database access for application settings
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Setting } from '../../shared/types/index.js';
import {
  DEFAULT_TIMEZONE,
  getBusinessDate,
  getBusinessTimeMinutes,
  resolveTimezone,
  compareBusinessDates,
  type BusinessDate,
} from '../lib/datetime.js';

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
 * The configured IANA business timezone (defaults to Asia/Amman).
 *
 * Settings values are JSON-encoded, so a stored `"Asia/Amman"` arrives with
 * quotes; strip them before use.
 */
export async function getTimezone(db: D1Database): Promise<string> {
  const setting = await getSetting(db, 'timezone');
  if (!setting) {
    return DEFAULT_TIMEZONE;
  }
  return resolveTimezone(setting.value.replace(/^"|"$/g, '').trim());
}

/**
 * Today's business date (YYYY-MM-DD) in the configured timezone.
 *
 * Every route that needs "today" must call this rather than deriving a date
 * from `new Date().toISOString()`, which yields the UTC date and is wrong for
 * roughly three hours of every Amman day.
 */
export async function getCurrentBusinessDate(
  db: D1Database,
  now: Date = new Date()
): Promise<BusinessDate> {
  return getBusinessDate(await getTimezone(db), now);
}

/**
 * Get lunch cutoff time as minutes since midnight, in the business timezone.
 */
export async function getCutoffMinutes(db: D1Database): Promise<number> {
  const setting = await getSetting(db, 'lunch_cutoff_time');
  if (!setting) {
    return 600; // Default 10:00 = 600 minutes
  }

  const [hours, minutes] = setting.value.replace(/"/g, '').split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return 600;
  }
  return hours * 60 + minutes;
}

/**
 * Has the selection cutoff passed for the given meal date?
 *
 * Both "what day is it now" and "what time is it now" are resolved through the
 * configured IANA timezone. The previous implementation round-tripped through
 * `toLocaleString('en-US', ...)` and re-parsed the result, which depends on the
 * runtime's locale parsing and on the server's local timezone - it produced the
 * wrong answer near midnight. Nothing here uses a fixed UTC offset.
 */
export async function isCutoffPassed(db: D1Database, mealDate: BusinessDate): Promise<boolean> {
  const timezone = await getTimezone(db);
  const cutoffMinutes = await getCutoffMinutes(db);
  const now = new Date();

  const today = getBusinessDate(timezone, now);
  const comparison = compareBusinessDates(mealDate, today);

  // Past meal date: the cutoff necessarily passed.
  if (comparison < 0) {
    return true;
  }

  // Future meal date: the cutoff definitionally has not passed.
  if (comparison > 0) {
    return false;
  }

  // Same business day: compare against the wall clock in the business timezone.
  return getBusinessTimeMinutes(timezone, now) >= cutoffMinutes;
}
