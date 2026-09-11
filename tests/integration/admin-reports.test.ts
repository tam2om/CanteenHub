// @vitest-environment node
/**
 * Integration Tests - admin lunch reporting.
 *
 * Real Hono routes, real SQL against the real migrations. Every employee and
 * dish here is invented.
 *
 * 2027-03-01 is a Monday and 2027-03-05/06 are Friday/Saturday, which matters
 * for the regular-employee working-day cases.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  seedMenuDay,
  countRows,
  readJson,
  ROLE_ADMIN,
  ROLE_SUPER_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const REPORT = `${BASE}/api/admin/reports/lunch`;

const MONDAY = '2027-03-01';
const FRIDAY = '2027-03-05';
const SATURDAY = '2027-03-06';

describe('Admin lunch report', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let superAdmin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN, rosterType: 'amman_hq' });
    superAdmin = await seedEmployee(db, { amcoId: 'TEST901', roleId: ROLE_SUPER_ADMIN, rosterType: 'amman_hq' });
    employee = await seedEmployee(db, { amcoId: 'TEST100', rosterType: 'regular' });
  });

  const report = async (query = `?date=${MONDAY}`, cookie = admin.cookie) => {
    const res = await app.request(`${REPORT}${query}`, cookie ? { headers: { Cookie: cookie } } : {}, env);
    return { res, body: res.status === 200 ? (await readJson(res)).data : await readJson(res) };
  };

  const publishMenu = async (date: string) => {
    const id = await seedMenuDay(db, date, 'published');
    await db.prepare("INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?,1,'Test Alpha')").bind(id).run();
    await db.prepare("INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?,2,'Test Beta')").bind(id).run();
    return id;
  };

  const select = (employeeId: number, date: string, choice: string) =>
    db.prepare(
      `INSERT INTO lunch_selections (employee_id, meal_date, choice, source) VALUES (?, ?, ?, 'employee')`
    ).bind(employeeId, date, choice).run();

  const roster = (employeeId: number, date: string, shift: string) =>
    db.prepare(
      `INSERT INTO roster_entries (employee_id, work_date, shift_value, source) VALUES (?, ?, ?, 'import')`
    ).bind(employeeId, date, shift).run();

  const reasonCount = (body: { not_eligible: { by_reason: Array<{ reason: string; count: number }> } }, reason: string) =>
    body.not_eligible.by_reason.find((r) => r.reason === reason)?.count ?? 0;

  // ==========================================================================
  // AUTHORIZATION
  // ==========================================================================

  describe('authorization', () => {
    it('an admin can retrieve a report', async () => {
      const { res } = await report();
      expect(res.status).toBe(200);
    });

    it('a super_admin can retrieve a report', async () => {
      expect((await report(`?date=${MONDAY}`, superAdmin.cookie)).res.status).toBe(200);
    });

    it('an employee is FORBIDDEN', async () => {
      expect((await report(`?date=${MONDAY}`, employee.cookie)).res.status).toBe(403);
    });

    it('an unauthenticated caller is rejected', async () => {
      expect((await report(`?date=${MONDAY}`, '')).res.status).toBe(401);
    });

    it('an employee cannot reach it by supplying another employee id', async () => {
      // There is no employee-id parameter at all: the report is date-scoped.
      const res = await app.request(
        `${REPORT}?date=${MONDAY}&employee_id=${admin.id}`,
        { headers: { Cookie: employee.cookie } },
        env
      );
      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // DATE VALIDATION
  // ==========================================================================

  describe('date handling', () => {
    it('rejects malformed dates', async () => {
      for (const date of ['2027-02-30', '2027-13-01', 'yesterday', '01-03-2027', '2027-3-1', "2027-03-01'"]) {
        const { res } = await report(`?date=${encodeURIComponent(date)}`);
        expect(res.status).toBe(400);
      }
    });

    it('a SQL-shaped date cannot alter the query', async () => {
      const { res } = await report(`?date=${encodeURIComponent("2027-03-01' OR '1'='1")}`);
      expect(res.status).toBe(400);
      // The employees table is untouched and still queryable.
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM employees')).toBe(3);
    });

    it('defaults to the SERVER business date when none is given', async () => {
      const { body } = await report('');
      expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // And reports the timezone it resolved that date in.
      expect(body.timezone).toBe('Asia/Amman');
    });

    it('reports the configured timezone, not a browser or UTC assumption', async () => {
      await db.prepare("UPDATE settings SET value = '\"Europe/London\"' WHERE key = 'timezone'").run();
      const { body } = await report('');
      expect(body.timezone).toBe('Europe/London');
    });

    it('works for any date in the database, with no horizon', async () => {
      for (const date of ['2020-01-01', '2035-12-31']) {
        const { res, body } = await report(`?date=${date}`);
        expect(res.status).toBe(200);
        expect(body.date).toBe(date);
      }
    });
  });

  // ==========================================================================
  // MENU
  // ==========================================================================

  describe('published menu requirement', () => {
    it('reports a published menu as published', async () => {
      await publishMenu(MONDAY);
      const { body } = await report();
      expect(body.menu).toEqual({ exists: true, published: true, status: 'published' });
    });

    it('a DRAFT menu is not treated as published', async () => {
      await seedMenuDay(db, MONDAY, 'draft');
      const { body } = await report();
      expect(body.menu).toEqual({ exists: true, published: false, status: 'draft' });
    });

    it('an ARCHIVED menu is not treated as published', async () => {
      await seedMenuDay(db, MONDAY, 'archived');
      const { body } = await report();
      expect(body.menu).toEqual({ exists: true, published: false, status: 'archived' });
    });

    it('no menu at all is reported plainly, with counts NOT fabricated', async () => {
      const { body } = await report();
      expect(body.menu).toEqual({ exists: false, published: false, status: null });
      // Eligibility is still real; only the menu is absent.
      expect(body.totals.employees_considered).toBe(3);
      expect(body.selections.option_1).toBe(0);
    });
  });

  // ==========================================================================
  // SELECTION COUNTS
  // ==========================================================================

  describe('selection counts', () => {
    beforeEach(async () => {
      await publishMenu(MONDAY);
    });

    it('counts option 1, option 2 and no preference separately', async () => {
      const a = await seedEmployee(db, { amcoId: 'TEST101', rosterType: 'regular' });
      const b = await seedEmployee(db, { amcoId: 'TEST102', rosterType: 'regular' });
      const c = await seedEmployee(db, { amcoId: 'TEST103', rosterType: 'regular' });

      await select(a.id, MONDAY, 'option_1');
      await select(b.id, MONDAY, 'option_2');
      await select(c.id, MONDAY, 'no_preference');

      const { body } = await report();
      expect(body.selections).toMatchObject({
        option_1: 1,
        option_2: 1,
        no_preference: 1,
      });
    });

    it('counts an eligible employee with NO selection separately', async () => {
      await seedEmployee(db, { amcoId: 'TEST101', rosterType: 'regular' });
      await select(employee.id, MONDAY, 'option_1');

      const { body } = await report();
      // employee selected; TEST101 did not; the two admins are Amman HQ.
      expect(body.selections.option_1).toBe(1);
      expect(body.selections.eligible_not_selected).toBe(1);
      expect(body.totals.eligible).toBe(2);
    });

    it('does NOT count ineligible employees as eligible-but-not-selected', async () => {
      await seedEmployee(db, { amcoId: 'TEST200', rosterType: 'amman_hq' });
      await seedEmployee(db, { amcoId: 'TEST201', rosterType: 'shift' }); // no roster
      await seedEmployee(db, { amcoId: 'TEST202', isActive: false });

      const { body } = await report();
      // Only `employee` (regular, Monday) is eligible and unselected.
      expect(body.totals.eligible).toBe(1);
      expect(body.selections.eligible_not_selected).toBe(1);
      expect(body.totals.not_eligible).toBe(5);
    });

    it('surfaces a selection held by a NOW-ineligible employee without counting it as a portion', async () => {
      const shiftWorker = await seedEmployee(db, { amcoId: 'TEST300', rosterType: 'shift' });
      await select(shiftWorker.id, MONDAY, 'option_1');
      await roster(shiftWorker.id, MONDAY, 'off'); // roster changed after ordering

      const { body } = await report();
      expect(body.selections.option_1).toBe(0);
      expect(body.selections.ineligible_with_selection).toBe(1);
      expect(body.selections.eligible_not_selected).toBe(1); // `employee` only
      expect(reasonCount(body, 'SHIFT_OFF')).toBe(1);
    });

    it('totals add up: eligible = selections + not selected', async () => {
      for (const id of ['TEST101', 'TEST102', 'TEST103', 'TEST104']) {
        await seedEmployee(db, { amcoId: id, rosterType: 'regular' });
      }
      const rows = await db.prepare("SELECT id FROM employees WHERE amco_id IN ('TEST101','TEST102')").all<{ id: number }>();
      await select(rows.results![0].id, MONDAY, 'option_1');
      await select(rows.results![1].id, MONDAY, 'no_preference');

      const { body } = await report();
      const s = body.selections;
      expect(s.option_1 + s.option_2 + s.no_preference + s.eligible_not_selected).toBe(body.totals.eligible);
      expect(body.totals.eligible + body.totals.not_eligible).toBe(body.totals.employees_considered);
    });
  });

  // ==========================================================================
  // ELIGIBILITY REASONS - delegated to the existing engine
  // ==========================================================================

  describe('not-eligible reasons', () => {
    it('an INACTIVE employee reports EMPLOYEE_INACTIVE', async () => {
      await seedEmployee(db, { amcoId: 'TEST200', isActive: false });
      const { body } = await report();
      expect(reasonCount(body, 'EMPLOYEE_INACTIVE')).toBe(1);
    });

    it('an AMMAN HQ employee reports AMMAN_HQ_NO_MEAL', async () => {
      const { body } = await report();
      // The two seeded admins are Amman HQ.
      expect(reasonCount(body, 'AMMAN_HQ_NO_MEAL')).toBe(2);
    });

    it('a HOLIDAY reports HOLIDAY for everyone otherwise eligible', async () => {
      await db.prepare("INSERT INTO holidays (holiday_date, name) VALUES (?, 'Test Holiday')").bind(MONDAY).run();
      const shiftWorker = await seedEmployee(db, { amcoId: 'TEST300', rosterType: 'shift' });
      await roster(shiftWorker.id, MONDAY, 'day');

      const { body } = await report();
      expect(body.totals.eligible).toBe(0);
      // Regular + shift both fall to HOLIDAY; Amman HQ is refused earlier.
      expect(reasonCount(body, 'HOLIDAY')).toBe(2);
      expect(reasonCount(body, 'AMMAN_HQ_NO_MEAL')).toBe(2);
    });

    it('a regular employee is eligible on a working day', async () => {
      const { body } = await report(`?date=${MONDAY}`);
      expect(body.totals.eligible).toBe(1);
      expect(body.eligibility.by_reason.find((r: { reason: string }) => r.reason === 'REGULAR_WORKING_DAY').count).toBe(1);
    });

    it('a regular employee is NOT eligible on Friday or Saturday', async () => {
      for (const date of [FRIDAY, SATURDAY]) {
        const { body } = await report(`?date=${date}`);
        expect(body.totals.eligible).toBe(0);
        expect(reasonCount(body, 'REGULAR_NON_WORKING_DAY')).toBe(1);
      }
    });

    it('a SHIFT employee reports SHIFT_DAY, SHIFT_NIGHT or SHIFT_OFF from the roster', async () => {
      const day = await seedEmployee(db, { amcoId: 'TEST301', rosterType: 'shift' });
      const night = await seedEmployee(db, { amcoId: 'TEST302', rosterType: 'shift' });
      const off = await seedEmployee(db, { amcoId: 'TEST303', rosterType: 'shift' });
      await roster(day.id, MONDAY, 'day');
      await roster(night.id, MONDAY, 'night');
      await roster(off.id, MONDAY, 'off');

      const { body } = await report();
      const eligibleReason = (r: string) =>
        body.eligibility.by_reason.find((x: { reason: string }) => x.reason === r)?.count ?? 0;

      expect(eligibleReason('SHIFT_DAY')).toBe(1);
      expect(eligibleReason('SHIFT_NIGHT')).toBe(1);
      expect(reasonCount(body, 'SHIFT_OFF')).toBe(1);
      // day + night + the regular employee.
      expect(body.totals.eligible).toBe(3);
    });

    it('a shift employee with NO roster entry reports ROSTER_MISSING', async () => {
      await seedEmployee(db, { amcoId: 'TEST300', rosterType: 'shift' });
      const { body } = await report();
      expect(reasonCount(body, 'ROSTER_MISSING')).toBe(1);
    });

    it('a roster entry for a DIFFERENT date does not satisfy this one', async () => {
      const shiftWorker = await seedEmployee(db, { amcoId: 'TEST300', rosterType: 'shift' });
      await roster(shiftWorker.id, '2027-03-02', 'day');

      const { body } = await report(`?date=${MONDAY}`);
      expect(reasonCount(body, 'ROSTER_MISSING')).toBe(1);
    });

    it('a SOFT-DELETED roster entry reads as missing', async () => {
      const shiftWorker = await seedEmployee(db, { amcoId: 'TEST300', rosterType: 'shift' });
      await roster(shiftWorker.id, MONDAY, 'day');
      await db.prepare("UPDATE roster_entries SET deleted_at = datetime('now') WHERE employee_id = ?").bind(shiftWorker.id).run();

      const { body } = await report();
      expect(reasonCount(body, 'ROSTER_MISSING')).toBe(1);
    });

    it('every reported reason carries a human-readable label', async () => {
      await seedEmployee(db, { amcoId: 'TEST200', isActive: false });
      await seedEmployee(db, { amcoId: 'TEST300', rosterType: 'shift' });

      const { body } = await report();
      for (const entry of [...body.eligibility.by_reason, ...body.not_eligible.by_reason]) {
        expect(typeof entry.label).toBe('string');
        expect(entry.label.length).toBeGreaterThan(0);
        // Admin-facing wording, not the employee-facing "You are...".
        expect(entry.label).not.toMatch(/^You /);
      }
    });

    it('reason codes match the existing engine exactly - none invented', async () => {
      const known = [
        'REGULAR_WORKING_DAY', 'SHIFT_DAY', 'SHIFT_NIGHT',
        'EMPLOYEE_INACTIVE', 'AMMAN_HQ_NO_MEAL', 'HOLIDAY',
        'REGULAR_NON_WORKING_DAY', 'SHIFT_OFF', 'ROSTER_MISSING',
      ];
      await seedEmployee(db, { amcoId: 'TEST200', isActive: false });
      await seedEmployee(db, { amcoId: 'TEST300', rosterType: 'shift' });

      const { body } = await report();
      for (const entry of body.eligibility.by_reason) expect(known).toContain(entry.reason);
    });
  });

  // ==========================================================================
  // SECURITY AND PERFORMANCE
  // ==========================================================================

  describe('security', () => {
    it('returns NO password hash, session or IP data', async () => {
      await setEmployeePasswordDirect(db, employee.id, 'original-password-here');
      await publishMenu(MONDAY);
      await select(employee.id, MONDAY, 'option_1');

      const { body } = await report();
      const raw = JSON.stringify(body);

      expect(raw).not.toContain('password');
      expect(raw).not.toContain('pbkdf2');
      expect(raw).not.toContain('session');
      expect(raw).not.toContain('ip_address');
      expect(raw).not.toContain('token');
    });

    it('exposes no employee-level PII in the summary', async () => {
      const { body } = await report();
      const raw = JSON.stringify(body);

      // Counts only: no names, no AMCO IDs.
      expect(raw).not.toContain('TEST100');
      expect(raw).not.toContain('TEST900');
      expect(raw).not.toContain('amco_id');
      expect(raw).not.toContain('full_name');
    });
  });

  describe('performance and purity', () => {
    it('uses a fixed number of queries regardless of headcount', async () => {
      await publishMenu(MONDAY);
      for (let i = 0; i < 30; i += 1) {
        await seedEmployee(db, { amcoId: `TEST4${String(i).padStart(2, '0')}`, rosterType: 'regular' });
      }

      db.executedReads.length = 0;
      const { body } = await report();

      expect(body.totals.employees_considered).toBe(33);
      // Well under one query per employee - and under D1's 50/invocation cap.
      expect(db.executedReads.length).toBeLessThan(15);
    });

    it('writes NOTHING - the report is derived, not snapshotted', async () => {
      await publishMenu(MONDAY);
      await select(employee.id, MONDAY, 'option_1');

      db.executedWrites.length = 0;
      await report();

      expect(db.executedWrites).toEqual([]);
    });

    it('leaves selections and history byte-identical', async () => {
      await publishMenu(MONDAY);
      await select(employee.id, MONDAY, 'option_1');
      await db.prepare(
        `INSERT INTO lunch_selection_history (employee_id, meal_date, new_choice, source) VALUES (?, ?, 'option_1', 'employee')`
      ).bind(employee.id, MONDAY).run();

      const before = await db.prepare('SELECT * FROM lunch_selections WHERE employee_id = ?').bind(employee.id).first<Record<string, unknown>>();
      const historyBefore = await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history');

      await report();
      await report();

      expect(await db.prepare('SELECT * FROM lunch_selections WHERE employee_id = ?').bind(employee.id).first<Record<string, unknown>>())
        .toEqual(before);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history')).toBe(historyBefore);
    });

    it('creates no audit noise', async () => {
      await report();
      await report();
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(0);
    });

    it('is deterministic: the same date reports the same numbers', async () => {
      await publishMenu(MONDAY);
      await select(employee.id, MONDAY, 'option_2');

      const first = (await report()).body;
      const second = (await report()).body;
      expect(second).toEqual(first);
    });
  });
});
