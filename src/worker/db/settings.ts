/**
 * Database Access Layer - Settings
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Setting, AppSettings } from '../../shared/types/index.js';

export interface SettingDB extends Setting {}

/**
 * Get setting by key
 */
export async function getSetting(db: D1Database, key: string): Promise<SettingDB | null> {
  const result = await db
    .prepare('SELECT * FROM settings WHERE key = ?')
    .bind(key)
    .first<SettingDB>();
  
  return result || null;
}

/**
 * Get all settings as AppSettings object
 */
export async function getAppSettings(db: D1Database): Promise<AppSettings> {
  const settings = await db
    .prepare('SELECT * FROM settings')
    .all<SettingDB>();
  
  const defaults: AppSettings = {
    lunch_cutoff_time: '10:00',
    working_days: [0, 1, 2, 3, 4], // Sunday-Thursday
    timezone: 'Asia/Amman',
    allow_future_selection: false,
  };
  
  for (const row of settings.results || []) {
    try {
      const parsedValue = JSON.parse(row.value);
      
      switch (row.key) {
        case 'lunch_cutoff_time':
          defaults.lunch_cutoff_time = parsedValue;
          break;
        case 'working_days':
          defaults.working_days = parsedValue;
          break;
        case 'timezone':
          defaults.timezone = parsedValue;
          break;
        case 'allow_future_selection':
          defaults.allow_future_selection = parsedValue;
          break;
      }
    } catch (e) {
      console.error(`Failed to parse setting ${row.key}:`, e);
    }
  }
  
  return defaults;
}

/**
 * Update setting value
 */
export async function updateSetting(
  db: D1Database,
  key: string,
  value: unknown,
  valueType: 'string' | 'number' | 'boolean' | 'json' | 'time',
  updatedBy: number | null = null
): Promise<SettingDB | null> {
  const jsonValue = JSON.stringify(value);
  
  await db
    .prepare(`
      INSERT INTO settings (key, value, value_type, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        value_type = excluded.value_type,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `)
    .bind(key, jsonValue, valueType, updatedBy)
    .run();
  
  return getSetting(db, key);
}

/**
 * Get lunch cutoff time
 */
export async function getLunchCutoffTime(db: D1Database): Promise<string> {
  const setting = await getSetting(db, 'lunch_cutoff_time');
  if (!setting) return '10:00';
  
  try {
    return JSON.parse(setting.value);
  } catch {
    return '10:00';
  }
}

/**
 * Get working days
 */
export async function getWorkingDays(db: D1Database): Promise<number[]> {
  const setting = await getSetting(db, 'working_days');
  if (!setting) return [0, 1, 2, 3, 4]; // Default Sunday-Thursday
  
  try {
    return JSON.parse(setting.value);
  } catch {
    return [0, 1, 2, 3, 4];
  }
}

/**
 * Check if cutoff has passed for a given date
 */
export async function isCutoffPassed(
  db: D1Database,
  mealDate: string,
  currentTime: Date = new Date()
): Promise<boolean> {
  const cutoffTime = await getLunchCutoffTime(db);
  const [hours, minutes] = cutoffTime.split(':').map(Number);
  
  // Parse meal date in Asia/Amman timezone
  const [year, month, day] = mealDate.split('-').map(Number);
  const mealDateTime = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  
  // For simplicity, compare in UTC
  // In production, proper timezone handling may be needed
  return currentTime.getTime() >= mealDateTime.getTime();
}
