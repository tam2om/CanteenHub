/**
 * Eligibility Engine
 * Server-side eligibility calculation for meal selection
 * 
 * Rules:
 * - Regular employees: Sunday-Thursday eligible, Friday-Saturday not eligible
 * - Shift employees: Day/Night eligible, Off not eligible, missing roster = not eligible
 * - Amman HQ: Never eligible
 * - Inactive employees: Never eligible
 *
 * This module is PURE: no database access, no clock reads, no I/O. It therefore
 * cannot know which future dates have published menus or rostered shifts, so it
 * always returns `nextEligibleDate: null`. That field is populated by
 * eligibility.service.ts from real menu and roster data. Computing it here would
 * require guessing forward over the calendar, which is exactly the arbitrary
 * search horizon this design removes.
 */

import type { Employee, RosterEntry, EligibilityResponse } from '../../shared/types/index.js';
import { getWeekday } from '../lib/datetime.js';

export interface EligibilityContext {
  employee: Employee;
  mealDate: string; // YYYY-MM-DD in Asia/Amman timezone
  rosterEntry: RosterEntry | null;
  workingDays: number[]; // 0=Sunday, 6=Saturday
  holidays: Set<string>; // Set of YYYY-MM-DD strings
}

/**
 * Determine eligibility for an employee on a given date
 */
export function computeEligibility(context: EligibilityContext): EligibilityResponse {
  const { employee, mealDate, rosterEntry, workingDays, holidays } = context;
  
  // 1. Check active status first
  if (!employee.is_active) {
    return {
      eligible: false,
      reason: 'EMPLOYEE_INACTIVE',
      rosterType: employee.roster_type,
      nextEligibleDate: null,
    };
  }
  
  // 2. Amman HQ never eligible
  if (employee.roster_type === 'amman_hq') {
    return {
      eligible: false,
      reason: 'AMMAN_HQ_NO_MEAL',
      rosterType: employee.roster_type,
      nextEligibleDate: null,
    };
  }
  
  // 3. Holidays apply to everyone
  if (holidays.has(mealDate)) {
    return {
      eligible: false,
      reason: 'HOLIDAY',
      rosterType: employee.roster_type,
      nextEligibleDate: null, // resolved from real data by the service layer
    };
  }
  
  // 4. Regular employees: check against working days
  if (employee.roster_type === 'regular') {
    const weekday = getWeekday(mealDate);
    if (workingDays.includes(weekday)) {
      return {
        eligible: true,
        reason: 'REGULAR_WORKING_DAY',
        rosterType: employee.roster_type,
        nextEligibleDate: null,
      };
    } else {
      return {
        eligible: false,
        reason: 'REGULAR_NON_WORKING_DAY',
        rosterType: employee.roster_type,
        nextEligibleDate: null, // resolved from real data by the service layer
      };
    }
  }
  
  // 5. Shift employees: check roster entry
  if (employee.roster_type === 'shift') {
    if (!rosterEntry) {
      return {
        eligible: false,
        reason: 'ROSTER_MISSING',
        rosterType: employee.roster_type,
        dailyStatus: null,
        nextEligibleDate: null,
      };
    }
    
    if (rosterEntry.shift_value === 'day') {
      return {
        eligible: true,
        reason: 'SHIFT_DAY',
        rosterType: employee.roster_type,
        dailyStatus: rosterEntry.shift_value,
        nextEligibleDate: null,
      };
    }
    
    if (rosterEntry.shift_value === 'night') {
      return {
        eligible: true,
        reason: 'SHIFT_NIGHT',
        rosterType: employee.roster_type,
        dailyStatus: rosterEntry.shift_value,
        nextEligibleDate: null,
      };
    }
    
    if (rosterEntry.shift_value === 'off') {
      return {
        eligible: false,
        reason: 'SHIFT_OFF',
        rosterType: employee.roster_type,
        dailyStatus: rosterEntry.shift_value,
        nextEligibleDate: null,
      };
    }
  }
  
  throw new Error(`Unhandled eligibility case for roster_type: ${employee.roster_type}`);
}
