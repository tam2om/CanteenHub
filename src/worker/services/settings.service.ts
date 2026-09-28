/**
 * Settings Service Layer
 * Database access for application settings
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Setting } from '../../shared/types/index.js';
import {
  DEFAULT_TIMEZONE,
  addBusinessDays,
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
 * Has the selection deadline passed for the given meal date?
 *
 * LUNCH IS ORDERED A DAY AHEAD. The kitchen buys and preps for tomorrow, so the
 * deadline for a meal on date D is the cutoff time on D MINUS ONE DAY, not on D
 * itself. Today's lunch is therefore always closed: its deadline was yesterday.
 *
 * Both "what day is it now" and "what time is it now" are resolved through the
 * configured IANA timezone. Nothing here uses a fixed UTC offset.
 */
export async function isCutoffPassed(db: D1Database, mealDate: BusinessDate): Promise<boolean> {
  const timezone = await getTimezone(db);
  const cutoffMinutes = await getCutoffMinutes(db);
  const now = new Date();

  const today = getBusinessDate(timezone, now);
  // The day the ordering window for this meal closes.
  const deadlineDate = addBusinessDays(mealDate, -1);
  const comparison = compareBusinessDates(deadlineDate, today);

  // The deadline day is already behind us.
  if (comparison < 0) {
    return true;
  }

  // The deadline day has not arrived; the window is open.
  if (comparison > 0) {
    return false;
  }

  // Deadline day: compare against the wall clock in the business timezone.
  return getBusinessTimeMinutes(timezone, now) >= cutoffMinutes;
}

/**
 * The meal date an employee is choosing for right now.
 *
 * Before the cutoff today, tomorrow's lunch is open. Once it passes, tomorrow
 * is settled and the next thing anyone can order is the day after - so an
 * employee is never shown a day they cannot act on, and there is no dead window
 * in which the portal has nothing to offer.
 *
 * Whether the employee is ELIGIBLE on that date, and whether a menu is
 * published for it, are separate questions answered elsewhere. This one only
 * says which day is being ordered.
 */
export async function getSelectableMealDate(
  db: D1Database,
  now: Date = new Date()
): Promise<BusinessDate> {
  const timezone = await getTimezone(db);
  const cutoffMinutes = await getCutoffMinutes(db);
  const today = getBusinessDate(timezone, now);
  const beforeCutoff = getBusinessTimeMinutes(timezone, now) < cutoffMinutes;
  return addBusinessDays(today, beforeCutoff ? 1 : 2);
}
