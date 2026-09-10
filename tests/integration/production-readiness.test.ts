// @vitest-environment node
/**
 * Production readiness guards.
 *
 * These test deployment CONFIGURATION and operational behaviour, which no
 * feature test covers: a misconfigured binding is invisible until the first
 * production request, and by then every request is failing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { createTestR2 } from '../helpers/r2.js';
import { testEnv, seedEmployee, setEmployeePasswordDirect, countRows, readJson, ROLE_ADMIN, type SeededEmployee } from '../helpers/fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const wrangler = readFileSync(path.join(root, 'wrangler.toml'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const BASE = 'http://localhost';

/** The body of a named wrangler environment section, to the next [env.*] or EOF. */
function productionSection(): string {
  const start = wrangler.indexOf('[env.production]');
  return start === -1 ? '' : wrangler.slice(start);
}

describe('Wrangler configuration', () => {
  const prod = productionSection();

  it('declares a D1 binding for PRODUCTION, not only at the top level', () => {
    // Wrangler does not inherit bindings into named environments. Without this,
    // env.DB is undefined in production and every request fails at runtime.
    expect(prod).toContain('[[env.production.d1_databases]]');
    expect(prod).toMatch(/binding\s*=\s*"DB"/);
  });

  it('declares an R2 binding for production', () => {
    expect(prod).toContain('[[env.production.r2_buckets]]');
    expect(prod).toMatch(/binding\s*=\s*"IMPORTS"/);
  });

  it('declares BOTH production vars the Worker reads', () => {
    // The Env type requires ENVIRONMENT and FRONTEND_URL; vars are not
    // inherited either, so both must appear under the production environment.
    expect(prod).toContain('[env.production.vars]');
    expect(prod).toMatch(/ENVIRONMENT\s*=\s*"production"/);
    expect(prod).toMatch(/FRONTEND_URL\s*=/);
  });

  it('serves the built SPA with a single-page-application fallback', () => {
    // Without this a deep link such as /admin/menu reaches the Worker's JSON
    // 404 instead of index.html, and the app cannot be reloaded or bookmarked.
    expect(wrangler).toContain('[assets]');
    expect(wrangler).toMatch(/directory\s*=\s*"\.\/dist"/);
    expect(wrangler).toMatch(/not_found_handling\s*=\s*"single-page-application"/);
    expect(prod).toContain('[env.production.assets]');
  });

  it('contains NO real credentials - only marked placeholders', () => {
    // A 32-hex-character run is what a real D1 database id looks like.
    expect(wrangler).not.toMatch(/database_id\s*=\s*"[0-9a-f]{32}"/i);
    expect(wrangler).toMatch(/database_id\s*=\s*"REPLACE_WITH_/);
    expect(wrangler).not.toMatch(/api[_-]?token|account_id\s*=\s*"[0-9a-f]{32}"|secret\s*=/i);
  });

  it('the production deploy script targets the production environment', () => {
    // `wrangler deploy` with no --env ships the LOCAL configuration.
    expect(pkg.scripts['worker:deploy:prod']).toContain('--env production');
    expect(pkg.scripts['db:migrate:prod']).toContain('--env production');
  });

  it('schedules maintenance in both environments', () => {
    expect(wrangler).toContain('[triggers]');
    expect(prod).toContain('[env.production.triggers]');
  });
});

describe('Scheduled maintenance', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db, createTestR2());
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
  });

  /** The Worker's scheduled handler, as Cloudflare would invoke it. */
  const runMaintenance = () =>
    (app as unknown as { scheduled: (e: unknown, v: unknown) => Promise<void> }).scheduled(
      { cron: '17 3 * * *', scheduledTime: Date.now(), noRetry: () => undefined },
      env
    );

  it('is exported alongside fetch, so Cloudflare can invoke it', () => {
    expect(typeof (app as unknown as { scheduled?: unknown }).scheduled).toBe('function');
    expect(typeof (app as unknown as { fetch?: unknown }).fetch).toBe('function');
  });

  it('removes EXPIRED sessions and leaves live ones alone', async () => {
    await db
      .prepare(
        `INSERT INTO sessions (session_token_hash, employee_id, expires_at)
         VALUES ('expired-hash', ?, datetime('now', '-1 day'))`
      )
      .bind(admin.id)
      .run();

    const liveBefore = await countRows(db, "SELECT COUNT(*) as n FROM sessions WHERE expires_at > datetime('now')");
    expect(liveBefore).toBeGreaterThan(0);

    await runMaintenance();

    expect(await countRows(db, "SELECT COUNT(*) as n FROM sessions WHERE expires_at < datetime('now')")).toBe(0);
    // The admin's own live session survives.
    expect(await countRows(db, "SELECT COUNT(*) as n FROM sessions WHERE expires_at > datetime('now')")).toBe(liveBefore);
  });

  it('removes stale login attempts', async () => {
    await db
      .prepare(
        `INSERT INTO login_attempts (identifier, attempt_time, success)
         VALUES ('TEST100', datetime('now', '-30 day'), 0)`
      )
      .run();

    await runMaintenance();
    expect(await countRows(db, 'SELECT COUNT(*) as n FROM login_attempts')).toBe(0);
  });

  it('NEVER purges the record - audit, history and imports survive', async () => {
    await db
      .prepare(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id) VALUES (?, 'TEST', 'TEST', 1)`
      )
      .bind(admin.id)
      .run();
    await db
      .prepare(
        `INSERT INTO lunch_selection_history (employee_id, meal_date, new_choice, source)
         VALUES (?, '2020-01-01', 'option_1', 'employee')`
      )
      .bind(admin.id)
      .run();
    await db
      .prepare(
        `INSERT INTO roster_entries (employee_id, work_date, shift_value, source)
         VALUES (?, '2020-01-01', 'day', 'import')`
      )
      .bind(admin.id)
      .run();

    await runMaintenance();

    // These ARE the record. Purging them needs an operator's decision, not a
    // cron job quietly making one.
    expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(1);
    expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history')).toBe(1);
    expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(1);
  });

  it('a maintenance failure does not throw', async () => {
    const broken = { DB: { prepare: () => { throw new Error('D1 unavailable'); } } } as unknown as typeof env;
    await expect(
      (app as unknown as { scheduled: (e: unknown, v: unknown) => Promise<void> }).scheduled(
        { cron: '17 3 * * *', scheduledTime: Date.now(), noRetry: () => undefined },
        broken
      )
    ).resolves.toBeUndefined();
  });
});

describe('Production error behaviour', () => {
  let db: TestD1Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('a production error response exposes no internal detail', async () => {
    const prodEnv = { ...testEnv(db, createTestR2()), ENVIRONMENT: 'production' as const };
    // An unroutable path is the safest way to exercise the handler chain.
    const res = await app.request(`${BASE}/api/definitely-not-a-route`, {}, prodEnv);
    const body = await readJson(res);

    expect(res.status).toBe(404);
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/at .*\.ts:|SELECT |INSERT |sqlite|stack/i);
  });

  it('malformed JSON is refused without leaking a parser trace', async () => {
    const admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    const prodEnv = { ...testEnv(db, createTestR2()), ENVIRONMENT: 'production' as const };

    const res = await app.request(
      `${BASE}/api/menu`,
      {
        method: 'POST',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: '{ not json',
      },
      prodEnv
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    const raw = JSON.stringify(await readJson(res));
    expect(raw).not.toMatch(/JSON\.parse|SyntaxError|at .*\.ts:/);
    expect(raw).not.toContain('Internal Server Error: ');
  });

  it('an unauthenticated request is refused before reaching any data', async () => {
    const prodEnv = { ...testEnv(db, createTestR2()), ENVIRONMENT: 'production' as const };
    for (const path of ['/api/admin/employees', '/api/admin/reports/lunch', '/api/roster/admin/day', '/api/me/today']) {
      const res = await app.request(`${BASE}${path}`, {}, prodEnv);
      expect(res.status).toBe(401);
    }
  });
});

describe('Session cookie hardening', () => {
  it('is HttpOnly, Secure, SameSite=Strict and scoped to the site root', async () => {
    const db = createTestDb();
    const env = testEnv(db, createTestR2());
    const employee = await seedEmployee(db, { amcoId: 'TEST100' });
    await setEmployeePasswordDirect(db, employee.id, 'original-password-here');
    const res = await app.request(
      `${BASE}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amco_id: 'TEST100', password: 'original-password-here' }),
      },
      env
    );

    const cookie = res.headers.get('Set-Cookie') ?? '';
    if (res.status === 200) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/');
      // The token itself must never be readable by script.
      expect(cookie).not.toContain('SameSite=None');
    } else {
      // The cookie assertions are moot if login failed; fail loudly rather
      // than passing vacuously.
      throw new Error(`Login fixture did not authenticate: ${res.status}`);
    }
  });
});
