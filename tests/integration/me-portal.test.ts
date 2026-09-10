// @vitest-environment node
/**
 * Integration Tests - Employee self-service API (/api/me)
 *
 * Real Hono routes, real SQL, synthetic fixtures. These back the employee
 * portal, so they also assert the portal never needs to derive a business date,
 * an eligibility reason or a cutoff for itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  seedMenuDay,
  seedRosterEntry,
  setSetting,
  extendAllSessions,
  jsonRequest,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const MEAL_DATE = '2027-03-07'; // Sunday - a configured working day

describe('Employee portal API (/api/me)', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let employee: SeededEmployee;
  let other: SeededEmployee;
  let shiftWorker: SeededEmployee;
  let ammanHq: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    await setSetting(db, 'timezone', '"Asia/Amman"');
    await setSetting(db, 'working_days', '[0,1,2,3,4]', 'json');

    employee = await seedEmployee(db, {
      amcoId: 'TEST001',
      fullName: 'Portal Tester',
      rosterType: 'regular',
      department: 'Mining',
      section: 'Operations',
    });
    other = await seedEmployee(db, { amcoId: 'TEST002', rosterType: 'regular' });
    shiftWorker = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
    ammanHq = await seedEmployee(db, { amcoId: 'TEST020', rosterType: 'amman_hq' });

    await extendAllSessions(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const today = (cookie: string, date?: string) =>
    app.request(
      `${BASE}/api/me/today${date ? `?date=${date}` : ''}`,
      { headers: { Cookie: cookie } },
      env
    );

  const history = (cookie: string, query = '') =>
    app.request(`${BASE}/api/me/selections/history${query}`, { headers: { Cookie: cookie } }, env);

  const select = (cookie: string, choice: string, mealDate = MEAL_DATE) =>
    app.request(`${BASE}/api/selections/me`, jsonRequest({ meal_date: mealDate, choice }, cookie), env);

  // ==========================================================================
  // AUTH
  // ==========================================================================

  describe('authentication', () => {
    it('3. an unauthenticated request to /today is rejected', async () => {
      expect((await app.request(`${BASE}/api/me/today`, {}, env)).status).toBe(401);
    });

    it('3. an unauthenticated request to history is rejected', async () => {
      expect((await app.request(`${BASE}/api/me/selections/history`, {}, env)).status).toBe(401);
    });

    it('an expired session is rejected', async () => {
      await db.prepare("UPDATE sessions SET expires_at = '2020-01-01T00:00:00.000Z'").run();
      expect((await today(employee.cookie)).status).toBe(401);
    });
  });

  // ==========================================================================
  // BUSINESS DATE
  // ==========================================================================

  describe('business date', () => {
    it('the server supplies the business date so the browser never computes it', async () => {
      const res = await today(employee.cookie);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.data.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.data.mealDate).toBe(body.data.businessDate);
    });

    it('the business date is the Asia/Amman day, not the UTC day', async () => {
      // 22:30 UTC on the 15th is already the 16th in Amman.
      vi.setSystemTime(new Date('2027-03-15T22:30:00Z'));

      const body = await readJson(await today(employee.cookie));
      expect(body.data.businessDate).toBe('2027-03-16');
    });

    it('accepts an explicit date and rejects a malformed one', async () => {
      const ok = await readJson(await today(employee.cookie, MEAL_DATE));
      expect(ok.data.mealDate).toBe(MEAL_DATE);

      expect((await today(employee.cookie, '07-03-2027')).status).toBe(400);
    });
  });

  // ==========================================================================
  // PROFILE
  // ==========================================================================

  describe('employee identity', () => {
    it('5. the employee sees their own profile fields', async () => {
      const body = await readJson(await today(employee.cookie));

      expect(body.data.employee.amco_id).toBe('TEST001');
      expect(body.data.employee.full_name).toBe('Portal Tester');
      expect(body.data.employee.department).toBe('Mining');
      expect(body.data.employee.section).toBe('Operations');
      expect(body.data.employee.roster_type).toBe('regular');
    });

    it('6. the payload is always the CALLER, never another employee', async () => {
      // There is no request parameter that can redirect this at someone else.
      const body = await readJson(await today(other.cookie));
      expect(body.data.employee.amco_id).toBe('TEST002');
    });

    it('never exposes password_hash', async () => {
      const raw = JSON.stringify(await readJson(await today(employee.cookie)));
      expect(raw).not.toContain('password_hash');
      expect(raw).not.toContain('pbkdf2');
    });
  });

  // ==========================================================================
  // ELIGIBILITY
  // ==========================================================================

  describe('eligibility', () => {
    it('7. an eligible employee reports eligible with a reason code', async () => {
      await seedMenuDay(db, MEAL_DATE, 'published');
      const body = await readJson(await today(employee.cookie, MEAL_DATE));

      expect(body.data.eligibility.eligible).toBe(true);
      expect(body.data.eligibility.reason).toBe('REGULAR_WORKING_DAY');
      expect(body.data.canSelect).toBe(true);
    });

    it('8. a regular employee on a weekend reports REGULAR_NON_WORKING_DAY', async () => {
      await seedMenuDay(db, '2027-03-05', 'published'); // Friday
      const body = await readJson(await today(employee.cookie, '2027-03-05'));

      expect(body.data.eligibility.eligible).toBe(false);
      expect(body.data.eligibility.reason).toBe('REGULAR_NON_WORKING_DAY');
      expect(body.data.canSelect).toBe(false);
    });

    it('8. an Amman HQ employee reports AMMAN_HQ_NO_MEAL', async () => {
      await seedMenuDay(db, MEAL_DATE, 'published');
      const body = await readJson(await today(ammanHq.cookie, MEAL_DATE));
      expect(body.data.eligibility.reason).toBe('AMMAN_HQ_NO_MEAL');
    });

    it('8. a shift employee with no roster reports ROSTER_MISSING', async () => {
      await seedMenuDay(db, MEAL_DATE, 'published');
      const body = await readJson(await today(shiftWorker.cookie, MEAL_DATE));
      expect(body.data.eligibility.reason).toBe('ROSTER_MISSING');
    });

    it('8. a shift employee rostered off reports SHIFT_OFF', async () => {
      await seedMenuDay(db, MEAL_DATE, 'published');
      await seedRosterEntry(db, shiftWorker.id, MEAL_DATE, 'off');
      const body = await readJson(await today(shiftWorker.cookie, MEAL_DATE));
      expect(body.data.eligibility.reason).toBe('SHIFT_OFF');
    });

    it('8. a configured holiday reports HOLIDAY', async () => {
      await seedMenuDay(db, MEAL_DATE, 'published');
      const admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
      await extendAllSessions(db);
      await app.request(
        `${BASE}/api/admin/holidays`,
        jsonRequest({ holiday_date: MEAL_DATE, name: 'Test Holiday' }, admin.cookie),
        env
      );

      const body = await readJson(await today(employee.cookie, MEAL_DATE));
      expect(body.data.eligibility.reason).toBe('HOLIDAY');
    });

    it('9. a next eligible date is supplied when the data establishes one', async () => {
      await seedMenuDay(db, '2027-03-05', 'published'); // Friday - not eligible
      await seedMenuDay(db, MEAL_DATE, 'published'); // Sunday - eligible

      const body = await readJson(await today(employee.cookie, '2027-03-05'));
      expect(body.data.eligibility.nextEligibleDate).toBe(MEAL_DATE);
    });

    it('10. the next eligible date is null when no future menu establishes one', async () => {
      await seedMenuDay(db, '2027-03-05', 'published'); // Friday only

      const body = await readJson(await today(employee.cookie, '2027-03-05'));
      expect(body.data.eligibility.nextEligibleDate).toBeNull();
    });

    it('10. Amman HQ always has a null next eligible date', async () => {
      await seedMenuDay(db, MEAL_DATE, 'published');
      const body = await readJson(await today(ammanHq.cookie, MEAL_DATE));
      expect(body.data.eligibility.nextEligibleDate).toBeNull();
    });
  });

  // ==========================================================================
  // MENU
  // ==========================================================================

  describe('menu', () => {
    it('11. a published menu is returned with its options', async () => {
      const menuDayId = await seedMenuDay(db, MEAL_DATE, 'published');
      await db
        .prepare('INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 1, ?), (?, 2, ?)')
        .bind(menuDayId, 'Test Dish Alpha', menuDayId, 'Test Dish Beta')
        .run();
      await db
        .prepare('INSERT INTO menu_components (menu_day_id, component_type, name) VALUES (?, ?, ?)')
        .bind(menuDayId, 'beverage', 'Test Beverage')
        .run();

      const body = await readJson(await today(employee.cookie, MEAL_DATE));

      expect(body.data.menu).not.toBeNull();
      expect(body.data.menu.options).toHaveLength(2);
      expect(body.data.menu.options[0].name).toBe('Test Dish Alpha');
      expect(body.data.menu.components[0].name).toBe('Test Beverage');
    });

    it('12. an unpublished (draft) menu is NOT shown to the employee', async () => {
      await seedMenuDay(db, MEAL_DATE, 'draft');

      const body = await readJson(await today(employee.cookie, MEAL_DATE));
      expect(body.data.menu).toBeNull();
      expect(body.data.canSelect).toBe(false);
    });

    it('13. no menu at all yields a null menu, not fabricated data', async () => {
      const body = await readJson(await today(employee.cookie, MEAL_DATE));
      expect(body.data.menu).toBeNull();
      expect(body.data.canSelect).toBe(false);
    });
  });

  // ==========================================================================
  // SELECTION STATE + CUTOFF
  // ==========================================================================

  describe('selection state', () => {
    beforeEach(async () => {
      await seedMenuDay(db, MEAL_DATE, 'published');
    });

    it('17. an existing selection is reported back', async () => {
      await select(employee.cookie, 'option_2');

      const body = await readJson(await today(employee.cookie, MEAL_DATE));
      expect(body.data.selection.choice).toBe('option_2');
    });

    it('no selection yet is reported as null', async () => {
      const body = await readJson(await today(employee.cookie, MEAL_DATE));
      expect(body.data.selection).toBeNull();
    });

    it('19. the cutoff outcome is computed server-side and surfaced', async () => {
      await setSetting(db, 'lunch_cutoff_time', '"11:00"', 'time');
      // 09:00 UTC is 12:00 in Amman, past an 11:00 cutoff.
      vi.setSystemTime(new Date(`${MEAL_DATE}T09:00:00Z`));

      const body = await readJson(await today(employee.cookie, MEAL_DATE));
      expect(body.data.cutoffPassed).toBe(true);
      expect(body.data.canSelect).toBe(false);
    });

    it('19. the cutoff flag follows the configured setting, not a constant', async () => {
      vi.setSystemTime(new Date(`${MEAL_DATE}T09:00:00Z`)); // 12:00 Amman

      await setSetting(db, 'lunch_cutoff_time', '"11:00"', 'time');
      expect((await readJson(await today(employee.cookie, MEAL_DATE))).data.cutoffPassed).toBe(true);

      await setSetting(db, 'lunch_cutoff_time', '"16:00"', 'time');
      expect((await readJson(await today(employee.cookie, MEAL_DATE))).data.cutoffPassed).toBe(false);
    });
  });

  // ==========================================================================
  // HISTORY
  // ==========================================================================

  describe('selection history', () => {
    beforeEach(async () => {
      await seedMenuDay(db, MEAL_DATE, 'published');
      await seedMenuDay(db, '2027-03-08', 'published');
    });

    it('22. an employee can retrieve their own history', async () => {
      await select(employee.cookie, 'option_1');
      await select(employee.cookie, 'option_2'); // a change - two history rows

      const body = await readJson(await history(employee.cookie));

      expect(body.success).toBe(true);
      expect(body.data.total).toBe(2);
      expect(body.data.entries).toHaveLength(2);
      expect(body.data.entries[0].new_choice).toBe('option_2');
      expect(body.data.entries[0].previous_choice).toBe('option_1');
      expect(body.data.entries[0].meal_date).toBe(MEAL_DATE);
    });

    it('23. history contains ONLY the caller, never another employee', async () => {
      await select(employee.cookie, 'option_1');
      await select(other.cookie, 'option_2');

      const mine = await readJson(await history(employee.cookie));
      expect(mine.data.total).toBe(1);
      expect(mine.data.entries[0].new_choice).toBe('option_1');

      const theirs = await readJson(await history(other.cookie));
      expect(theirs.data.total).toBe(1);
      expect(theirs.data.entries[0].new_choice).toBe('option_2');
    });

    it('23. no query parameter can redirect history at another employee', async () => {
      await select(other.cookie, 'option_2');

      // Employee id comes from the session; these params are simply ignored.
      const body = await readJson(
        await history(employee.cookie, `?employee_id=${other.id}&employeeId=${other.id}`)
      );
      expect(body.data.total).toBe(0);
      expect(body.data.entries).toEqual([]);
    });

    it('an employee with no selections gets an empty history, not an error', async () => {
      const body = await readJson(await history(employee.cookie));
      expect(body.data.total).toBe(0);
      expect(body.data.entries).toEqual([]);
    });

    it('supports limit and offset, and caps an excessive limit', async () => {
      await select(employee.cookie, 'option_1');
      await select(employee.cookie, 'option_2');
      await select(employee.cookie, 'option_1', '2027-03-08');

      const firstPage = await readJson(await history(employee.cookie, '?limit=2'));
      expect(firstPage.data.entries).toHaveLength(2);
      expect(firstPage.data.total).toBe(3);

      const secondPage = await readJson(await history(employee.cookie, '?limit=2&offset=2'));
      expect(secondPage.data.entries).toHaveLength(1);

      const capped = await readJson(await history(employee.cookie, '?limit=9999'));
      expect(capped.data.limit).toBe(100);
    });

    it('does not expose internal audit columns', async () => {
      await select(employee.cookie, 'option_1');

      const body = await readJson(await history(employee.cookie));
      const entry = body.data.entries[0];

      expect(Object.keys(entry).sort()).toEqual(
        ['changed_at', 'id', 'meal_date', 'new_choice', 'previous_choice', 'source'].sort()
      );
      expect(entry).not.toHaveProperty('ip_address');
      expect(entry).not.toHaveProperty('changed_by');
      expect(entry).not.toHaveProperty('override_reason');
    });

    it('21. an identical re-selection adds no history row', async () => {
      await select(employee.cookie, 'option_1');
      await select(employee.cookie, 'option_1');

      const body = await readJson(await history(employee.cookie));
      expect(body.data.total).toBe(1);
    });

    it('an admin override appears in the employee history with its source', async () => {
      const admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
      await extendAllSessions(db);
      await select(employee.cookie, 'option_1');

      await app.request(
        `${BASE}/api/selections/admin/override`,
        jsonRequest(
          { employee_id: employee.id, meal_date: MEAL_DATE, choice: 'option_2', override_reason: 'Kitchen shortage' },
          admin.cookie
        ),
        env
      );

      const body = await readJson(await history(employee.cookie));
      expect(body.data.total).toBe(2);
      expect(body.data.entries[0].source).toBe('admin_override');
      // The reason is administrative context, not employee-facing detail.
      expect(body.data.entries[0]).not.toHaveProperty('override_reason');
    });
  });
});
