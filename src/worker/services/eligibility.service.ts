/**
 * Eligibility Service Layer
 * Combines pure domain logic with database lookups
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { Employee, EligibilityResponse, RosterEntry } from '../../shared/types/index.js';
import { computeEligibility, type EligibilityContext } from '../domain/eligibility.js';
import { getRosterEntry, getFutureEligibleShifts, getPublishedMenuDates } from '../repositories/roster.repo.js';
import { getMenuDayByDate } from '../repositories/menu.repo.js';
import { getSetting } from './settings.service.js';

/**
 * Get full eligibility determination including next eligible date
 * This is the main service function that combines DB lookups with pure eligibility logic
 */
export async function getEligibilityWithNextDate(
  db: D1Database,
  employee: Employee,
  mealDate: string
): Promise<EligibilityResponse> {
  // Get roster entry for the specific date (for shift employees)
  const rosterEntry = employee.roster_type === 'shift' 
    ? await getRosterEntry(db, employee.id, mealDate)
    : null;
  
  // Get settings
  const workingDaysSetting = await getSetting(db, 'working_days');
  const timezoneSetting = await getSetting(db, 'timezone');
  
  const workingDays = workingDaysSetting ? JSON.parse(workingDaysSetting.value) as number[] : [0, 1, 2, 3, 4];
  const _timezone = timezoneSetting?.value || 'Asia/Amman';
  
  // Get holidays (from settings or a dedicated table in future)
  const holidays = new Set<string>();
  
  // Build context for pure eligibility calculation
  const context: EligibilityContext = {
    employee,
    mealDate,
    rosterEntry,
    workingDays,
    holidays
  };
  
  // Compute base eligibility (pure function, no DB calls)
  const baseResult = computeEligibility(context);
  
  // If ineligible and we can determine next eligible date, do so
  if (!baseResult.eligible) {
    const nextDate = await findNextEligibleMealDate(
      db,
      employee,
      mealDate,
      workingDays,
      holidays
    );
    
    return {
      ...baseResult,
      nextEligibleDate: nextDate
    };
  }
  
  return baseResult;
}

/**
 * Find the next eligible meal date for an employee
 * Searches forward through roster/menu data without arbitrary limits
 */
export async function findNextEligibleMealDate(
  db: D1Database,
  employee: Employee,
  fromDate: string,
  workingDays: number[],
  holidays: Set<string>
): Promise<string | null> {
  // Amman HQ and inactive employees are never eligible
  if (employee.roster_type === 'amman_hq' || !employee.is_active) {
    return null;
  }
  
  // Get future published menu dates
  const publishedMenus = await getPublishedMenuDates(db, fromDate);
  
  if (publishedMenus.size === 0) {
    return null; // No future menus published
  }
  
  // Regular employees: find next working day with published menu
  if (employee.roster_type === 'regular') {
    let current = parseDate(fromDate);
    
    // Search up to 365 days ahead (practical limit for performance)
    for (let i = 1; i <= 365; i++) {
      current = addDays(current, 1);
      const dateStr = formatDate(current);
      
      // Skip if not a working day
      const weekday = getWeekday(dateStr);
      if (!workingDays.includes(weekday)) {
        continue;
      }
      
      // Skip if holiday
      if (holidays.has(dateStr)) {
        continue;
      }
      
      // Check if menu is published for this date
      if (publishedMenus.has(dateStr)) {
        return dateStr;
      }
    }
    
    return null; // No eligible date found within search horizon
  }
  
  // Shift employees: find next Day/Night shift with published menu
  if (employee.roster_type === 'shift') {
    const futureShifts = await getFutureEligibleShifts(db, employee.id, fromDate);
    
    for (const shift of futureShifts) {
      // Check if menu is published for this shift date
      if (publishedMenus.has(shift.work_date)) {
        return shift.work_date;
      }
    }
    
    return null; // No eligible shift with published menu found
  }
  
  return null;
}

// Helper functions for date manipulation
function getWeekday(dateString: string): number {
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDay(); // 0=Sunday, 6=Saturday
}

function parseDate(dateString: string): Date {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
