// @vitest-environment node
/**
 * Integration Tests - Roster API
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  seedRosterEntry,
  jsonRequest,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';
import type { D1Database } from '@cloudflare/workers-types';

const BASE = 'http://localhost';

describe('Roster API', () => {
  let db: D1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let shiftEmployee: SeededEmployee;
  let otherEmployee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    shiftEmployee = await seedEmployee(db, { amcoId: 'TEST010', rosterType: 'shift' });
    otherEmployee = await seedEmployee(db, { amcoId: 'TEST011', rosterType: 'shift' });
  });

  describe('admin mutations', () => {
    it('admin can create a roster entry', async () => {
      const res = await app.request(
        `${BASE}/api/roster`,
        jsonRequest(
          { employee_id: shiftEmployee.id, work_date: '2026-10-04', shift_value: 'day' },
          admin.cookie
        ),
        env
      );

      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.data.shift_value).toBe('day');
      expect(body.data.work_date).toBe('2026-10-04');
    });

    it('admin can update an existing roster entry, and it is audited', async () => {
      await seedRosterEntry(db, shiftEmployee.id, '2026-10-05', 'day');

      const res = await app.request(
        `${BASE}/api/roster`,
        jsonRequest(
          { employee_id: shiftEmployee.id, work_date: '2026-10-05', shift_value: 'night' },
          admin.cookie
        ),
        env
      );

      expect(res.status).toBe(200);
      expect((await readJson(res)).data.shift_value).toBe('night');

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'UPDATE_ROSTER_ENTRY'")
        .all<{ actor_id: number; before_json: string; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(JSON.parse(audit.results[0].before_json).shift_value).toBe('day');

      // The after payload identifies WHO and WHICH DATE, not just the new value.
      const after = JSON.parse(audit.results[0].after_json);
      expect(after.employee_id).toBe(shiftEmployee.id);
      expect(after.work_date).toBe('2026-10-05');
      expect(after.entry.shift_value).toBe('night');
    });

    it('rejects a roster mutation from a non-admin employee', async () => {
      const res = await app.request(
        `${BASE}/api/roster`,
        jsonRequest(
          { employee_id: shiftEmployee.id, work_date: '2026-10-06', shift_value: 'day' },
          shiftEmployee.cookie
        ),
        env
      );
      expect(res.status).toBe(403);
    });
  });

  describe('soft delete', () => {
    it('deletion is soft and is audited', async () => {
      await seedRosterEntry(db, shiftEmployee.id, '2026-10-07', 'day');

      const res = await app.request(
        `${BASE}/api/roster/${shiftEmployee.id}/2026-10-07`,
        { method: 'DELETE', headers: { Cookie: admin.cookie } },
        env
      );

      expect(res.status).toBe(200);

      // The row still exists - it is flagged, not destroyed. Roster history must
      // survive a deletion so "what did the roster say in October?" stays answerable.
      const row = await db
        .prepare('SELECT * FROM roster_entries WHERE employee_id = ? AND work_date = ?')
        .bind(shiftEmployee.id, '2026-10-07')
        .first<{ deleted_at: string | null }>();

      expect(row).not.toBeNull();
      expect(row!.deleted_at).not.toBeNull();

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'DELETE_ROSTER_ENTRY'")
        .all<{ actor_id: number; before_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(JSON.parse(audit.results[0].before_json).shift_value).toBe('day');
    });

    it('a soft-deleted entry no longer appears in the employee view', async () => {
      await seedRosterEntry(db, shiftEmployee.id, '2026-10-08', 'day');
      await app.request(
        `${BASE}/api/roster/${shiftEmployee.id}/2026-10-08`,
        { method: 'DELETE', headers: { Cookie: admin.cookie } },
        env
      );

      const res = await app.request(
        `${BASE}/api/roster/me?from=2026-10-01&to=2026-10-31`,
        { headers: { Cookie: shiftEmployee.cookie } },
        env
      );

      expect(res.status).toBe(200);
      expect((await readJson(res)).data).toHaveLength(0);
    });
  });

  describe('employee self-service access', () => {
    it('an employee can retrieve their own roster', async () => {
      await seedRosterEntry(db, shiftEmployee.id, '2026-10-10', 'day');
      await seedRosterEntry(db, shiftEmployee.id, '2026-10-11', 'night');

      const res = await app.request(
        `${BASE}/api/roster/me?from=2026-10-01&to=2026-10-31`,
        { headers: { Cookie: shiftEmployee.cookie } },
        env
      );

      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.data).toHaveLength(2);
      expect(body.data.every((e: { employee_id: number }) => e.employee_id === shiftEmployee.id)).toBe(true);
    });

    it('/me returns ONLY the caller, never another employee, whatever is passed', async () => {
      await seedRosterEntry(db, otherEmployee.id, '2026-10-12', 'day');

      // The employee id is taken from the session; there is no request parameter
      // that can redirect this at another employee.
      const res = await app.request(
        `${BASE}/api/roster/me?from=2026-10-01&to=2026-10-31&employee_id=${otherEmployee.id}`,
        { headers: { Cookie: shiftEmployee.cookie } },
        env
      );

      expect(res.status).toBe(200);
      expect((await readJson(res)).data).toHaveLength(0);
    });

    it('an employee cannot reach the admin per-date roster endpoint', async () => {
      await seedRosterEntry(db, otherEmployee.id, '2026-10-13', 'day');

      const res = await app.request(
        `${BASE}/api/roster/2026-10-13`,
        { headers: { Cookie: shiftEmployee.cookie } },
        env
      );

      expect(res.status).toBe(403);
    });

    it('an admin CAN reach the per-date roster endpoint', async () => {
      await seedRosterEntry(db, otherEmployee.id, '2026-10-14', 'night');

      const res = await app.request(
        `${BASE}/api/roster/2026-10-14`,
        { headers: { Cookie: admin.cookie } },
        env
      );

      expect(res.status).toBe(200);
      expect((await readJson(res)).data).toHaveLength(1);
    });

    it('an unauthenticated request to /me is rejected', async () => {
      const res = await app.request(`${BASE}/api/roster/me`, {}, env);
      expect(res.status).toBe(401);
    });
  });

  describe('business-date default range', () => {
    it('/me defaults its range to the business date, not the UTC date', async () => {
      // 2026-10-15 22:30 UTC is already 2026-10-16 in Asia/Amman (UTC+3).
      // An entry on the 16th must therefore be inside the default window, which
      // it would not be if the range still started from the UTC date.
      await seedRosterEntry(db, shiftEmployee.id, '2026-10-16', 'day');

      const res = await app.request(
        `${BASE}/api/roster/me?from=2026-10-16`,
        { headers: { Cookie: shiftEmployee.cookie } },
        env
      );

      expect(res.status).toBe(200);
      expect((await readJson(res)).data).toHaveLength(1);
    });

    it('rejects a malformed from date', async () => {
      const res = await app.request(
        `${BASE}/api/roster/me?from=15-10-2026`,
        { headers: { Cookie: shiftEmployee.cookie } },
        env
      );
      expect(res.status).toBe(400);
    });
  });
});
