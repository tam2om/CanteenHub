// @vitest-environment node
/**
 * Integration Tests - Company holidays
 *
 * Holidays must actually feed the existing eligibility service: a regular
 * employee becomes ineligible with reason HOLIDAY, and eligibility returns to
 * normal once the holiday is removed. The eligibility RULES are unchanged - this
 * only supplies data the rules already understood.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  seedMenuDay,
  seedRosterEntry,
  jsonRequest,
  readJson,
  countRows,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';
import { getEligibilityWithNextDate } from '../../src/worker/services/eligibility.service.js';
import { getEmployeeById } from '../../src/worker/db/employees.js';

const BASE = 'http://localhost';
const HOLIDAY_DATE = '2027-03-07'; // Sunday - normally a working day
const NEXT_WORKING_DAY = '2027-03-08'; // Monday

describe('Admin holidays', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;
  let shiftWorker: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
    shiftWorker = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
    await seedMenuDay(db, HOLIDAY_DATE, 'published');
  });

  const addHoliday = (date: unknown, name: unknown, cookie: string) =>
    app.request(`${BASE}/api/admin/holidays`, jsonRequest({ holiday_date: date, name }, cookie), env);

  const removeHoliday = (date: string, cookie: string) =>
    app.request(`${BASE}/api/admin/holidays/${date}`, { method: 'DELETE', headers: { Cookie: cookie } }, env);

  const eligibilityFor = async (seeded: SeededEmployee, date: string) => {
    const record = await getEmployeeById(db, seeded.id);
    return getEligibilityWithNextDate(db, record!, date);
  };

  describe('18 & 19. creating a holiday', () => {
    it('admin creates a holiday', async () => {
      const res = await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.success).toBe(true);
      expect(body.data.holiday_date).toBe(HOLIDAY_DATE);
      expect(body.data.name).toBe('Independence Day');
    });

    it('the holiday is actually stored', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const row = await db
        .prepare('SELECT * FROM holidays WHERE holiday_date = ?')
        .bind(HOLIDAY_DATE)
        .first<{ name: string; created_by: number }>();

      expect(row).not.toBeNull();
      expect(row!.name).toBe('Independence Day');
      expect(row!.created_by).toBe(admin.id);
    });

    it('admin can list holidays', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);
      await addHoliday('2027-05-01', 'Labour Day', admin.cookie);

      const res = await app.request(`${BASE}/api/admin/holidays`, { headers: { Cookie: admin.cookie } }, env);

      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].holiday_date).toBe(HOLIDAY_DATE); // ascending
    });

    it('re-posting the same date renames rather than duplicating', async () => {
      await addHoliday(HOLIDAY_DATE, 'Original Name', admin.cookie);
      const res = await addHoliday(HOLIDAY_DATE, 'Corrected Name', admin.cookie);

      expect(res.status).toBe(200);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM holidays')).toBe(1);
      expect((await readJson(res)).data.name).toBe('Corrected Name');
    });

    it('validates the date and the name', async () => {
      expect((await addHoliday('07-03-2027', 'Bad Format', admin.cookie)).status).toBe(400);
      expect((await addHoliday('2027-02-30', 'Impossible Date', admin.cookie)).status).toBe(400);
      expect((await addHoliday(HOLIDAY_DATE, '', admin.cookie)).status).toBe(400);
      expect((await addHoliday(HOLIDAY_DATE, '   ', admin.cookie)).status).toBe(400);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM holidays')).toBe(0);
    });
  });

  describe('20 & 21. holidays drive eligibility', () => {
    it('a regular employee is eligible before the holiday exists', async () => {
      const result = await eligibilityFor(employee, HOLIDAY_DATE);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBe('REGULAR_WORKING_DAY');
    });

    it('a regular employee becomes ineligible on a configured holiday', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const result = await eligibilityFor(employee, HOLIDAY_DATE);
      expect(result.eligible).toBe(false);
    });

    it('the eligibility reason is exactly HOLIDAY', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const result = await eligibilityFor(employee, HOLIDAY_DATE);
      expect(result.reason).toBe('HOLIDAY');
    });

    it('the selection API refuses a selection on a holiday, with the HOLIDAY reason', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const res = await app.request(
        `${BASE}/api/selections/me`,
        jsonRequest({ meal_date: HOLIDAY_DATE, choice: 'option_1' }, employee.cookie),
        env
      );

      expect(res.status).toBe(403);
      expect((await readJson(res)).error).toContain('HOLIDAY');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(0);
    });

    it('a holiday takes precedence over a rostered shift', async () => {
      await seedRosterEntry(db, shiftWorker.id, HOLIDAY_DATE, 'day');
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const result = await eligibilityFor(shiftWorker, HOLIDAY_DATE);
      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('HOLIDAY');
    });

    it('a holiday is skipped when computing the next eligible date', async () => {
      await seedMenuDay(db, NEXT_WORKING_DAY, 'published');
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      // Asking from the Friday before: the Sunday is now a holiday, so the next
      // eligible date is the Monday.
      const result = await eligibilityFor(employee, '2027-03-05');
      expect(result.eligible).toBe(false);
      expect(result.nextEligibleDate).toBe(NEXT_WORKING_DAY);
    });

    it('only the configured date is affected', async () => {
      await seedMenuDay(db, NEXT_WORKING_DAY, 'published');
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const nextDay = await eligibilityFor(employee, NEXT_WORKING_DAY);
      expect(nextDay.eligible).toBe(true);
    });

    it('an Amman HQ employee still reports AMMAN_HQ_NO_MEAL, not HOLIDAY', async () => {
      // Established rule ordering is unchanged: roster type is decided before
      // the calendar, so the reason an employee sees stays stable and true.
      const ammanHq = await seedEmployee(db, { amcoId: 'TEST020', rosterType: 'amman_hq' });
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const result = await eligibilityFor(ammanHq, HOLIDAY_DATE);
      expect(result.reason).toBe('AMMAN_HQ_NO_MEAL');
    });
  });

  describe('22 & 23. removing a holiday', () => {
    it('admin deletes a holiday', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const res = await removeHoliday(HOLIDAY_DATE, admin.cookie);

      expect(res.status).toBe(200);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM holidays')).toBe(0);
    });

    it('eligibility returns to normal after deletion', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);
      expect((await eligibilityFor(employee, HOLIDAY_DATE)).reason).toBe('HOLIDAY');

      await removeHoliday(HOLIDAY_DATE, admin.cookie);

      const result = await eligibilityFor(employee, HOLIDAY_DATE);
      expect(result.eligible).toBe(true);
      expect(result.reason).toBe('REGULAR_WORKING_DAY');
    });

    it('the employee can select again once the holiday is removed', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);
      await removeHoliday(HOLIDAY_DATE, admin.cookie);

      const res = await app.request(
        `${BASE}/api/selections/me`,
        jsonRequest({ meal_date: HOLIDAY_DATE, choice: 'option_1' }, employee.cookie),
        env
      );
      expect(res.status).toBe(201);
    });

    it('deleting an unknown holiday returns 404', async () => {
      expect((await removeHoliday('2027-12-25', admin.cookie)).status).toBe(404);
    });

    it('rejects a malformed date on delete', async () => {
      expect((await removeHoliday('25-12-2027', admin.cookie)).status).toBe(400);
    });
  });

  describe('24. authorization', () => {
    it('a non-admin cannot create a holiday', async () => {
      const res = await addHoliday(HOLIDAY_DATE, 'Sneaky Day Off', employee.cookie);
      expect(res.status).toBe(403);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM holidays')).toBe(0);
    });

    it('a non-admin cannot list holidays', async () => {
      const res = await app.request(`${BASE}/api/admin/holidays`, { headers: { Cookie: employee.cookie } }, env);
      expect(res.status).toBe(403);
    });

    it('a non-admin cannot delete a holiday', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const res = await removeHoliday(HOLIDAY_DATE, employee.cookie);
      expect(res.status).toBe(403);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM holidays')).toBe(1);
    });

    it('an unauthenticated caller cannot manage holidays', async () => {
      expect((await app.request(`${BASE}/api/admin/holidays`, {}, env)).status).toBe(401);
    });
  });

  describe('29 & 30. audit', () => {
    it('holiday creation is audited', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'CREATE_HOLIDAY'")
        .all<{ actor_id: number; before_json: string | null; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(audit.results[0].before_json).toBeNull();

      const after = JSON.parse(audit.results[0].after_json);
      expect(after.holiday_date).toBe(HOLIDAY_DATE);
      expect(after.holiday.name).toBe('Independence Day');
    });

    it('holiday deletion is audited, preserving what was removed', async () => {
      await addHoliday(HOLIDAY_DATE, 'Independence Day', admin.cookie);
      await removeHoliday(HOLIDAY_DATE, admin.cookie);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'DELETE_HOLIDAY'")
        .all<{ actor_id: number; before_json: string; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(JSON.parse(audit.results[0].before_json).name).toBe('Independence Day');
      expect(JSON.parse(audit.results[0].after_json).holiday).toBeNull();
    });

    it('renaming a holiday is audited as an UPDATE with before and after', async () => {
      await addHoliday(HOLIDAY_DATE, 'Original Name', admin.cookie);
      await addHoliday(HOLIDAY_DATE, 'Corrected Name', admin.cookie);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'UPDATE_HOLIDAY'")
        .all<{ before_json: string; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(JSON.parse(audit.results[0].before_json).name).toBe('Original Name');
      expect(JSON.parse(audit.results[0].after_json).holiday.name).toBe('Corrected Name');
    });

    it('a rejected holiday action writes no audit record', async () => {
      await addHoliday(HOLIDAY_DATE, 'Denied', employee.cookie);
      await addHoliday('bad-date', 'Denied', admin.cookie);

      expect(await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE entity_type = 'HOLIDAY'")).toBe(0);
    });
  });
});
