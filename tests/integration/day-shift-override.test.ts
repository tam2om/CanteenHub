// @vitest-environment node
/**
 * Integration Tests - the Settings "everyone on day shift" override
 *
 * Switched on through the admin API, it must let a rostered-Off shift employee
 * order inside the period, and stop doing so once the toggle is off or the
 * period has ended. The roster itself is never changed.
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
  jsonRequest,
  readJson,
  insideOrderingWindow,
  extendAllSessions,
  countRows,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const MEAL_DATE = '2027-03-07'; // Sunday
const TODAY = '2027-03-06'; // the ordering day for MEAL_DATE

describe('Day-shift override', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;
  let shiftWorker: SeededEmployee;

  beforeEach(async () => {
    vi.setSystemTime(insideOrderingWindow(MEAL_DATE));
    db = createTestDb();
    env = testEnv(db);
    await setSetting(db, 'timezone', '"Asia/Amman"');
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
    shiftWorker = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
    await seedMenuDay(db, MEAL_DATE, 'published');
    await seedRosterEntry(db, shiftWorker.id, MEAL_DATE, 'off');
    await extendAllSessions(db);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const putOverride = (body: unknown, cookie = admin.cookie) =>
    app.request(
      `${BASE}/api/admin/settings/day-shift-override`,
      { ...jsonRequest(body, cookie), method: 'PUT' },
      env
    );

  const getOverride = () =>
    app.request(`${BASE}/api/admin/settings/day-shift-override`, { headers: { Cookie: admin.cookie } }, env);

  const select = () =>
    app.request(
      `${BASE}/api/selections/me`,
      jsonRequest({ meal_date: MEAL_DATE, choice: 'option_1', pickup_location: 'amco_canteen' }, shiftWorker.cookie),
      env
    );

  it('is off by default', async () => {
    const body = await readJson(await getOverride());
    expect(body.data).toMatchObject({ enabled: false, state: 'off', today: TODAY });
  });

  it('lets a rostered-Off shift employee order while on, without touching the roster', async () => {
    expect((await select()).status).toBe(403);

    const res = await putOverride({ enabled: true, start_date: TODAY, end_date: MEAL_DATE });
    expect(res.status).toBe(200);
    expect((await readJson(res)).data).toMatchObject({ enabled: true, state: 'active' });

    expect((await select()).status).toBe(201);
    expect(
      await countRows(db, "SELECT COUNT(*) as n FROM roster_entries WHERE employee_id = ? AND shift_value = 'off'", shiftWorker.id)
    ).toBe(1);
  });

  it('reports SHIFT_DAY_OVERRIDE on the portal', async () => {
    await putOverride({ enabled: true, start_date: TODAY, end_date: MEAL_DATE });
    const res = await app.request(`${BASE}/api/me/today`, { headers: { Cookie: shiftWorker.cookie } }, env);
    const body = await readJson(res);
    expect(body.data.eligibility.reason).toBe('SHIFT_DAY_OVERRIDE');
  });

  it('turning it off returns everyone to their roster', async () => {
    await putOverride({ enabled: true, start_date: TODAY, end_date: MEAL_DATE });
    const off = await putOverride({ enabled: false });
    expect((await readJson(off)).data).toMatchObject({
      enabled: false,
      state: 'off',
      start_date: TODAY,
      end_date: MEAL_DATE,
    });
    expect((await select()).status).toBe(403);
  });

  it('does not apply to a meal date after the end date', async () => {
    await putOverride({ enabled: true, start_date: TODAY, end_date: TODAY });
    const res = await select();
    expect(res.status).toBe(403);
    expect((await readJson(res)).error).toContain('SHIFT_OFF');
  });

  it('reads as expired once the end date has passed', async () => {
    await putOverride({ enabled: true, start_date: TODAY, end_date: TODAY });
    vi.setSystemTime(insideOrderingWindow('2027-03-09'));
    expect((await readJson(await getOverride())).data.state).toBe('expired');
  });

  it('points the portal at the next date the override covers', async () => {
    await seedMenuDay(db, '2027-03-08', 'published');
    await seedRosterEntry(db, shiftWorker.id, '2027-03-08', 'off');
    await putOverride({ enabled: true, start_date: '2027-03-08', end_date: '2027-03-08' });
    const res = await app.request(`${BASE}/api/me/today`, { headers: { Cookie: shiftWorker.cookie } }, env);
    const body = await readJson(res);
    expect(body.data.eligibility).toMatchObject({ reason: 'SHIFT_OFF', nextEligibleDate: '2027-03-08' });
  });

  it('validates the period', async () => {
    expect((await putOverride({ enabled: 'yes' })).status).toBe(400);
    expect((await putOverride({ enabled: true, start_date: TODAY })).status).toBe(400);
    expect((await putOverride({ enabled: true, start_date: MEAL_DATE, end_date: TODAY })).status).toBe(400);
    expect((await putOverride({ enabled: true, start_date: '2027-03-01', end_date: '2027-03-02' })).status).toBe(400);
  });

  it('is admin-only', async () => {
    const res = await putOverride({ enabled: true, start_date: TODAY, end_date: MEAL_DATE }, employee.cookie);
    expect(res.status).toBe(403);
  });

  it('is audited', async () => {
    await putOverride({ enabled: true, start_date: TODAY, end_date: MEAL_DATE });
    expect(
      await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'UPDATE_SETTING' AND after_json LIKE '%day_shift_override%'")
    ).toBe(1);
  });
});
