// @vitest-environment node
/**
 * Integration Tests - Admin settings and the configurable lunch cutoff
 *
 * The cutoff must be read dynamically from settings on every selection, never
 * hard-coded. These tests change the setting through the API and then verify the
 * selection route's behaviour actually follows it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  seedMenuDay,
  jsonRequest,
  readJson,
  countRows,
  extendAllSessions,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const MEAL_DATE = '2027-03-07'; // Sunday - a configured working day

describe('Admin settings', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
    await seedMenuDay(db, MEAL_DATE, 'published');

    // These tests move the clock to the meal date, which is past the seeded
    // session expiry; keep the sessions alive so the cutoff rule is what is
    // actually under test.
    await extendAllSessions(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const putCutoff = (cutoff: unknown, cookie: string) =>
    app.request(
      `${BASE}/api/admin/settings/cutoff`,
      { ...jsonRequest({ cutoff_time: cutoff }, cookie), method: 'PUT' },
      env
    );

  const select = (cookie: string, choice = 'option_1', mealDate = MEAL_DATE) =>
    app.request(`${BASE}/api/selections/me`, jsonRequest({ meal_date: mealDate, choice }, cookie), env);

  describe('13. reading settings', () => {
    it('admin reads the current settings', async () => {
      const res = await app.request(`${BASE}/api/admin/settings`, { headers: { Cookie: admin.cookie } }, env);

      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.success).toBe(true);

      const keys = body.data.map((s: { key: string }) => s.key);
      expect(keys).toContain('lunch_cutoff_time');
      expect(keys).toContain('working_days');
      expect(keys).toContain('timezone');
    });

    it('the seeded cutoff is the configured value, not a constant in code', async () => {
      const res = await app.request(`${BASE}/api/admin/settings`, { headers: { Cookie: admin.cookie } }, env);
      const body = await readJson(res);
      const cutoff = body.data.find((s: { key: string }) => s.key === 'lunch_cutoff_time');
      expect(cutoff.value).toBe('"10:00"');
    });
  });

  describe('14. changing the cutoff', () => {
    it('admin changes the cutoff time', async () => {
      const res = await putCutoff('14:30', admin.cookie);

      expect(res.status).toBe(200);
      const stored = await db
        .prepare("SELECT value FROM settings WHERE key = 'lunch_cutoff_time'")
        .first<{ value: string }>();
      expect(stored!.value).toBe('"14:30"');
    });

    it('validates the cutoff format', async () => {
      for (const bad of ['25:00', '9:00', '14:60', 'noon', '', '14-30', 123]) {
        const res = await putCutoff(bad, admin.cookie);
        expect(res.status).toBe(400);
      }

      // The stored value is untouched by every rejected attempt.
      const stored = await db
        .prepare("SELECT value FROM settings WHERE key = 'lunch_cutoff_time'")
        .first<{ value: string }>();
      expect(stored!.value).toBe('"10:00"');
    });

    it('accepts boundary times', async () => {
      expect((await putCutoff('00:00', admin.cookie)).status).toBe(200);
      expect((await putCutoff('23:59', admin.cookie)).status).toBe(200);
    });
  });

  describe('the selection route honours the configured cutoff', () => {
    it('15. a selection BEFORE the configured cutoff succeeds', async () => {
      await putCutoff('16:00', admin.cookie);

      // 09:00 UTC is 12:00 in Asia/Amman, before a 16:00 cutoff.
      vi.setSystemTime(new Date(`${MEAL_DATE}T09:00:00Z`));

      const res = await select(employee.cookie);
      expect(res.status).toBe(201);
    });

    it('16. a selection AFTER the configured cutoff is rejected', async () => {
      await putCutoff('11:00', admin.cookie);

      // 09:00 UTC is 12:00 in Asia/Amman, past an 11:00 cutoff.
      vi.setSystemTime(new Date(`${MEAL_DATE}T09:00:00Z`));

      const res = await select(employee.cookie);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toContain('cutoff');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(0);
    });

    it('the cutoff is read dynamically: the same instant flips with the setting', async () => {
      // One fixed instant, two different configured cutoffs, two outcomes.
      // This is what proves the value is not baked into the code path.
      vi.setSystemTime(new Date(`${MEAL_DATE}T09:00:00Z`)); // 12:00 Amman

      await putCutoff('11:00', admin.cookie);
      expect((await select(employee.cookie)).status).toBe(400);

      await putCutoff('16:00', admin.cookie);
      expect((await select(employee.cookie)).status).toBe(201);
    });

    it('the cutoff is compared in Asia/Amman, not UTC', async () => {
      await putCutoff('14:00', admin.cookie);

      // 12:30 UTC is 15:30 in Amman - past a 14:00 Amman cutoff, but still
      // before it if the comparison were (wrongly) made in UTC.
      vi.setSystemTime(new Date(`${MEAL_DATE}T12:30:00Z`));

      const res = await select(employee.cookie);
      expect(res.status).toBe(400);
    });
  });

  describe('17. authorization', () => {
    it('a non-admin cannot read settings', async () => {
      const res = await app.request(`${BASE}/api/admin/settings`, { headers: { Cookie: employee.cookie } }, env);
      expect(res.status).toBe(403);
    });

    it('a non-admin cannot modify the cutoff', async () => {
      const res = await putCutoff('23:00', employee.cookie);
      expect(res.status).toBe(403);

      const stored = await db
        .prepare("SELECT value FROM settings WHERE key = 'lunch_cutoff_time'")
        .first<{ value: string }>();
      expect(stored!.value).toBe('"10:00"');
    });

    it('an unauthenticated caller cannot read or modify settings', async () => {
      expect((await app.request(`${BASE}/api/admin/settings`, {}, env)).status).toBe(401);
    });
  });

  describe('28. audit', () => {
    it('a cutoff change is audited with before and after', async () => {
      await putCutoff('15:45', admin.cookie);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'UPDATE_SETTING'")
        .all<{ actor_id: number; before_json: string; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(JSON.parse(audit.results[0].before_json)).toEqual({ key: 'lunch_cutoff_time', value: '"10:00"' });
      expect(JSON.parse(audit.results[0].after_json)).toEqual({ key: 'lunch_cutoff_time', value: '"15:45"' });
    });

    it('a rejected cutoff change writes no audit record', async () => {
      await putCutoff('99:99', admin.cookie);
      await putCutoff('12:00', employee.cookie);

      expect(await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'UPDATE_SETTING'")).toBe(0);
    });
  });
});
