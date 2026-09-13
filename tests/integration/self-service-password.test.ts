// @vitest-environment node
/**
 * Integration Tests - changing your own password, and the password policy.
 *
 * Real Hono routes, real SQL against the real migrations, real PBKDF2 hashing
 * and real opaque sessions. Every password below is invented for tests.
 *
 * The properties under test are the ones that make this endpoint safe: the
 * account comes from the SESSION and not from client input, the current
 * password is verified against the stored hash server-side, every session is
 * revoked afterwards, and no plaintext ever leaves the process.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  countRows,
  readJson,
  ROLE_ADMIN,
  ROLE_EMPLOYEE,
  type SeededEmployee,
} from '../helpers/fixtures.js';
import { MIN_PASSWORD_LENGTH, validatePassword } from '../../src/worker/lib/password.js';
import { MIN_PASSWORD_LENGTH as UI_MIN } from '../../src/frontend/lib/passwordPolicy.js';

const BASE = 'http://localhost';
const CHANGE = `${BASE}/api/auth/change-password`;

const ADMIN_PASSWORD = 'AdminStart!2027';
const EMPLOYEE_PASSWORD = 'StaffStart!2027';
const OTHER_PASSWORD = 'OtherStart!2027';

describe('Self-service password change', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;
  let other: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST700', roleId: ROLE_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST701', roleId: ROLE_EMPLOYEE });
    other = await seedEmployee(db, { amcoId: 'TEST702', roleId: ROLE_EMPLOYEE });
    await setEmployeePasswordDirect(db, admin.id, ADMIN_PASSWORD);
    await setEmployeePasswordDirect(db, employee.id, EMPLOYEE_PASSWORD);
    await setEmployeePasswordDirect(db, other.id, OTHER_PASSWORD);
  });

  const change = (
    cookie: string | null,
    body: Record<string, unknown>,
    ip = '203.0.113.9'
  ) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
    };
    if (cookie) headers.Cookie = cookie;
    return app.request(CHANGE, { method: 'PUT', headers, body: JSON.stringify(body) }, env);
  };

  const login = (amcoId: string, password: string) =>
    app.request(
      `${BASE}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify({ amco_id: amcoId, password }),
      },
      env
    );

  const sessionsFor = (id: number) =>
    countRows(db, `SELECT COUNT(*) as n FROM sessions WHERE employee_id = ${id}`);

  const good = (current: string, next: string) => ({
    current_password: current,
    new_password: next,
    confirm_password: next,
  });

  // ==========================================================================
  // 1-3. Authentication and authorization
  // ==========================================================================

  it('1. anonymous request is rejected with 401', async () => {
    const res = await change(null, good(ADMIN_PASSWORD, 'Anon!2027'));
    expect(res.status).toBe(401);
    // And nothing changed: the old password still works.
    expect((await login('TEST700', ADMIN_PASSWORD)).status).toBe(200);
  });

  it('1b. an invalid session cookie is rejected with 401', async () => {
    const res = await change('canteenhub_session=not-a-real-token', good(ADMIN_PASSWORD, 'Fake!2027'));
    expect(res.status).toBe(401);
  });

  it('2. a non-admin employee MAY change their own password (not an admin-only endpoint)', async () => {
    // Deliberate: an employee handed a password in person must be able to
    // replace it with one only they know. Authorization is "your own account",
    // which the session guarantees - not a role check.
    const res = await change(employee.cookie, good(EMPLOYEE_PASSWORD, 'Staff!2027'));
    expect(res.status).toBe(200);
    expect((await login('TEST701', 'Staff!2027')).status).toBe(200);
  });

  it('3. an authenticated admin is allowed', async () => {
    const res = await change(admin.cookie, good(ADMIN_PASSWORD, 'AdminNext!2027'));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.success).toBe(true);
    expect(body.data.password_changed).toBe(true);
  });

  // ==========================================================================
  // 4-5. Current-password verification
  // ==========================================================================

  it('4. a wrong current password is rejected with 401 and changes nothing', async () => {
    const res = await change(admin.cookie, good('NotMyPassword!2027', 'Rejected!2027'));
    expect(res.status).toBe(401);
    expect(JSON.stringify(await readJson(res))).toContain('Current password is incorrect');

    expect((await login('TEST700', ADMIN_PASSWORD)).status).toBe(200);
    expect((await login('TEST700', 'Rejected!2027')).status).toBe(401);
  });

  it('4b. an account with NO password set cannot use this route', async () => {
    const fresh = await seedEmployee(db, { amcoId: 'TEST703', roleId: ROLE_ADMIN });
    const res = await change(fresh.cookie, good('anything', 'Something!2027'));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await readJson(res))).toContain('Cannot change password');
  });

  it('5. the correct current password is accepted', async () => {
    expect((await change(admin.cookie, good(ADMIN_PASSWORD, 'Correct!2027'))).status).toBe(200);
  });

  // ==========================================================================
  // 6-8. The 5-character boundary
  // ==========================================================================

  it('6. a 4-character new password is REJECTED', async () => {
    const res = await change(admin.cookie, good(ADMIN_PASSWORD, 'abcd'));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await readJson(res))).toContain('at least 5 characters');
    expect((await login('TEST700', ADMIN_PASSWORD)).status).toBe(200);
  });

  it('7. a 5-character new password is ACCEPTED', async () => {
    const res = await change(admin.cookie, good(ADMIN_PASSWORD, 'abcde'));
    expect(res.status).toBe(200);
    expect((await login('TEST700', 'abcde')).status).toBe(200);
  });

  it('8. a 6-character new password is ACCEPTED', async () => {
    const res = await change(admin.cookie, good(ADMIN_PASSWORD, 'abcdef'));
    expect(res.status).toBe(200);
    expect((await login('TEST700', 'abcdef')).status).toBe(200);
  });

  // ==========================================================================
  // 9-10. Confirmation and difference
  // ==========================================================================

  it('9. a confirmation mismatch is rejected', async () => {
    const res = await change(admin.cookie, {
      current_password: ADMIN_PASSWORD,
      new_password: 'Mismatch!2027',
      confirm_password: 'Mismatch!2028',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await readJson(res))).toContain('do not match');
    expect((await login('TEST700', ADMIN_PASSWORD)).status).toBe(200);
  });

  it('9b. a missing confirmation is rejected - the check is server-side, not only in the UI', async () => {
    const res = await change(admin.cookie, {
      current_password: ADMIN_PASSWORD,
      new_password: 'NoConfirm!2027',
    });
    expect(res.status).toBe(400);
    expect((await login('TEST700', ADMIN_PASSWORD)).status).toBe(200);
  });

  it('10. a new password equal to the current one is rejected', async () => {
    const res = await change(admin.cookie, good(ADMIN_PASSWORD, ADMIN_PASSWORD));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await readJson(res))).toContain('different');
    expect((await login('TEST700', ADMIN_PASSWORD)).status).toBe(200);
  });

  it('10b. a missing current password is rejected before anything is read', async () => {
    const res = await change(admin.cookie, { new_password: 'X!2027abc', confirm_password: 'X!2027abc' });
    expect(res.status).toBe(400);
  });

  // ==========================================================================
  // 11-13. The change itself
  // ==========================================================================

  it('11. a successful change reports success without echoing anything secret', async () => {
    const res = await change(admin.cookie, good(ADMIN_PASSWORD, 'Fresh!2027'));
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.data).toMatchObject({ password_changed: true });
    expect(typeof body.data.sessionsRevoked).toBe('number');
  });

  it('12. the OLD password fails afterwards', async () => {
    await change(admin.cookie, good(ADMIN_PASSWORD, 'Fresh!2027'));
    const res = await login('TEST700', ADMIN_PASSWORD);
    expect(res.status).toBe(401);
  });

  it('13. the NEW password succeeds afterwards', async () => {
    await change(admin.cookie, good(ADMIN_PASSWORD, 'Fresh!2027'));
    const res = await login('TEST700', 'Fresh!2027');
    expect(res.status).toBe(200);
  });

  it('13b. the stored hash actually changed, and no plaintext was stored', async () => {
    const before = await db
      .prepare('SELECT password_hash FROM employees WHERE id = ?')
      .bind(admin.id)
      .first<{ password_hash: string }>();

    await change(admin.cookie, good(ADMIN_PASSWORD, 'Fresh!2027'));

    const after = await db
      .prepare('SELECT password_hash FROM employees WHERE id = ?')
      .bind(admin.id)
      .first<{ password_hash: string }>();

    expect(after!.password_hash).not.toBe(before!.password_hash);
    // The existing scheme, unchanged: PBKDF2-SHA-256 at 100k iterations.
    expect(after!.password_hash).toMatch(/^\$pbkdf2-sha256\$100000\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(after!.password_hash).not.toContain('Fresh!2027');
  });

  // ==========================================================================
  // 14-15. Sessions and isolation
  // ==========================================================================

  it('14. EVERY session for the user is invalidated, including the calling one', async () => {
    // A second, independent session for the same user.
    const second = await login('TEST700', ADMIN_PASSWORD);
    expect(second.status).toBe(200);
    expect(await sessionsFor(admin.id)).toBeGreaterThanOrEqual(2);

    const res = await change(admin.cookie, good(ADMIN_PASSWORD, 'Fresh!2027'));
    expect((await readJson(res)).data.sessionsRevoked).toBeGreaterThanOrEqual(2);
    expect(await sessionsFor(admin.id)).toBe(0);

    // The caller's own cookie no longer authenticates.
    const me = await app.request(
      `${BASE}/api/auth/me`,
      { headers: { Cookie: admin.cookie } },
      env
    );
    expect(me.status).toBe(401);
  });

  it('15. another user is completely unaffected', async () => {
    const otherSessionsBefore = await sessionsFor(other.id);
    const otherHashBefore = await db
      .prepare('SELECT password_hash FROM employees WHERE id = ?')
      .bind(other.id)
      .first<{ password_hash: string }>();

    await change(admin.cookie, good(ADMIN_PASSWORD, 'Fresh!2027'));

    expect(await sessionsFor(other.id)).toBe(otherSessionsBefore);
    const otherHashAfter = await db
      .prepare('SELECT password_hash FROM employees WHERE id = ?')
      .bind(other.id)
      .first<{ password_hash: string }>();
    expect(otherHashAfter!.password_hash).toBe(otherHashBefore!.password_hash);
    expect((await login('TEST702', OTHER_PASSWORD)).status).toBe(200);
  });

  it('15b. the account changed comes from the SESSION, never from the body', async () => {
    // Every id-shaped field an attacker might hope is honoured.
    const res = await change(employee.cookie, {
      ...good(EMPLOYEE_PASSWORD, 'Staff!2027'),
      employee_id: admin.id,
      id: admin.id,
      amco_id: 'TEST700',
    });
    expect(res.status).toBe(200);

    // The admin is untouched; only the caller's own password moved.
    expect((await login('TEST700', ADMIN_PASSWORD)).status).toBe(200);
    expect((await login('TEST701', 'Staff!2027')).status).toBe(200);
  });

  // ==========================================================================
  // 16. The administrative path still works
  // ==========================================================================

  it('16. an administrator can still set an employee password', async () => {
    const res = await app.request(
      `${BASE}/api/admin/employees/${employee.id}/password`,
      {
        method: 'PUT',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'AdminSet!2027' }),
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.data.password_set).toBe(true);
    expect((await login('TEST701', 'AdminSet!2027')).status).toBe(200);
  });

  it('16b. the administrative path is still admin-only', async () => {
    const res = await app.request(
      `${BASE}/api/admin/employees/${other.id}/password`,
      {
        method: 'PUT',
        headers: { Cookie: employee.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'Sneaky!2027' }),
      },
      env
    );
    expect(res.status).toBe(403);
    expect((await login('TEST702', OTHER_PASSWORD)).status).toBe(200);
  });

  // ==========================================================================
  // 17. No plaintext anywhere
  // ==========================================================================

  it('17. no plaintext password appears in the response, the audit row, or the console', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await change(admin.cookie, good(ADMIN_PASSWORD, 'Secret!2027'));
    const raw = JSON.stringify(await readJson(res));

    expect(raw).not.toContain('Secret!2027');
    expect(raw).not.toContain(ADMIN_PASSWORD);
    expect(raw.toLowerCase()).not.toContain('hash');

    const audit = await db
      .prepare("SELECT * FROM audit_log WHERE action = 'CHANGE_OWN_PASSWORD'")
      .all<Record<string, unknown>>();
    const auditRaw = JSON.stringify(audit.results);
    expect(auditRaw).not.toContain('Secret!2027');
    expect(auditRaw).not.toContain(ADMIN_PASSWORD);
    expect(auditRaw.toLowerCase()).not.toContain('password_hash');

    const console_ = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().join(' ');
    expect(console_).not.toContain('Secret!2027');
    expect(console_).not.toContain(ADMIN_PASSWORD);
  });

  it('17b. the audit row records the event, the actor and the session count', async () => {
    await change(admin.cookie, good(ADMIN_PASSWORD, 'Audited!2027'));

    const row = await db
      .prepare("SELECT * FROM audit_log WHERE action = 'CHANGE_OWN_PASSWORD'")
      .first<{ actor_id: number; entity_type: string; entity_id: number; after_json: string }>();

    expect(row).not.toBeNull();
    expect(row!.actor_id).toBe(admin.id);
    expect(row!.entity_type).toBe('EMPLOYEE');
    expect(row!.entity_id).toBe(admin.id);
    const after = JSON.parse(row!.after_json) as Record<string, unknown>;
    expect(after).toMatchObject({ employee_id: admin.id, amco_id: 'TEST700', password_changed: true });
    expect(Object.keys(after).join(' ').toLowerCase()).not.toContain('hash');
  });

  it('17c. a REJECTED attempt writes no audit row at all', async () => {
    await change(admin.cookie, good('WrongCurrent!2027', 'Nope!2027'));
    expect(
      await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'CHANGE_OWN_PASSWORD'")
    ).toBe(0);
  });

  it('17d. the administrative path keeps its own distinct audit action', async () => {
    await app.request(
      `${BASE}/api/admin/employees/${employee.id}/password`,
      {
        method: 'PUT',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'AdminSet!2027' }),
      },
      env
    );
    expect(
      await countRows(
        db,
        "SELECT COUNT(*) as n FROM audit_log WHERE action = 'ADMIN_SET_EMPLOYEE_PASSWORD'"
      )
    ).toBe(1);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });
});

// ============================================================================
// 18. ONE policy, enforced on EVERY path
// ============================================================================

describe('Password policy is shared by every path', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST800', roleId: ROLE_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST801', roleId: ROLE_EMPLOYEE });
    await setEmployeePasswordDirect(db, admin.id, ADMIN_PASSWORD);
  });

  it('the shared constant is 5', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(5);
  });

  it('the validator enforces the boundary directly', () => {
    expect(validatePassword('abcd').valid).toBe(false);
    expect(validatePassword('abcde').valid).toBe(true);
    expect(validatePassword('abcdef').valid).toBe(true);
  });

  it('the UI constant matches the server constant, so the two cannot drift', () => {
    expect(UI_MIN).toBe(MIN_PASSWORD_LENGTH);
  });

  it('the ADMIN path enforces the same boundary: 4 rejected, 5 and 6 accepted', async () => {
    const set = (password: string) =>
      app.request(
        `${BASE}/api/admin/employees/${employee.id}/password`,
        {
          method: 'PUT',
          headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        },
        env
      );

    expect((await set('abcd')).status).toBe(400);
    expect((await set('abcde')).status).toBe(200);
    expect((await set('abcdef')).status).toBe(200);
  });

  it('the SELF-SERVICE path enforces the same boundary', async () => {
    const change = (next: string, current: string) =>
      app.request(
        CHANGE,
        {
          method: 'PUT',
          headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            current_password: current,
            new_password: next,
            confirm_password: next,
          }),
        },
        env
      );

    expect((await change('abcd', ADMIN_PASSWORD)).status).toBe(400);
    expect((await change('abcde', ADMIN_PASSWORD)).status).toBe(200);
  });

  it('NO password-setting route carries its own length check', () => {
    // The regression that made this necessary: change-password held a
    // hard-coded `< 8` that disagreed with the policy module for years.
    const sources = [
      'src/worker/routes/auth.ts',
      'src/worker/routes/admin.ts',
    ];
    for (const file of sources) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(text, `${file} must not hard-code a password length`).not.toMatch(
        /(new_?)?password[^\n]*\.length\s*[<>]=?\s*\d+/i
      );
    }
  });

  it('every password-setting route validates through the shared module', () => {
    for (const file of ['src/worker/routes/auth.ts', 'src/worker/routes/admin.ts']) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(text, `${file} must call validatePassword`).toContain('validatePassword(');
    }
  });
});

import { readFileSync } from 'node:fs';
