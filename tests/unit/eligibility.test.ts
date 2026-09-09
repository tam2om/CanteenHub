/**
 * Unit Tests - Eligibility Engine
 * Tests the pure eligibility calculation logic
 */

import { describe, it, expect } from 'vitest';
import { computeEligibility, type EligibilityContext } from '../../src/worker/domain/eligibility.js';
import type { Employee, RosterEntry } from '../../src/shared/types/index.js';

// Test fixtures
const createEmployee = (overrides: Partial<Employee>): Employee => ({
  id: 1,
  amco_id: 'EMP001',
  full_name: 'Test Employee',
  department: 'IT',
  section: 'Development',
  roster_type: 'regular',
  is_active: true,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...overrides
});

const workingDays = [0, 1, 2, 3, 4]; // Sunday to Thursday
const holidays = new Set<string>();

describe('Eligibility Engine', () => {
  describe('Regular Employees', () => {
    const employee = createEmployee({ roster_type: 'regular' });
    
    it('Sunday is eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-06', // Sunday
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBe('REGULAR_WORKING_DAY');
    });
    
    it('Monday is eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-07', // Monday
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBe('REGULAR_WORKING_DAY');
    });
    
    it('Tuesday is eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-08', // Tuesday
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(true);
    });
    
    it('Wednesday is eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-09', // Wednesday
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(true);
    });
    
    it('Thursday is eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-10', // Thursday
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(true);
    });
    
    it('Friday is not eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-11', // Friday
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('REGULAR_NON_WORKING_DAY');
    });
    
    it('Saturday is not eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-12', // Saturday
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('REGULAR_NON_WORKING_DAY');
    });
    
    it('Holiday is not eligible', () => {
      const holidaySet = new Set(['2026-09-07']); // Monday is a holiday
      
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-07',
        rosterEntry: null,
        workingDays,
        holidays: holidaySet
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('HOLIDAY');
    });
  });
  
  describe('Shift Employees', () => {
    const employee = createEmployee({ roster_type: 'shift' });
    
    it('Day shift is eligible', () => {
      const rosterEntry: RosterEntry = {
        id: 1,
        employee_id: 1,
        work_date: '2026-09-09',
        shift_value: 'day',
        source: 'manual',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };
      
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-09',
        rosterEntry,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBe('SHIFT_DAY');
      expect(result.dailyStatus).toBe('day');
    });
    
    it('Night shift is eligible', () => {
      const rosterEntry: RosterEntry = {
        id: 1,
        employee_id: 1,
        work_date: '2026-09-09',
        shift_value: 'night',
        source: 'manual',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };
      
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-09',
        rosterEntry,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBe('SHIFT_NIGHT');
    });
    
    it('Off shift is not eligible', () => {
      const rosterEntry: RosterEntry = {
        id: 1,
        employee_id: 1,
        work_date: '2026-09-09',
        shift_value: 'off',
        source: 'manual',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z'
      };
      
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-09',
        rosterEntry,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('SHIFT_OFF');
    });
    
    it('Missing roster is not eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-09',
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('ROSTER_MISSING');
    });
  });
  
  describe('Amman HQ Employees', () => {
    const employee = createEmployee({ roster_type: 'amman_hq' });
    
    it('Sunday is not eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-06',
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('AMMAN_HQ_NO_MEAL');
    });
    
    it('Wednesday is not eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-09',
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('AMMAN_HQ_NO_MEAL');
    });
    
    it('Saturday is not eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-12',
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('AMMAN_HQ_NO_MEAL');
    });
  });
  
  describe('Inactive Employees', () => {
    const employee = createEmployee({ is_active: false, roster_type: 'regular' });
    
    it('Any date is not eligible', () => {
      const context: EligibilityContext = {
        employee,
        mealDate: '2026-09-07', // Monday (normally eligible)
        rosterEntry: null,
        workingDays,
        holidays
      };
      
      const result = computeEligibility(context);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('EMPLOYEE_INACTIVE');
    });
  });
});
