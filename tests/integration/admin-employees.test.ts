// @vitest-environment node
/**
 * Integration Tests - Admin employee management and administrative passwords
 *
 * Real Hono routing through app.request(), real SQL, real password hashing and
 * real session rows. All fixtures are synthetic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  countSessions,
  countRows,
  jsonRequest,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const GOOD_PASSWORD = 'correct-horse-battery';
const NEW_PASSWORD = 'a-different-long-secret';

describe('Admin employee management', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN, fullName: 'Test Admin' });
    employee = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
  });

  const login = (amcoId: string, password: string) =>
    app.request(`${BASE}/api/auth/login`, jsonRequest({ amco_id: amcoId, password }), env);

  // ==========================================================================
  // EMPLOYEE CRUD
  // ==========================================================================

  describe('create', () => {
    it('1. admin creates an employee', async () => {
      const res = await app.request(
        `${BASE}/api/admin/employees`,
        jsonRequest(
          { amco_id: 'TEST100', full_name: 'New Person', department: 'Mining', section: 'Ops', roster_type: 'shift' },
          admin.cookie
        ),
        env
      );

      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.success).toBe(true);
      expect(body.data.amco_id).toBe('TEST100');
      expect(body.data.roster_type).toBe('shift');
      expect(await countRows(db, "SELECT COUNT(*) as n FROM employees WHERE amco_id = 'TEST100'")).toBe(1);
    });

    it('2. a created employee can log in once a password is set', async () => {
      const created = await app.request(
        `${BASE}/api/admin/employees`,
        jsonRequest({ amco_id: 'TEST100', full_name: 'New Person', roster_type: 'regular' }, admin.cookie),
        env
      );
      const newId = (await readJson(created)).data.id;

      // A newly created employee has no password and cannot log in yet.
      const beforePassword = await login('TEST100', GOOD_PASSWORD);
      expect(beforePassword.status).toBe(401);

      const set = await app.request(
        `${BASE}/api/admin/employees/${newId}/password`,
        { ...jsonRequest({ password: GOOD_PASSWORD }, admin.cookie), method: 'PUT' },
        env
      );
      expect(set.status).toBe(200);

      const afterPassword = await login('TEST100', GOOD_PASSWORD);
      expect(afterPassword.status).toBe(200);
      expect((await readJson(afterPassword)).success).toBe(true);
    });

    it('rejects a duplicate amco_id', async () => {
      const res = await app.request(
        `${BASE}/api/admin/employees`,
        jsonRequest({ amco_id: 'TEST001', full_name: 'Clash', roster_type: 'regular' }, admin.cookie),
        env
      );
      expect(res.status).toBe(409);
    });

    it('rejects an invalid roster_type', async () => {
      const res = await app.request(
        `${BASE}/api/admin/employees`,
        jsonRequest({ amco_id: 'TEST101', full_name: 'Bad Roster', roster_type: 'contractor' }, admin.cookie),
        env
      );
      expect(res.status).toBe(400);
    });

    it('never returns password_hash', async () => {
      const res = await app.request(
        `${BASE}/api/admin/employees`,
        jsonRequest({ amco_id: 'TEST102', full_name: 'No Hash', roster_type: 'regular' }, admin.cookie),
        env
      );
      expect(JSON.stringify(await readJson(res))).not.toContain('password_hash');
    });
  });

  describe('list and search', () => {
    it('admin can list employees', async () => {
      const res = await app.request(`${BASE}/api/admin/employees`, { headers: { Cookie: admin.cookie } }, env);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.data.total).toBe(2);
      expect(body.data.employees).toHaveLength(2);
    });

    it('admin can search employees by name', async () => {
      await seedEmployee(db, { amcoId: 'TEST200', fullName: 'Distinctive Name' });
      const res = await app.request(
        `${BASE}/api/admin/employees?search=Distinctive`,
        { headers: { Cookie: admin.cookie } },
        env
      );
      const body = await readJson(res);
      expect(body.data.total).toBe(1);
      expect(body.data.employees[0].amco_id).toBe('TEST200');
    });

    it('admin can filter by roster_type and is_active', async () => {
      await seedEmployee(db, { amcoId: 'TEST201', rosterType: 'amman_hq' });
      const byType = await readJson(
        await app.request(`${BASE}/api/admin/employees?roster_type=amman_hq`, { headers: { Cookie: admin.cookie } }, env)
      );
      expect(byType.data.total).toBe(1);

      await seedEmployee(db, { amcoId: 'TEST202', isActive: false });
      const inactive = await readJson(
        await app.request(`${BASE}/api/admin/employees?is_active=false`, { headers: { Cookie: admin.cookie } }, env)
      );
      expect(inactive.data.total).toBe(1);
      expect(inactive.data.employees[0].amco_id).toBe('TEST202');
    });

    it('the employee list never leaks password_hash', async () => {
      await setEmployeePasswordDirect(db, employee.id, GOOD_PASSWORD);
      const res = await app.request(`${BASE}/api/admin/employees`, { headers: { Cookie: admin.cookie } }, env);
      expect(JSON.stringify(await readJson(res))).not.toContain('password_hash');
    });
  });

  describe('update', () => {
    it('3. admin updates employee information', async () => {
      const res = await app.request(
        `${BASE}/api/admin/employees/${employee.id}`,
        { ...jsonRequest({ full_name: 'Renamed Person', department: 'HSE' }, admin.cookie), method: 'PUT' },
        env
      );

      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.data.full_name).toBe('Renamed Person');
      expect(body.data.department).toBe('HSE');
    });

    it('directs is_active changes to the dedicated status endpoint', async () => {
      const res = await app.request(
        `${BASE}/api/admin/employees/${employee.id}`,
        { ...jsonRequest({ is_active: false }, admin.cookie), method: 'PUT' },
        env
      );
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toContain('/status');
    });

    it('returns 404 for an unknown employee', async () => {
      const res = await app.request(
        `${BASE}/api/admin/employees/999999`,
        { ...jsonRequest({ full_name: 'Ghost' }, admin.cookie), method: 'PUT' },
        env
      );
      expect(res.status).toBe(404);
    });
  });

  describe('activate / deactivate', () => {
    it('4. admin deactivates and reactivates an employee', async () => {
      const off = await app.request(
        `${BASE}/api/admin/employees/${employee.id}/status`,
        { ...jsonRequest({ is_active: false }, admin.cookie), method: 'PUT' },
        env
      );
      expect(off.status).toBe(200);
      expect((await readJson(off)).data.is_active).toBeFalsy();

      const on = await app.request(
        `${BASE}/api/admin/employees/${employee.id}/status`,
        { ...jsonRequest({ is_active: true }, admin.cookie), method: 'PUT' },
        env
      );
      expect(on.status).toBe(200);
      expect((await readJson(on)).data.is_active).toBeTruthy();
    });

    it('deactivation revokes the employee sessions immediately', async () => {
      expect(await countSessions(db, employee.id)).toBe(1);

      await app.request(
        `${BASE}/api/admin/employees/${employee.id}/status`,
        { ...jsonRequest({ is_active: false }, admin.cookie), method: 'PUT' },
        env
      );

      expect(await countSessions(db, employee.id)).toBe(0);
    });
  });

  describe('5. authorization', () => {
    it('a non-admin employee cannot list employees', async () => {
      const res = await app.request(`${BASE}/api/admin/employees`, { headers: { Cookie: employee.cookie } }, env);
      expect(res.status).toBe(403);
    });

    it('a non-admin employee cannot create an employee', async () => {
      const res = await app.request(
        `${BASE}/api/admin/employees`,
        jsonRequest({ amco_id: 'TEST300', full_name: 'Nope', roster_type: 'regular' }, employee.cookie),
        env
      );
      expect(res.status).toBe(403);
      expect(await countRows(db, "SELECT COUNT(*) as n FROM employees WHERE amco_id = 'TEST300'")).toBe(0);
    });

    it('a non-admin employee cannot update or deactivate anyone', async () => {
      const update = await app.request(
        `${BASE}/api/admin/employees/${admin.id}`,
        { ...jsonRequest({ full_name: 'Hijacked' }, employee.cookie), method: 'PUT' },
        env
      );
      expect(update.status).toBe(403);

      const status = await app.request(
        `${BASE}/api/admin/employees/${admin.id}/status`,
        { ...jsonRequest({ is_active: false }, employee.cookie), method: 'PUT' },
        env
      );
      expect(status.status).toBe(403);
    });

    it('an unauthenticated caller is rejected with 401', async () => {
      const res = await app.request(`${BASE}/api/admin/employees`, {}, env);
      expect(res.status).toBe(401);
    });
  });

  // ==========================================================================
  // ADMIN-SET PASSWORD
  // ==========================================================================

  describe('administrative password setting', () => {
    beforeEach(async () => {
      await setEmployeePasswordDirect(db, employee.id, GOOD_PASSWORD);
    });

    const setPassword = (targetId: number, password: unknown, cookie: string) =>
      app.request(
        `${BASE}/api/admin/employees/${targetId}/password`,
        { ...jsonRequest({ password }, cookie), method: 'PUT' },
        env
      );

    it('6. admin sets an employee password', async () => {
      const res = await setPassword(employee.id, NEW_PASSWORD, admin.cookie);
      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.success).toBe(true);
      expect(body.data.password_set).toBe(true);
    });

    it('7. the old password no longer works', async () => {
      expect((await login(employee.amcoId, GOOD_PASSWORD)).status).toBe(200);

      await setPassword(employee.id, NEW_PASSWORD, admin.cookie);

      const res = await login(employee.amcoId, GOOD_PASSWORD);
      expect(res.status).toBe(401);
    });

    it('8. the new password works', async () => {
      await setPassword(employee.id, NEW_PASSWORD, admin.cookie);

      const res = await login(employee.amcoId, NEW_PASSWORD);
      expect(res.status).toBe(200);
      expect((await readJson(res)).success).toBe(true);
    });

    it('9. all existing sessions for that employee are invalidated', async () => {
      expect(await countSessions(db, employee.id)).toBe(1);

      const before = await app.request(
        `${BASE}/api/roster/me`,
        { headers: { Cookie: employee.cookie } },
        env
      );
      expect(before.status).toBe(200);

      const res = await setPassword(employee.id, NEW_PASSWORD, admin.cookie);
      expect((await readJson(res)).data.sessionsRevoked).toBe(1);
      expect(await countSessions(db, employee.id)).toBe(0);

      // The previously working cookie is now dead at the HTTP layer.
      const after = await app.request(
        `${BASE}/api/roster/me`,
        { headers: { Cookie: employee.cookie } },
        env
      );
      expect(after.status).toBe(401);
    });

    it('the acting admin’s own session survives', async () => {
      await setPassword(employee.id, NEW_PASSWORD, admin.cookie);
      expect(await countSessions(db, admin.id)).toBe(1);
    });

    it('10. the plaintext password is absent from every audit record', async () => {
      await setPassword(employee.id, NEW_PASSWORD, admin.cookie);

      const audit = await db.prepare('SELECT * FROM audit_log').all<Record<string, unknown>>();
      const serialised = JSON.stringify(audit.results);

      expect(serialised).not.toContain(NEW_PASSWORD);
      expect(serialised).not.toContain(GOOD_PASSWORD);
      // Nor is the derived hash written into the trail.
      expect(serialised).not.toContain('pbkdf2');
      expect(serialised).not.toContain('password_hash');
    });

    it('11. the plaintext password is absent from the API response', async () => {
      const res = await setPassword(employee.id, NEW_PASSWORD, admin.cookie);
      const raw = JSON.stringify(await readJson(res));

      expect(raw).not.toContain(NEW_PASSWORD);
      expect(raw).not.toContain('pbkdf2');
      expect(raw).not.toContain('password_hash');
    });

    it('the stored hash is not the plaintext', async () => {
      await setPassword(employee.id, NEW_PASSWORD, admin.cookie);

      const row = await db
        .prepare('SELECT password_hash FROM employees WHERE id = ?')
        .bind(employee.id)
        .first<{ password_hash: string }>();

      expect(row!.password_hash).not.toContain(NEW_PASSWORD);
      // Uses the EXISTING hashing scheme, not a second one.
      expect(row!.password_hash.startsWith('$pbkdf2-sha256$100000$')).toBe(true);
    });

    it('12. a non-admin cannot set anyone’s password', async () => {
      const res = await setPassword(admin.id, NEW_PASSWORD, employee.cookie);
      expect(res.status).toBe(403);

      // And the admin's password is untouched, so their session still works.
      expect(await countSessions(db, admin.id)).toBe(1);
    });

    it('a non-admin cannot even set their OWN password through the admin route', async () => {
      const res = await setPassword(employee.id, NEW_PASSWORD, employee.cookie);
      expect(res.status).toBe(403);
    });

    it('an unauthenticated caller cannot set a password', async () => {
      const res = await app.request(
        `${BASE}/api/admin/employees/${employee.id}/password`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: NEW_PASSWORD }) },
        env
      );
      expect(res.status).toBe(401);
    });

    it('rejects a password that is too short, without echoing it', async () => {
      const res = await setPassword(employee.id, 'short', admin.cookie);
      expect(res.status).toBe(400);
      const body = await readJson(res);
      expect(body.error).toContain('at least');
      expect(JSON.stringify(body)).not.toContain('short');
    });

    it('rejects an obviously guessable password', async () => {
      const res = await setPassword(employee.id, 'password123', admin.cookie);
      expect(res.status).toBe(400);
    });

    it('rejects a missing password field', async () => {
      const res = await setPassword(employee.id, undefined, admin.cookie);
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown employee', async () => {
      const res = await setPassword(999999, NEW_PASSWORD, admin.cookie);
      expect(res.status).toBe(404);
    });
  });

  // ==========================================================================
  // AUDIT
  // ==========================================================================

  describe('audit', () => {
    it('25. employee creation is audited', async () => {
      await app.request(
        `${BASE}/api/admin/employees`,
        jsonRequest({ amco_id: 'TEST400', full_name: 'Audited Person', roster_type: 'regular' }, admin.cookie),
        env
      );

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'CREATE_EMPLOYEE'")
        .all<{ actor_id: number; entity_id: number; before_json: string | null; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(audit.results[0].before_json).toBeNull();
      expect(JSON.parse(audit.results[0].after_json).amco_id).toBe('TEST400');
    });

    it('26. employee update is audited with before and after', async () => {
      await app.request(
        `${BASE}/api/admin/employees/${employee.id}`,
        { ...jsonRequest({ full_name: 'Renamed Person' }, admin.cookie), method: 'PUT' },
        env
      );

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'UPDATE_EMPLOYEE'")
        .all<{ actor_id: number; before_json: string; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(JSON.parse(audit.results[0].before_json).full_name).toBe('Test TEST001');
      expect(JSON.parse(audit.results[0].after_json).full_name).toBe('Renamed Person');
    });

    it('deactivation is audited with its own action', async () => {
      await app.request(
        `${BASE}/api/admin/employees/${employee.id}/status`,
        { ...jsonRequest({ is_active: false }, admin.cookie), method: 'PUT' },
        env
      );

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'DEACTIVATE_EMPLOYEE'")
        .all<{ actor_id: number; entity_id: number }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].entity_id).toBe(employee.id);
    });

    it('27. the password change is audited, naming actor and target', async () => {
      await setEmployeePasswordDirect(db, employee.id, GOOD_PASSWORD);
      await app.request(
        `${BASE}/api/admin/employees/${employee.id}/password`,
        { ...jsonRequest({ password: NEW_PASSWORD }, admin.cookie), method: 'PUT' },
        env
      );

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'ADMIN_SET_EMPLOYEE_PASSWORD'")
        .all<{ actor_id: number; entity_id: number; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(audit.results[0].entity_id).toBe(employee.id);

      const after = JSON.parse(audit.results[0].after_json);
      expect(after.amco_id).toBe(employee.amcoId);
      expect(after.password_changed).toBe(true);
      expect(after.sessions_revoked).toBe(1);
    });

    it('a rejected admin action writes no audit record', async () => {
      await app.request(
        `${BASE}/api/admin/employees`,
        jsonRequest({ amco_id: 'TEST500', full_name: 'Denied', roster_type: 'regular' }, employee.cookie),
        env
      );

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(0);
    });
  });
});
