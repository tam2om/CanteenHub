/**
 * Repository Layer - Company Holidays
 *
 * Holidays make every employee ineligible on the configured date, surfacing the
 * existing HOLIDAY denial reason. The eligibility rules themselves are unchanged;
 * this only supplies the holiday set that the rules already expected.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { BusinessDate } from '../lib/datetime.js';

export interface Holiday {
  holiday_date: BusinessDate;
  name: string;
  created_at: string;
  created_by: number | null;
}

/**
 * Every configured holiday, ascending by date.
 */
export async function listHolidays(db: D1Database): Promise<Holiday[]> {
  const result = await db
    .prepare('SELECT * FROM holidays ORDER BY holiday_date ASC')
    .all<Holiday>();

  return result.results || [];
}

export async function getHoliday(db: D1Database, date: BusinessDate): Promise<Holiday | null> {
  const result = await db
    .prepare('SELECT * FROM holidays WHERE holiday_date = ?')
    .bind(date)
    .first<Holiday>();

  return result || null;
}

/**
 * All holiday dates as a Set, for the eligibility calculation.
 *
 * The whole table is loaded rather than a date range: a company has on the order
 * of fifteen holidays a year, so this is a handful of rows, and a single Set is
 * what both the single-date check and the next-eligible-date walk need.
 */
export async function getHolidayDateSet(db: D1Database): Promise<Set<BusinessDate>> {
  const result = await db
    .prepare('SELECT holiday_date FROM holidays')
    .all<{ holiday_date: string }>();

  return new Set((result.results || []).map((row) => row.holiday_date));
}

export interface HolidayMutationResult {
  holiday: Holiday;
  beforeJson: string | null;
  afterJson: string;
  action: 'CREATE' | 'UPDATE';
}

/**
 * Create a holiday, or rename an existing one on the same date.
 * Returns before/after state so the caller can write a truthful audit record.
 */
export async function upsertHoliday(
  db: D1Database,
  date: BusinessDate,
  name: string,
  createdBy: number
): Promise<HolidayMutationResult> {
  const existing = await getHoliday(db, date);
  const beforeJson = existing ? JSON.stringify(existing) : null;

  await db
    .prepare(
      `INSERT INTO holidays (holiday_date, name, created_by)
       VALUES (?, ?, ?)
       ON CONFLICT(holiday_date) DO UPDATE SET name = excluded.name`
    )
    .bind(date, name, createdBy)
    .run();

  const holiday = await getHoliday(db, date);
  if (!holiday) {
    throw new Error('Failed to retrieve created/updated holiday');
  }

  return {
    holiday,
    beforeJson,
    afterJson: JSON.stringify(holiday),
    action: existing ? 'UPDATE' : 'CREATE',
  };
}

/**
 * Delete a holiday. Returns the deleted row for audit, or null if absent.
 *
 * A hard delete is correct here, unlike operational records: a holiday is
 * configuration, it references no other row, and removing one is exactly the
 * "this day is a working day after all" correction an admin needs. No meal
 * selection or history row is touched.
 */
export async function deleteHoliday(db: D1Database, date: BusinessDate): Promise<Holiday | null> {
  const existing = await getHoliday(db, date);
  if (!existing) {
    return null;
  }

  await db.prepare('DELETE FROM holidays WHERE holiday_date = ?').bind(date).run();

  return existing;
}
