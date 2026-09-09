// @vitest-environment node
/**
 * Integration Tests - next eligible meal date
 *
 * The previous implementation scanned forward day by day and gave up after 365
 * iterations. These tests prove the replacement is bounded by DATA, not by a
 * magic number: an eligible date roughly two years out is found when the
 * underlying menu/roster rows exist, and `null` is returned when they do not.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { seedEmployee, seedMenuDay, seedRosterEntry, setSetting } from '../helpers/fixtures.js';
import { findNextEligibleMealDate } from '../../src/worker/services/eligibility.service.js';
import { getEmployeeById } from '../../src/worker/db/employees.js';
import type { Employee } from '../../src/shared/types/index.js';

const WORKING_DAYS = [0, 1, 2, 3, 4]; // Sunday-Thursday
const NO_HOLIDAYS = new Set<string>();

const FROM = '2026-09-09'; // Wednesday

// Deliberately beyond the removed 365-day horizon.
const BEYOND_HORIZON_SUNDAY = '2028-09-03'; // Sunday, ~725 days after FROM
const BEYOND_HORIZON_FRIDAY = '2028-09-01'; // Friday, not a working day

describe('findNextEligibleMealDate', () => {
  let db: TestD1Database;

  beforeEach(async () => {
    db = createTestDb();
    await setSetting(db, 'timezone', '"Asia/Amman"');
  });

  const load = async (id: number): Promise<Employee> => {
    const employee = await getEmployeeById(db, id);
    if (!employee) throw new Error('fixture employee not found');
    return employee;
  };

  describe('Regular employees', () => {
    it('finds an eligible date FAR beyond the old 365-day horizon', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
      // The ONLY published menu is ~2 years out. The old implementation returned
      // null here because it stopped searching after 365 days.
      await seedMenuDay(db, BEYOND_HORIZON_SUNDAY, 'published');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe(BEYOND_HORIZON_SUNDAY);
    });

    it('skips non-working days even far in the future', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
      await seedMenuDay(db, BEYOND_HORIZON_FRIDAY, 'published'); // Friday - skipped
      await seedMenuDay(db, BEYOND_HORIZON_SUNDAY, 'published'); // Sunday - chosen

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe(BEYOND_HORIZON_SUNDAY);
    });

    it('returns the EARLIEST qualifying published menu date', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
      await seedMenuDay(db, '2026-09-10', 'published'); // Thursday
      await seedMenuDay(db, '2026-09-13', 'published'); // Sunday
      await seedMenuDay(db, BEYOND_HORIZON_SUNDAY, 'published');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe('2026-09-10');
    });

    it('ignores DRAFT menus - only published data establishes a meal', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
      await seedMenuDay(db, '2026-09-10', 'draft');
      await seedMenuDay(db, '2026-09-13', 'published');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe('2026-09-13');
    });

    it('excludes the from-date itself (strictly future)', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
      await seedMenuDay(db, FROM, 'published');
      await seedMenuDay(db, '2026-09-10', 'published');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe('2026-09-10');
    });

    it('skips holidays', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
      await seedMenuDay(db, '2026-09-10', 'published');
      await seedMenuDay(db, '2026-09-13', 'published');

      const result = await findNextEligibleMealDate(
        db, await load(id), FROM, WORKING_DAYS, new Set(['2026-09-10'])
      );

      expect(result).toBe('2026-09-13');
    });

    it('returns null when NO future menu is published - it does not invent a date', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBeNull();
    });

    it('returns null when every published menu falls on a non-working day', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
      await seedMenuDay(db, '2026-09-11', 'published'); // Friday
      await seedMenuDay(db, '2026-09-12', 'published'); // Saturday

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBeNull();
    });
  });

  describe('Shift employees', () => {
    it('finds a rostered shift FAR beyond the old 365-day horizon', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
      await seedMenuDay(db, BEYOND_HORIZON_SUNDAY, 'published');
      await seedRosterEntry(db, id, BEYOND_HORIZON_SUNDAY, 'day');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe(BEYOND_HORIZON_SUNDAY);
    });

    it('counts a NIGHT shift as eligible', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
      await seedMenuDay(db, '2026-09-12', 'published');
      await seedRosterEntry(db, id, '2026-09-12', 'night');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe('2026-09-12');
    });

    it('is NOT bound by working_days - a Friday Day shift still qualifies', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
      await seedMenuDay(db, '2026-09-11', 'published'); // Friday
      await seedRosterEntry(db, id, '2026-09-11', 'day');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe('2026-09-11');
    });

    it('skips OFF days and returns the next working shift', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
      await seedMenuDay(db, '2026-09-10', 'published');
      await seedMenuDay(db, '2026-09-11', 'published');
      await seedRosterEntry(db, id, '2026-09-10', 'off');
      await seedRosterEntry(db, id, '2026-09-11', 'day');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe('2026-09-11');
    });

    it('requires BOTH a rostered shift and a published menu', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
      // Rostered on the 10th but no menu; menu on the 13th but no shift.
      await seedRosterEntry(db, id, '2026-09-10', 'day');
      await seedMenuDay(db, '2026-09-13', 'published');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBeNull();
    });

    it('returns null when the roster has not been published yet', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
      await seedMenuDay(db, '2026-09-10', 'published');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBeNull();
    });

    it('ignores soft-deleted roster entries', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
      await seedMenuDay(db, '2026-09-10', 'published');
      await seedMenuDay(db, '2026-09-13', 'published');
      await seedRosterEntry(db, id, '2026-09-10', 'day');
      await seedRosterEntry(db, id, '2026-09-13', 'day');
      await db
        .prepare("UPDATE roster_entries SET deleted_at = datetime('now') WHERE employee_id = ? AND work_date = ?")
        .bind(id, '2026-09-10')
        .run();

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBe('2026-09-13');
    });
  });

  describe('employees who are never eligible', () => {
    it('Amman HQ returns null even with abundant published menus', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST020', rosterType: 'amman_hq' });
      await seedMenuDay(db, '2026-09-10', 'published');
      await seedMenuDay(db, '2026-09-13', 'published');
      await seedMenuDay(db, BEYOND_HORIZON_SUNDAY, 'published');

      const result = await findNextEligibleMealDate(db, await load(id), FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBeNull();
    });

    it('an inactive employee returns null', async () => {
      const { id } = await seedEmployee(db, { amcoId: 'TEST002', rosterType: 'regular', isActive: false });
      await seedMenuDay(db, '2026-09-10', 'published');

      const employee = { ...(await load(id)), is_active: false } as Employee;
      const result = await findNextEligibleMealDate(db, employee, FROM, WORKING_DAYS, NO_HOLIDAYS);

      expect(result).toBeNull();
    });
  });
});
