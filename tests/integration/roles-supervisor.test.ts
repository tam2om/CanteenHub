// @vitest-environment node
/**
 * Integration Tests - the supervisor role, and who may change a super
 * administrator's account.
 *
 * Real Hono routes against the real migrations (0006 rebuilds `roles` to add
 * supervisor). The refusals matter more than the permissions here: every
 * refused request is checked to have changed NOTHING, because a 403 that still
 * wrote the row would be worse than no check at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  seedMenuDay,
  setEmployeePasswordDirect,
  jsonRequest,
  readJson,
  ROLE_ADMIN,
  ROLE_EMPLOYEE,
  ROLE_SUPER_ADMIN,
  ROLE_SUPERVISOR,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const ADMIN = `${BASE}/api/admin`;
const REPORT_DATE = '2027-06-06';

describe('Roles', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let superAdmin: SeededEmployee;
  let admin: SeededEmployee;
  let supervisor: SeededEmployee;
  let otherSupervisor: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    superAdmin = await seedEmployee(db, { amcoId: 'TEST700', roleId: ROLE_SUPER_ADMIN });
    admin = await seedEmployee(db, { amcoId: 'TEST701', roleId: ROLE_ADMIN });
    supervisor = await seedEmployee(db, { amcoId: 'TEST702', roleId: ROLE_SUPERVISOR });
    otherSupervisor = await seedEmployee(db, { amcoId: 'TEST703', roleId: ROLE_SUPERVISOR });
    employee = await seedEmployee(db, { amcoId: 'TEST704', fullName: 'Original Name' });
  });

  const put = (url: string, body: unknown, cookie: string) =>
    app.request(url, { ...jsonRequest(body, cookie), method: 'PUT' }, env);

  const get = (url: string, cookie: string) =>
    app.request(url, { headers: { Cookie: cookie } }, env);

  const row = (id: number) =>
    db
      .prepare('SELECT full_name, role_id, is_active, password_hash, department FROM employees WHERE id = ?')
      .bind(id)
      .first<{ full_name: string; role_id: number; is_active: number; password_hash: string | null; department: string | null }>();

  // ==========================================================================
  // THE ROLE ITSELF
  // ==========================================================================

  describe('the supervisor role exists', () => {
    it('is in the roles table as id 4, next to the original three', async () => {
      const roles = await db
        .prepare('SELECT id, name FROM roles ORDER BY id')
        .all<{ id: number; name: string }>();
      expect(roles.results).toEqual([
        { id: 1, name: 'employee' },
        { id: 2, name: 'admin' },
        { id: 3, name: 'super_admin' },
        { id: 4, name: 'supervisor' },
      ]);
    });

    it('rebuilding roles left every foreign key intact', async () => {
      const problems = db.sqlite.prepare('PRAGMA foreign_key_check').all();
      expect(problems).toEqual([]);

      // And the key still bites: an unknown role is refused by the database.
      expect(() =>
        db.sqlite.prepare('UPDATE employees SET role_id = 9 WHERE id = ?').run(employee.id)
      ).toThrow(/FOREIGN KEY/);
    });

    it('a supervisor signs in as a supervisor', async () => {
      await setEmployeePasswordDirect(db, supervisor.id, 'supervisor-pass');
      const res = await app.request(
        `${BASE}/api/auth/login`,
        jsonRequest({ amco_id: 'TEST702', password: 'supervisor-pass' }),
        env
      );
      expect(res.status).toBe(200);
      expect((await readJson(res)).data.employee.role).toBe('supervisor');

      const me = await readJson(await get(`${BASE}/api/auth/me`, supervisor.cookie));
      expect(me.data.role).toBe('supervisor');
    });

    it('an administrator can make someone a supervisor', async () => {
      const res = await put(`${ADMIN}/employees/${employee.id}`, { role_id: ROLE_SUPERVISOR }, admin.cookie);
      expect(res.status).toBe(200);
      expect((await row(employee.id))!.role_id).toBe(ROLE_SUPERVISOR);
    });
  });

  // ==========================================================================
  // WHAT A SUPERVISOR CAN DO
  // ==========================================================================

  describe('a supervisor can', () => {
    it('use their own employee portal', async () => {
      const res = await get(`${BASE}/api/me/today`, supervisor.cookie);
      expect(res.status).toBe(200);
      expect((await readJson(res)).data.employee.amco_id).toBe('TEST702');
    });

    it('list employees', async () => {
      const res = await get(`${ADMIN}/employees?page=1&page_size=50`, supervisor.cookie);
      expect(res.status).toBe(200);
      expect((await readJson(res)).data.total).toBe(5);
    });

    it('edit an employee’s details', async () => {
      const res = await put(
        `${ADMIN}/employees/${employee.id}`,
        {
          full_name: 'Corrected Name',
          department: 'Processing',
          default_location: 'omco_canteen',
          meal_preference: 'healthy',
        },
        supervisor.cookie
      );

      expect(res.status).toBe(200);
      const after = await row(employee.id);
      expect(after!.full_name).toBe('Corrected Name');
      expect(after!.department).toBe('Processing');
    });

    it('read the lunch report and download it as Excel', async () => {
      await seedMenuDay(db, REPORT_DATE, 'published');

      const json = await get(`${ADMIN}/reports/lunch?date=${REPORT_DATE}`, supervisor.cookie);
      expect(json.status).toBe(200);

      const xlsx = await get(`${ADMIN}/reports/lunch.xlsx?date=${REPORT_DATE}`, supervisor.cookie);
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers.get('Content-Type')).toContain('spreadsheetml');
    });
  });

  // ==========================================================================
  // WHAT A SUPERVISOR CANNOT DO - and that refusing it wrote nothing
  // ==========================================================================

  describe('a supervisor cannot', () => {
    it('create an employee', async () => {
      const before = await db.prepare('SELECT COUNT(*) AS n FROM employees').first<{ n: number }>();
      const res = await app.request(
        `${ADMIN}/employees`,
        jsonRequest({ amco_id: 'TEST799', full_name: 'Nobody', roster_type: 'regular' }, supervisor.cookie),
        env
      );
      expect(res.status).toBe(403);
      const after = await db.prepare('SELECT COUNT(*) AS n FROM employees').first<{ n: number }>();
      expect(after!.n).toBe(before!.n);
    });

    it('deactivate an employee', async () => {
      const res = await put(`${ADMIN}/employees/${employee.id}/status`, { is_active: false }, supervisor.cookie);
      expect(res.status).toBe(403);
      expect((await row(employee.id))!.is_active).toBe(1);
    });

    it('set anyone’s password', async () => {
      await setEmployeePasswordDirect(db, employee.id, 'original-pass');
      const before = (await row(employee.id))!.password_hash;

      const res = await put(`${ADMIN}/employees/${employee.id}/password`, { password: 'hijacked' }, supervisor.cookie);

      expect(res.status).toBe(403);
      expect((await row(employee.id))!.password_hash).toBe(before);
    });

    it('change anyone’s role - including their own', async () => {
      const promote = await put(`${ADMIN}/employees/${employee.id}`, { role_id: ROLE_ADMIN }, supervisor.cookie);
      expect(promote.status).toBe(403);
      expect((await row(employee.id))!.role_id).toBe(ROLE_EMPLOYEE);

      // Their own row is a supervisor, so the "employees only" rule refuses it
      // before the role rule is even reached. Either way: nothing changes.
      const self = await put(`${ADMIN}/employees/${supervisor.id}`, { role_id: ROLE_ADMIN }, supervisor.cookie);
      expect(self.status).toBe(403);
      expect((await row(supervisor.id))!.role_id).toBe(ROLE_SUPERVISOR);
    });

    it('refuses a role change even when sent alongside a legitimate edit', async () => {
      const res = await put(
        `${ADMIN}/employees/${employee.id}`,
        { full_name: 'Sneaky Edit', role_id: ROLE_SUPER_ADMIN },
        supervisor.cookie
      );
      expect(res.status).toBe(403);
      // All or nothing: the name is not changed either.
      const after = await row(employee.id);
      expect(after!.full_name).toBe('Original Name');
      expect(after!.role_id).toBe(ROLE_EMPLOYEE);
    });

    it.each([
      ['another supervisor', () => otherSupervisor],
      ['an administrator', () => admin],
      ['a super administrator', () => superAdmin],
    ])('edit %s', async (_label, target) => {
      const before = await row(target().id);
      const res = await put(`${ADMIN}/employees/${target().id}`, { full_name: 'Renamed' }, supervisor.cookie);

      expect(res.status).toBe(403);
      expect((await readJson(res)).error).toMatch(/employees only/i);
      expect((await row(target().id))!.full_name).toBe(before!.full_name);
    });

    it.each([
      ['settings', 'GET', `${ADMIN}/settings`],
      ['change the cutoff', 'PUT', `${ADMIN}/settings/cutoff`],
      ['holidays', 'GET', `${ADMIN}/holidays`],
      ['add a holiday', 'POST', `${ADMIN}/holidays`],
      ['imports', 'GET', `${ADMIN}/imports`],
      ['menu administration', 'GET', `${BASE}/api/menu/admin/range?from=2027-06-01&to=2027-06-30`],
      ['roster administration', 'GET', `${BASE}/api/roster/admin/day?date=2027-06-06`],
      ['override a meal', 'POST', `${BASE}/api/selections/admin/override`],
    ])('reach %s', async (_label, method, url) => {
      const res = await app.request(
        url,
        {
          method,
          headers: { Cookie: supervisor.cookie, 'Content-Type': 'application/json' },
          ...(method === 'GET' ? {} : { body: '{}' }),
        },
        env
      );
      expect(res.status).toBe(403);
    });
  });

  // ==========================================================================
  // A SUPER ADMINISTRATOR'S ACCOUNT
  // ==========================================================================

  describe('only a super administrator changes a super administrator’s account', () => {
    it('an administrator cannot SET THEIR PASSWORD - the route to becoming them', async () => {
      await setEmployeePasswordDirect(db, superAdmin.id, 'super-secret');
      const before = (await row(superAdmin.id))!.password_hash;

      const res = await put(`${ADMIN}/employees/${superAdmin.id}/password`, { password: 'takeover' }, admin.cookie);

      expect(res.status).toBe(403);
      expect((await row(superAdmin.id))!.password_hash).toBe(before);

      // And the old password still works: nothing was half-applied.
      const login = await app.request(
        `${BASE}/api/auth/login`,
        jsonRequest({ amco_id: 'TEST700', password: 'super-secret' }),
        env
      );
      expect(login.status).toBe(200);
    });

    it('an administrator cannot deactivate them', async () => {
      const res = await put(`${ADMIN}/employees/${superAdmin.id}/status`, { is_active: false }, admin.cookie);
      expect(res.status).toBe(403);
      expect((await row(superAdmin.id))!.is_active).toBe(1);
    });

    it('an administrator cannot edit their details', async () => {
      const before = await row(superAdmin.id);
      const res = await put(`${ADMIN}/employees/${superAdmin.id}`, { full_name: 'Renamed' }, admin.cookie);
      expect(res.status).toBe(403);
      expect((await row(superAdmin.id))!.full_name).toBe(before!.full_name);
    });

    it('a super administrator can do all three', async () => {
      const other = await seedEmployee(db, { amcoId: 'TEST710', roleId: ROLE_SUPER_ADMIN });

      expect((await put(`${ADMIN}/employees/${other.id}`, { full_name: 'Renamed' }, superAdmin.cookie)).status).toBe(200);
      expect((await put(`${ADMIN}/employees/${other.id}/password`, { password: 'fresh-pass' }, superAdmin.cookie)).status).toBe(200);
      expect((await put(`${ADMIN}/employees/${other.id}/status`, { is_active: false }, superAdmin.cookie)).status).toBe(200);
    });

    it('an administrator still manages employees and other administrators', async () => {
      const otherAdmin = await seedEmployee(db, { amcoId: 'TEST711', roleId: ROLE_ADMIN });

      expect((await put(`${ADMIN}/employees/${employee.id}/password`, { password: 'fresh-pass' }, admin.cookie)).status).toBe(200);
      expect((await put(`${ADMIN}/employees/${otherAdmin.id}`, { full_name: 'Renamed' }, admin.cookie)).status).toBe(200);
      expect((await put(`${ADMIN}/employees/${supervisor.id}/status`, { is_active: false }, admin.cookie)).status).toBe(200);
    });
  });
});
