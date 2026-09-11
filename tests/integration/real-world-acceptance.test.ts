// @vitest-environment node
/**
 * Phase 7 regression guards.
 *
 * Every test here pins a defect that the automated suite passed straight
 * through and that only appeared when the application was driven for real:
 * a Worker under `wrangler dev`, a browser, and workbooks of the size a real
 * month actually produces. Each one was production-blocking.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { createTestR2, type TestR2Bucket } from '../helpers/r2.js';
import { buildMenuWorkbook, menuRow } from '../helpers/xlsxFixture.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

describe('Session middleware reaches the /api/auth router', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let employee: SeededEmployee;
  const PASSWORD = 'Original!2026';

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db, createTestR2());
    employee = await seedEmployee(db, { amcoId: 'TEST700' });
    await setEmployeePasswordDirect(db, employee.id, PASSWORD);
  });

  /**
   * Hono matches in registration order, so an `app.use()` added after a
   * `app.route()` never runs for that router. `sessionMiddleware` used to be
   * registered after `/api/auth` was mounted, so `c.get('employee')` was always
   * undefined there and these two endpoints answered 401 to a valid session.
   * The SPA restores its session from `/api/auth/me` on every page load, so a
   * reload, a bookmark or a typed URL logged the user straight back out, and
   * no employee could ever change their own password.
   */
  it('GET /api/auth/me accepts a valid session cookie', async () => {
    const res = await app.request(`${BASE}/api/auth/me`, { headers: { Cookie: employee.cookie } }, env);

    expect(res.status).toBe(200);
    const body = await readJson<{ success: boolean; data: { amco_id: string } }>(res);
    expect(body.success).toBe(true);
    expect(body.data.amco_id).toBe('TEST700');
  });

  it('GET /api/auth/me never returns a password hash or a session token', async () => {
    const res = await app.request(`${BASE}/api/auth/me`, { headers: { Cookie: employee.cookie } }, env);

    const raw = JSON.stringify(await readJson(res));
    expect(raw).not.toMatch(/password|pbkdf2|hash|token/i);
  });

  it('GET /api/auth/me still refuses an absent or unknown cookie', async () => {
    const anonymous = await app.request(`${BASE}/api/auth/me`, {}, env);
    expect(anonymous.status).toBe(401);

    const bogus = await app.request(
      `${BASE}/api/auth/me`,
      { headers: { Cookie: 'canteenhub_session=not-a-real-token' } },
      env
    );
    expect(bogus.status).toBe(401);
  });

  it('PUT /api/auth/change-password works for an authenticated employee', async () => {
    // The whole self-service password feature was unreachable: every call
    // returned 401 before it read the body.
    const res = await app.request(
      `${BASE}/api/auth/change-password`,
      {
        method: 'PUT',
        headers: { Cookie: employee.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: PASSWORD, new_password: 'Rotated!2026' }),
      },
      env
    );

    expect(res.status).toBe(200);

    const withNew = await app.request(
      `${BASE}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amco_id: 'TEST700', password: 'Rotated!2026' }),
      },
      env
    );
    expect(withNew.status).toBe(200);
  });

  it('login and logout keep working now that the middleware runs first', async () => {
    const login = await app.request(
      `${BASE}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amco_id: 'TEST700', password: PASSWORD }),
      },
      env
    );
    expect(login.status).toBe(200);

    // A stale cookie on the login request must not break it either.
    const withStaleCookie = await app.request(
      `${BASE}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'canteenhub_session=stale' },
        body: JSON.stringify({ amco_id: 'TEST700', password: PASSWORD }),
      },
      env
    );
    expect(withStaleCookie.status).toBe(200);

    const logout = await app.request(
      `${BASE}/api/auth/logout`,
      { method: 'POST', headers: { Cookie: employee.cookie } },
      env
    );
    expect(logout.status).toBe(200);

    const after = await app.request(`${BASE}/api/auth/me`, { headers: { Cookie: employee.cookie } }, env);
    expect(after.status).toBe(401);
  });
});

describe('Import validation survives a workbook of real size', () => {
  let db: TestD1Database;
  let bucket: TestR2Bucket;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    bucket = createTestR2();
    env = testEnv(db, bucket);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
  });

  const monthOfRows = (days: number) =>
    Array.from({ length: days }, (_, i) =>
      menuRow(`2027-05-${String(i + 1).padStart(2, '0')}`, `Main ${i + 1}A`, `Main ${i + 1}B`, {
        salad: 'Test Salad',
        beverage: 'Test Juice',
      })
    );

  const uploadAndValidate = async (days: number) => {
    const form = new FormData();
    form.set('import_type', 'menu');
    form.set('file', new File([buildMenuWorkbook(monthOfRows(days)) as unknown as BlobPart], 'menu.xlsx'));
    const upload = await app.request(
      `${BASE}/api/admin/imports`,
      { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
      env
    );
    expect(upload.status).toBe(201);
    const { id } = (await readJson<{ data: { id: number } }>(upload)).data;

    const validated = await app.request(
      `${BASE}/api/admin/imports/${id}/validate`,
      { method: 'POST', headers: { Cookie: admin.cookie } },
      env
    );
    return { id, validated };
  };

  /**
   * Staged rows are written as multi-row INSERTs. The chunk size was 50 ROWS,
   * chosen against D1's 50-queries-per-batch limit - but each row binds five
   * parameters and D1 also caps a statement at 100 bound parameters. Validation
   * therefore died with "too many SQL variables" at 21 rows, leaving the batch
   * stuck in `validating`. No workbook of real size could be imported at all:
   * not a 30-day menu, not any actual employee list, not any actual roster.
   */
  it('validates a full 31-day month rather than dying at 21 rows', async () => {
    const { validated } = await uploadAndValidate(31);

    expect(validated.status).toBe(200);
    const body = await readJson<{ data: { status: string; total_rows: number; valid_rows: number } }>(validated);
    expect(body.data.status).toBe('preview');
    expect(body.data.total_rows).toBe(31);
    expect(body.data.valid_rows).toBe(31);
  });

  it('stages every row, so the preview is complete and the batch is committable', async () => {
    const { id, validated } = await uploadAndValidate(31);
    expect(validated.status).toBe(200);

    const staged = await db
      .prepare('SELECT COUNT(*) AS n FROM import_batch_rows WHERE import_batch_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(staged?.n).toBe(31);

    const committed = await app.request(
      `${BASE}/api/admin/imports/${id}/commit`,
      { method: 'POST', headers: { Cookie: admin.cookie } },
      env
    );
    expect(committed.status).toBe(200);

    const days = await db.prepare('SELECT COUNT(*) AS n FROM menu_days').first<{ n: number }>();
    expect(days?.n).toBe(31);
  });

  it('re-validating replaces the staged rows instead of doubling them', async () => {
    const { id } = await uploadAndValidate(31);

    await app.request(
      `${BASE}/api/admin/imports/${id}/validate`,
      { method: 'POST', headers: { Cookie: admin.cookie } },
      env
    );

    const staged = await db
      .prepare('SELECT COUNT(*) AS n FROM import_batch_rows WHERE import_batch_id = ?')
      .bind(id)
      .first<{ n: number }>();
    expect(staged?.n).toBe(31);
  });
});

describe('Action buttons cannot push the page sideways', () => {
  const css = readFileSync(path.join(root, 'src/index.css'), 'utf8');

  /**
   * `.button` sets `width: 100%` for the stacked mobile layout. At >= 40rem the
   * action groups switch to `flex: 0 0 auto`, which resolves flex-basis from
   * that width AND forbids shrinking - so each button claimed a full row. A
   * menu day card has three (Edit / Archive / Publish), which pushed the
   * document to 2931px inside a 1440px viewport. Measured in Chromium at 768,
   * 1024 and 1440; mobile was unaffected because the base `flex: 1` still
   * shrinks. Pinned in CSS because no browser runner is configured - see
   * docs/E2E-STATUS.md.
   */
  it('resets the mobile full-width rule when the action row stops shrinking', () => {
    const rule = css
      .split('\n')
      .find((line) => line.includes('.panel__actions .button') && line.includes('flex: 0 0 auto'));

    expect(rule, 'the >=40rem action-button rule should exist').toBeDefined();
    expect(rule).toContain('width: auto');
  });

  it('still lets the buttons shrink on a narrow screen', () => {
    expect(css).toMatch(/\.panel__actions \.button \{ flex: 1; \}/);
  });
});

/**
 * Brute-force protection on the login endpoint.
 *
 * The Phase 8 audit found this security control had no test at all: the only
 * reference to `login_attempts` anywhere under tests/ was the maintenance cron
 * purging it. The limiter works - five failures lock the account for fifteen
 * minutes, and a correct password is refused while it holds - but nothing
 * stopped a refactor from removing it silently, which is exactly how the three
 * Phase 7 defects survived a green suite.
 */
describe('Login rate limiting', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  const PASSWORD = 'Correct!2026';
  const IP = '203.0.113.7';

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db, createTestR2());
    const employee = await seedEmployee(db, { amcoId: 'TEST600' });
    await setEmployeePasswordDirect(db, employee.id, PASSWORD);
  });

  const login = (
    password: string,
    { amcoId = 'TEST600', ip = IP }: { amcoId?: string; ip?: string } = {}
  ) =>
    app.request(
      `${BASE}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ amco_id: amcoId, password }),
      },
      env
    );

  it('allows five failures and locks the sixth', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await login('wrong-password');
      expect(res.status, `attempt ${attempt} should still be a plain refusal`).toBe(401);
    }

    const locked = await login('wrong-password');
    expect(locked.status).toBe(429);
  });

  it('refuses the CORRECT password while the lockout holds', async () => {
    // The point of a lockout: guessing does not become cheaper by eventually
    // guessing right.
    for (let attempt = 0; attempt < 5; attempt += 1) await login('wrong-password');

    const res = await login(PASSWORD);
    expect(res.status).toBe(429);
  });

  it('says how long to wait, and leaks nothing about the account', async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) await login('wrong-password');

    const body = await readJson<{ error: string }>(await login('wrong-password'));
    expect(body.error).toMatch(/too many failed login attempts/i);
    expect(body.error).toMatch(/minute/i);
    expect(body.error).not.toMatch(/hash|pbkdf2|sql|TEST600/i);
  });

  it('scopes the lockout to one IP, so nobody can lock a colleague out', async () => {
    for (let attempt = 0; attempt < 6; attempt += 1) await login('wrong-password', { ip: IP });
    expect((await login(PASSWORD, { ip: IP })).status).toBe(429);

    // The same account from a different address is unaffected.
    const elsewhere = await login(PASSWORD, { ip: '198.51.100.22' });
    expect(elsewhere.status).toBe(200);
  });

  it('scopes the lockout to one account, so one victim does not lock the office out', async () => {
    const other = await seedEmployee(db, { amcoId: 'TEST601' });
    await setEmployeePasswordDirect(db, other.id, PASSWORD);

    for (let attempt = 0; attempt < 6; attempt += 1) await login('wrong-password');

    const otherAccount = await login(PASSWORD, { amcoId: 'TEST601' });
    expect(otherAccount.status).toBe(200);
  });

  it('records an attempt for an unknown AMCO ID without revealing it is unknown', async () => {
    const res = await login('anything', { amcoId: 'NOSUCHID' });

    expect(res.status).toBe(401);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toBe('Invalid credentials');

    // Enumeration must cost the same as guessing a real account's password.
    const recorded = await db
      .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE identifier = ?')
      .bind(`${IP}:NOSUCHID`)
      .first<{ n: number }>();
    expect(recorded?.n).toBe(1);
  });

  it('does not lock an account out on successful logins', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await login(PASSWORD)).status).toBe(200);
    }
  });
});
