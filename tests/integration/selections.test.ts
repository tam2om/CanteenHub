// @vitest-environment node
/**
 * Integration Tests - Selection API
 *
 * Covers the full selection contract, including the no-op rule: re-submitting
 * the choice an employee already has must write nothing at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  seedMenuDay,
  seedRosterEntry,
  setSetting,
  countRows,
  jsonRequest,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';

// A future Sunday (a configured working day) with a published menu, so the
// cutoff is definitionally not passed and Regular employees are eligible.
const MEAL_DATE = '2027-03-07';

describe('Selection API', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let regular: SeededEmployee;
  let shiftWorker: SeededEmployee;
  let ammanHq: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    await setSetting(db, 'timezone', '"Asia/Amman"');
    await setSetting(db, 'working_days', '[0,1,2,3,4]', 'json');

    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    regular = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
    shiftWorker = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
    ammanHq = await seedEmployee(db, { amcoId: 'TEST020', rosterType: 'amman_hq' });

    await seedMenuDay(db, MEAL_DATE, 'published');
  });

  const select = (employee: SeededEmployee, choice: string, mealDate = MEAL_DATE) =>
    app.request(`${BASE}/api/selections/me`, jsonRequest({ meal_date: mealDate, choice }, employee.cookie), env);

  describe('an eligible employee can select', () => {
    it('option_1', async () => {
      const res = await select(regular, 'option_1');
      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.data.choice).toBe('option_1');
      expect(body.changed).toBe(true);
    });

    it('option_2', async () => {
      const res = await select(regular, 'option_2');
      expect(res.status).toBe(201);
      expect((await readJson(res)).data.choice).toBe('option_2');
    });

    it('no_preference', async () => {
      const res = await select(regular, 'no_preference');
      expect(res.status).toBe(201);
      expect((await readJson(res)).data.choice).toBe('no_preference');
    });

    it('a rostered Day shift employee can select', async () => {
      await seedRosterEntry(db, shiftWorker.id, MEAL_DATE, 'day');
      const res = await select(shiftWorker, 'option_1');
      expect(res.status).toBe(201);
    });

    it('a rostered Night shift employee can select', async () => {
      await seedRosterEntry(db, shiftWorker.id, MEAL_DATE, 'night');
      const res = await select(shiftWorker, 'option_2');
      expect(res.status).toBe(201);
    });
  });

  describe('first selection writes exactly one history row', () => {
    it('creates the selection and one history record', async () => {
      await select(regular, 'option_1');

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections WHERE employee_id = ?', regular.id)).toBe(1);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?', regular.id)).toBe(1);

      const history = await db
        .prepare('SELECT * FROM lunch_selection_history WHERE employee_id = ?')
        .bind(regular.id)
        .first<{ previous_choice: string | null; new_choice: string }>();

      expect(history!.previous_choice).toBeNull();
      expect(history!.new_choice).toBe('option_1');
    });
  });

  describe('changing a selection', () => {
    it('updates the row and appends a history record', async () => {
      await select(regular, 'option_1');
      const res = await select(regular, 'option_2');

      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.data.choice).toBe('option_2');
      expect(body.changed).toBe(true);

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections WHERE employee_id = ?', regular.id)).toBe(1);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?', regular.id)).toBe(2);

      const latest = await db
        .prepare('SELECT * FROM lunch_selection_history WHERE employee_id = ? ORDER BY id DESC')
        .bind(regular.id)
        .first<{ previous_choice: string; new_choice: string }>();

      expect(latest!.previous_choice).toBe('option_1');
      expect(latest!.new_choice).toBe('option_2');
    });
  });

  describe('repeating the SAME selection is a true no-op', () => {
    it('creates no additional history record', async () => {
      await select(regular, 'option_1');
      const historyBefore = await countRows(
        db, 'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?', regular.id
      );

      const res = await select(regular, 'option_1');
      expect(res.status).toBe(200);

      const historyAfter = await countRows(
        db, 'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?', regular.id
      );

      expect(historyBefore).toBe(1);
      expect(historyAfter).toBe(1);
    });

    it('reports changed:false and returns the existing selection', async () => {
      await select(regular, 'option_1');
      const res = await select(regular, 'option_1');

      const body = await readJson(res);
      expect(body.success).toBe(true);
      expect(body.changed).toBe(false);
      expect(body.data.choice).toBe('option_1');
    });

    it('issues NO write statement at all, so updated_at cannot change', async () => {
      await select(regular, 'option_1');

      const rowBefore = await db
        .prepare('SELECT * FROM lunch_selections WHERE employee_id = ?')
        .bind(regular.id)
        .first<Record<string, unknown>>();

      // Watch every write the repeat request performs. This is a stronger proof
      // than comparing `updated_at`: the schema has an AFTER UPDATE trigger that
      // rewrites that column, and second-granularity timestamps can collide, so
      // an equal timestamp would not by itself rule out an UPDATE having run.
      db.executedWrites.length = 0;

      const res = await select(regular, 'option_1');
      expect(res.status).toBe(200);

      const writes = db.executedWrites.join(' | ');
      expect(writes).not.toMatch(/UPDATE\s+lunch_selections/i);
      expect(writes).not.toMatch(/INSERT\s+INTO\s+lunch_selection_history/i);
      expect(db.executedWrites).toHaveLength(0);

      const rowAfter = await db
        .prepare('SELECT * FROM lunch_selections WHERE employee_id = ?')
        .bind(regular.id)
        .first<Record<string, unknown>>();

      // The entire row is byte-for-byte identical, updated_at included.
      expect(rowAfter).toEqual(rowBefore);
    });

    it('repeated ten times still yields exactly one history row', async () => {
      for (let i = 0; i < 10; i++) {
        await select(regular, 'no_preference');
      }
      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?', regular.id)
      ).toBe(1);
    });
  });

  describe('ineligible employees cannot select', () => {
    it('an Amman HQ employee is refused with the AMMAN_HQ reason', async () => {
      const res = await select(ammanHq, 'option_1');

      expect(res.status).toBe(403);
      const body = await readJson(res);
      expect(body.success).toBe(false);
      expect(body.error).toContain('AMMAN_HQ');

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections WHERE employee_id = ?', ammanHq.id)).toBe(0);
    });

    it('a shift employee with NO roster entry is refused with ROSTER_MISSING', async () => {
      const res = await select(shiftWorker, 'option_1');
      expect(res.status).toBe(403);
      expect((await readJson(res)).error).toContain('ROSTER_MISSING');
    });

    it('a shift employee rostered Off is refused with SHIFT_OFF', async () => {
      await seedRosterEntry(db, shiftWorker.id, MEAL_DATE, 'off');
      const res = await select(shiftWorker, 'option_1');
      expect(res.status).toBe(403);
      expect((await readJson(res)).error).toContain('SHIFT_OFF');
    });

    it('a Regular employee is refused on a Friday with REGULAR_NON_WORKING_DAY', async () => {
      await seedMenuDay(db, '2027-03-05', 'published'); // Friday
      const res = await select(regular, 'option_1', '2027-03-05');
      expect(res.status).toBe(403);
      expect((await readJson(res)).error).toContain('REGULAR_NON_WORKING_DAY');
    });

    it('an ineligible response carries a data-driven nextEligibleDate', async () => {
      // Friday is not a working day; the next published menu on a working day is
      // the Sunday. The answer comes from real menu rows, not a calendar scan.
      await seedMenuDay(db, '2027-03-05', 'published'); // Friday
      await seedMenuDay(db, '2027-03-06', 'published'); // Saturday - not a working day
      const res = await select(regular, 'option_1', '2027-03-05');

      const body = await readJson(res);
      expect(body.nextEligibleDate).toBe(MEAL_DATE); // Sunday 2027-03-07
    });
  });

  describe('unpublished menus and missing menus', () => {
    it('selection is refused when no menu exists for the date', async () => {
      const res = await select(regular, 'option_1', '2027-03-14');
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toContain('No menu');
    });

    it('selection is refused when the menu is still a draft', async () => {
      await seedMenuDay(db, '2027-03-21', 'draft');
      const res = await select(regular, 'option_1', '2027-03-21');
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toContain('not yet published');
    });
  });

  describe('authorization', () => {
    it('an unauthenticated selection attempt is rejected', async () => {
      const res = await app.request(
        `${BASE}/api/selections/me`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meal_date: MEAL_DATE, choice: 'option_1' }) },
        env
      );
      expect(res.status).toBe(401);
    });

    it('an employee cannot list all selections for a date', async () => {
      const res = await app.request(
        `${BASE}/api/selections/${MEAL_DATE}`,
        { headers: { Cookie: regular.cookie } },
        env
      );
      expect(res.status).toBe(403);
    });

    it('an employee cannot read another employee’s selection history', async () => {
      await select(regular, 'option_1');
      const res = await app.request(
        `${BASE}/api/selections/${regular.id}/${MEAL_DATE}/history`,
        { headers: { Cookie: shiftWorker.cookie } },
        env
      );
      expect(res.status).toBe(403);
    });

    it('an employee reading /me/:date sees only their own selection', async () => {
      await select(regular, 'option_1');

      const res = await app.request(
        `${BASE}/api/selections/me/${MEAL_DATE}`,
        { headers: { Cookie: shiftWorker.cookie } },
        env
      );

      expect(res.status).toBe(200);
      expect((await readJson(res)).data).toBeNull();
    });
  });

  describe('admin override', () => {
    const override = (body: Record<string, unknown>, cookie: string) =>
      app.request(`${BASE}/api/selections/admin/override`, jsonRequest(body, cookie), env);

    it('requires an override_reason', async () => {
      const res = await override(
        { employee_id: regular.id, meal_date: MEAL_DATE, choice: 'option_1' },
        admin.cookie
      );
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toContain('override_reason');
    });

    it('is refused for a non-admin caller', async () => {
      const res = await override(
        { employee_id: regular.id, meal_date: MEAL_DATE, choice: 'option_1', override_reason: 'nope' },
        shiftWorker.cookie
      );
      expect(res.status).toBe(403);
    });

    it('an admin override is recorded in history AND the audit log', async () => {
      const res = await override(
        {
          employee_id: regular.id,
          meal_date: MEAL_DATE,
          choice: 'option_2',
          override_reason: 'Employee requested by phone',
        },
        admin.cookie
      );

      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.data.source).toBe('admin_override');
      expect(body.data.override_reason).toBe('Employee requested by phone');

      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?', regular.id)
      ).toBe(1);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'ADMIN_OVERRIDE_SELECTION'")
        .all<{ actor_id: number }>();
      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
    });

    it('an IDENTICAL repeated override writes no history and no audit entry', async () => {
      const payload = {
        employee_id: regular.id,
        meal_date: MEAL_DATE,
        choice: 'option_2',
        override_reason: 'Employee requested by phone',
      };

      await override(payload, admin.cookie);
      const res = await override(payload, admin.cookie);

      expect(res.status).toBe(200);
      expect((await readJson(res)).changed).toBe(false);

      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?', regular.id)
      ).toBe(1);
      expect(
        await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'ADMIN_OVERRIDE_SELECTION'")
      ).toBe(1);
    });

    it('the same choice with a DIFFERENT reason is still a real, audited change', async () => {
      await override(
        { employee_id: regular.id, meal_date: MEAL_DATE, choice: 'option_2', override_reason: 'First reason' },
        admin.cookie
      );
      const res = await override(
        { employee_id: regular.id, meal_date: MEAL_DATE, choice: 'option_2', override_reason: 'Corrected reason' },
        admin.cookie
      );

      expect(res.status).toBe(200);
      expect((await readJson(res)).changed).toBe(true);

      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?', regular.id)
      ).toBe(2);
    });

    it('an admin override replacing an employee choice preserves the employee’s history', async () => {
      await select(regular, 'option_1');
      await override(
        { employee_id: regular.id, meal_date: MEAL_DATE, choice: 'option_2', override_reason: 'Kitchen shortage' },
        admin.cookie
      );

      const history = await db
        .prepare('SELECT * FROM lunch_selection_history WHERE employee_id = ? ORDER BY id')
        .bind(regular.id)
        .all<{ source: string; new_choice: string }>();

      // The employee's original choice is still on the record.
      expect(history.results).toHaveLength(2);
      expect(history.results[0].source).toBe('employee');
      expect(history.results[0].new_choice).toBe('option_1');
      expect(history.results[1].source).toBe('admin_override');
      expect(history.results[1].new_choice).toBe('option_2');
    });
  });
});
