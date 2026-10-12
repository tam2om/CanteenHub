/**
 * Unit Tests - the Settings day-shift override in the eligibility engine
 */

import { describe, it, expect } from 'vitest';
import {
  computeEligibility,
  dayShiftOverrideState,
  isDayShiftOverrideActive,
} from '../../src/worker/domain/eligibility.js';
import type { DayShiftOverride, Employee, RosterEntry } from '../../src/shared/types/index.js';

const employee = (overrides: Partial<Employee> = {}): Employee => ({
  id: 1,
  amco_id: 'EMP001',
  full_name: 'Test Employee',
  default_location: 'amco_canteen',
  meal_preference: 'standard',
  department: 'IT',
  section: 'Development',
  roster_type: 'shift',
  is_active: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides,
});

const roster = (shift_value: RosterEntry['shift_value']): RosterEntry =>
  ({ id: 1, employee_id: 1, work_date: '2027-03-07', shift_value }) as RosterEntry;

const ON: DayShiftOverride = { enabled: true, start_date: '2027-03-01', end_date: '2027-03-10' };

const verdict = (
  mealDate: string,
  rosterEntry: RosterEntry | null,
  dayShiftOverride: DayShiftOverride | null,
  emp: Employee = employee(),
  holidays = new Set<string>()
) =>
  computeEligibility({
    employee: emp,
    mealDate,
    rosterEntry,
    workingDays: [0, 1, 2, 3, 4],
    holidays,
    dayShiftOverride,
  });

describe('day-shift override', () => {
  it('covers both the start and the end date, and nothing outside them', () => {
    expect(isDayShiftOverrideActive(ON, '2027-02-28')).toBe(false);
    expect(isDayShiftOverrideActive(ON, '2027-03-01')).toBe(true);
    expect(isDayShiftOverrideActive(ON, '2027-03-10')).toBe(true);
    expect(isDayShiftOverrideActive(ON, '2027-03-11')).toBe(false);
  });

  it('does nothing while switched off', () => {
    expect(isDayShiftOverrideActive({ ...ON, enabled: false }, '2027-03-05')).toBe(false);
    expect(verdict('2027-03-05', roster('off'), { ...ON, enabled: false }).reason).toBe('SHIFT_OFF');
  });

  it('makes a rostered-Off shift employee eligible as day shift', () => {
    const result = verdict('2027-03-05', roster('off'), ON);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe('SHIFT_DAY_OVERRIDE');
    expect(result.dailyStatus).toBe('day');
  });

  it('makes a shift employee with no roster eligible as day shift', () => {
    expect(verdict('2027-03-05', null, ON).reason).toBe('SHIFT_DAY_OVERRIDE');
  });

  it('leaves Day and Night shifts as rostered', () => {
    expect(verdict('2027-03-05', roster('day'), ON).reason).toBe('SHIFT_DAY');
    expect(verdict('2027-03-05', roster('night'), ON).reason).toBe('SHIFT_NIGHT');
  });

  it('returns everyone to their roster after the end date', () => {
    expect(verdict('2027-03-11', roster('off'), ON).reason).toBe('SHIFT_OFF');
  });

  it('does not override holidays, inactive or Amman HQ employees, or regular rosters', () => {
    expect(verdict('2027-03-07', roster('off'), ON, employee(), new Set(['2027-03-07'])).reason).toBe('HOLIDAY');
    expect(verdict('2027-03-05', roster('off'), ON, employee({ is_active: false })).reason).toBe('EMPLOYEE_INACTIVE');
    expect(verdict('2027-03-05', null, ON, employee({ roster_type: 'amman_hq' })).reason).toBe('AMMAN_HQ_NO_MEAL');
    // 2027-03-05 is a Friday.
    expect(verdict('2027-03-05', null, ON, employee({ roster_type: 'regular' })).reason).toBe('REGULAR_NON_WORKING_DAY');
  });

  it('reports its state relative to today', () => {
    expect(dayShiftOverrideState({ ...ON, enabled: false }, '2027-03-05')).toBe('off');
    expect(dayShiftOverrideState(ON, '2027-02-20')).toBe('scheduled');
    expect(dayShiftOverrideState(ON, '2027-03-10')).toBe('active');
    expect(dayShiftOverrideState(ON, '2027-03-11')).toBe('expired');
  });
});
