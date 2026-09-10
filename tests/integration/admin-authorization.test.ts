// @vitest-environment node
/**
 * Integration Tests - admin authorization is enforced SERVER-side.
 *
 * The admin portal hides its navigation from non-admins, but that is a UX
 * affordance only. These tests assert the real boundary: every admin endpoint
 * rejects an authenticated non-admin and an unauthenticated caller, whatever the
 * browser chooses to render.
 *
 * Slice 3 changed no backend code; this suite exists so a future frontend change
 * cannot quietly become the only thing standing between an employee and the
 * admin API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  countRows,
  jsonRequest,
  readJson,
  ROLE_ADMIN,
  ROLE_SUPER_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';

/** Every admin endpoint the portal calls, with a safe example body. */
const ADMIN_ENDPOINTS: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/api/admin/employees' },
  { method: 'POST', path: '/api/admin/employees', body: { amco_id: 'TEST500', full_name: 'Nope', roster_type: 'regular' } },
  { method: 'PUT', path: '/api/admin/employees/1', body: { full_name: 'Hijacked' } },
  { method: 'PUT', path: '/api/admin/employees/1/status', body: { is_active: false } },
  { method: 'PUT', path: '/api/admin/employees/1/password', body: { password: 'a-long-enough-secret' } },
  { method: 'GET', path: '/api/admin/settings' },
  { method: 'PUT', path: '/api/admin/settings/cutoff', body: { cutoff_time: '23:00' } },
  { method: 'GET', path: '/api/admin/holidays' },
  { method: 'POST', path: '/api/admin/holidays', body: { holiday_date: '2027-12-25', name: 'Nope' } },
  { method: 'DELETE', path: '/api/admin/holidays/2027-12-25' },
];

function call(method: string, cookie: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

describe('Admin API authorization', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let superAdmin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    superAdmin = await seedEmployee(db, { amcoId: 'TEST901', roleId: ROLE_SUPER_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
  });

  it.each(ADMIN_ENDPOINTS)(
    'rejects an authenticated NON-admin: $method $path',
    async ({ method, path, body }) => {
      const res = await app.request(`${BASE}${path}`, call(method, employee.cookie, body), env);
      expect(res.status).toBe(403);
    }
  );

  it.each(ADMIN_ENDPOINTS)(
    'rejects an unauthenticated caller: $method $path',
    async ({ method, path, body }) => {
      const res = await app.request(`${BASE}${path}`, call(method, null, body), env);
      expect(res.status).toBe(401);
    }
  );

  it('admins and super_admins are both accepted', async () => {
    for (const actor of [admin, superAdmin]) {
      const res = await app.request(
        `${BASE}/api/admin/employees`,
        { headers: { Cookie: actor.cookie } },
        env
      );
      expect(res.status).toBe(200);
    }
  });

  it('a refused admin call changes nothing and writes no audit record', async () => {
    await app.request(
      `${BASE}/api/admin/employees`,
      call('POST', employee.cookie, {
        amco_id: 'TEST500',
        full_name: 'Should Not Exist',
        roster_type: 'regular',
      }),
      env
    );

    expect(await countRows(db, "SELECT COUNT(*) as n FROM employees WHERE amco_id = 'TEST500'")).toBe(0);
    expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(0);
  });

  it('a non-admin cannot deactivate anyone, and the target keeps their session', async () => {
    await app.request(
      `${BASE}/api/admin/employees/${admin.id}/status`,
      call('PUT', employee.cookie, { is_active: false }),
      env
    );

    const row = await db
      .prepare('SELECT is_active FROM employees WHERE id = ?')
      .bind(admin.id)
      .first<{ is_active: number }>();
    expect(row!.is_active).toBe(1);

    const stillWorks = await app.request(
      `${BASE}/api/admin/employees`,
      { headers: { Cookie: admin.cookie } },
      env
    );
    expect(stillWorks.status).toBe(200);
  });

  it('a non-admin cannot set anyone’s password, including their own', async () => {
    await setEmployeePasswordDirect(db, employee.id, 'original-password-here');

    const attacker = await app.request(
      `${BASE}/api/admin/employees/${admin.id}/password`,
      call('PUT', employee.cookie, { password: 'attacker-chosen-secret' }),
      env
    );
    expect(attacker.status).toBe(403);

    const self = await app.request(
      `${BASE}/api/admin/employees/${employee.id}/password`,
      call('PUT', employee.cookie, { password: 'attacker-chosen-secret' }),
      env
    );
    expect(self.status).toBe(403);

    // The original password hash is untouched.
    const login = await app.request(
      `${BASE}/api/auth/login`,
      jsonRequest({ amco_id: employee.amcoId, password: 'original-password-here' }),
      env
    );
    expect(login.status).toBe(200);
  });

  it('admin employee responses never expose password_hash', async () => {
    await setEmployeePasswordDirect(db, employee.id, 'a-real-password-here');

    const list = await app.request(
      `${BASE}/api/admin/employees`,
      { headers: { Cookie: admin.cookie } },
      env
    );
    const raw = JSON.stringify(await readJson(list));

    expect(raw).not.toContain('password_hash');
    expect(raw).not.toContain('pbkdf2');
    expect(raw).not.toContain('a-real-password-here');
  });

  it('the employee list honours server-side search and filters', async () => {
    await seedEmployee(db, { amcoId: 'TEST010', fullName: 'Distinctive Name', rosterType: 'shift' });

    const search = await readJson(
      await app.request(
        `${BASE}/api/admin/employees?search=Distinctive`,
        { headers: { Cookie: admin.cookie } },
        env
      )
    );
    expect(search.data.total).toBe(1);
    expect(search.data.employees[0].amco_id).toBe('TEST010');

    const byRoster = await readJson(
      await app.request(
        `${BASE}/api/admin/employees?roster_type=shift`,
        { headers: { Cookie: admin.cookie } },
        env
      )
    );
    expect(byRoster.data.total).toBe(1);
  });
});
