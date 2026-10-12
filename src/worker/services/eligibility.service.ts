/**
 * Eligibility Service Layer
 * Combines the pure domain logic with database lookups.
 *
 * The domain function (domain/eligibility.ts) decides IF an employee is eligible
 * on a given date. This layer supplies it with real data, and answers the one
 * question it structurally cannot: WHEN the employee is next eligible.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { DayShiftOverride, Employee, EligibilityResponse } from '../../shared/types/index.js';
import {
  computeEligibility,
  isDayShiftOverrideActive,
  type EligibilityContext,
} from '../domain/eligibility.js';
import { getRosterEntry, getFutureEligibleShifts, getPublishedMenuDates } from '../repositories/roster.repo.js';
import { getDayShiftOverride, getSetting, getTimezone } from './settings.service.js';
import { getHolidayDateSet } from '../repositories/holidays.repo.js';
import { getWeekday, type BusinessDate } from '../lib/datetime.js';

const DEFAULT_WORKING_DAYS = [0, 1, 2, 3, 4]; // Sunday-Thursday

export interface EligibilityConfig {
  workingDays: number[];
  holidays: Set<BusinessDate>;
  timezone: string;
  dayShiftOverride: DayShiftOverride | null;
}

/**
 * Load the configuration the eligibility rules depend on.
 */
export async function loadEligibilityConfig(db: D1Database): Promise<EligibilityConfig> {
  const workingDaysSetting = await getSetting(db, 'working_days');
  const timezone = await getTimezone(db);

  let workingDays = DEFAULT_WORKING_DAYS;
  if (workingDaysSetting) {
    try {
      const parsed = JSON.parse(workingDaysSetting.value) as unknown;
      if (Array.isArray(parsed) && parsed.every((d) => typeof d === 'number')) {
        workingDays = parsed as number[];
      }
    } catch {
      console.error('Invalid working_days setting; falling back to Sunday-Thursday.');
    }
  }

  // Real configured company holidays. The eligibility RULES are unchanged - the
  // domain function already handled a holiday set and returned the HOLIDAY
  // denial reason; until now it was simply always given an empty one.
  const holidays = await getHolidayDateSet(db);

  const dayShiftOverride = await getDayShiftOverride(db);

  return { workingDays, holidays, timezone, dayShiftOverride };
}

/**
 * Get full eligibility determination including the next eligible date.
 */
export async function getEligibilityWithNextDate(
  db: D1Database,
  employee: Employee,
  mealDate: BusinessDate
): Promise<EligibilityResponse> {
  const rosterEntry = employee.roster_type === 'shift'
    ? await getRosterEntry(db, employee.id, mealDate)
    : null;

  const { workingDays, holidays, dayShiftOverride } = await loadEligibilityConfig(db);

  const context: EligibilityContext = {
    employee,
    mealDate,
    rosterEntry,
    workingDays,
    holidays,
    dayShiftOverride,
  };

  // Pure computation, no I/O.
  const baseResult = computeEligibility(context);

  if (!baseResult.eligible) {
    return {
      ...baseResult,
      nextEligibleDate: await findNextEligibleMealDate(
        db, employee, mealDate, workingDays, holidays, dayShiftOverride
      ),
    };
  }

  return baseResult;
}

/**
 * Find the next date on which this employee can actually take a meal.
 *
 * This is driven ENTIRELY by data that exists: published menu days, and (for
 * shift employees) published roster entries. There is no calendar scan and no
 * search horizon - not 365 days, not 90, not any number. The search space is the
 * set of published menu dates, so:
 *
 *   - a genuinely eligible date two years out IS found, provided its menu is
 *     published;
 *   - when no future menu establishes an eligible meal, the answer is `null`
 *     rather than an invented date.
 *
 * Returns null for Amman HQ and inactive employees, who are never eligible.
 */
export async function findNextEligibleMealDate(
  db: D1Database,
  employee: Employee,
  fromDate: BusinessDate,
  workingDays: number[],
  holidays: Set<BusinessDate>,
  dayShiftOverride: DayShiftOverride | null = null
): Promise<BusinessDate | null> {
  // Amman HQ employees never receive a company meal; inactive employees cannot
  // select at all. Neither has a "next" date, and inventing one would be a lie.
  if (employee.roster_type === 'amman_hq' || !employee.is_active) {
    return null;
  }

  // The candidate set: actual published menu dates, ascending, from today on.
  const publishedMenuDates = await getPublishedMenuDates(db, fromDate);
  if (publishedMenuDates.length === 0) {
    return null;
  }

  if (employee.roster_type === 'regular') {
    // Walk the real published menu dates, not the calendar. The first one that
    // is strictly after `fromDate`, falls on a configured working day, and is
    // not a holiday, is the answer.
    for (const menuDate of publishedMenuDates) {
      if (menuDate <= fromDate) {
        continue;
      }
      if (!workingDays.includes(getWeekday(menuDate))) {
        continue;
      }
      if (holidays.has(menuDate)) {
        continue;
      }
      return menuDate;
    }
    return null;
  }

  if (employee.roster_type === 'shift') {
    // Walk the published menu dates and keep the first one the employee is
    // rostered Day/Night on, or that the day-shift override covers. Both sides
    // are real records.
    const futureShiftDates = new Set(
      (await getFutureEligibleShifts(db, employee.id, fromDate)).map((shift) => shift.work_date)
    );

    for (const menuDate of publishedMenuDates) {
      if (menuDate <= fromDate) {
        continue;
      }
      if (holidays.has(menuDate)) {
        continue;
      }
      if (futureShiftDates.has(menuDate) || isDayShiftOverrideActive(dayShiftOverride, menuDate)) {
        return menuDate;
      }
    }
    return null;
  }

  return null;
}
