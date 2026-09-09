// @vitest-environment node
/**
 * Integration Tests - Menu API
 *
 * Real Hono routing, real middleware, real SQL against the real migration.
 * Requests are dispatched through `app.request()`, so nothing about the HTTP
 * layer is stubbed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb } from '../helpers/d1.js';
import {
  testEnv,
  seedEmployee,
  seedMenuDay,
  jsonRequest,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';
import type { D1Database } from '@cloudflare/workers-types';

const BASE = 'http://localhost';

describe('Menu API', () => {
  let db: D1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN, fullName: 'Test Admin' });
    employee = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
  });

  describe('menu day lifecycle', () => {
    it('authenticated admin can create a menu day', async () => {
      const res = await app.request(
        `${BASE}/api/menu`,
        jsonRequest({ meal_date: '2026-10-04', status: 'draft' }, admin.cookie),
        env
      );

      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.success).toBe(true);
      expect(body.data.meal_date).toBe('2026-10-04');
      expect(body.data.status).toBe('draft');
    });

    it('admin can update an existing menu day', async () => {
      await app.request(`${BASE}/api/menu`, jsonRequest({ meal_date: '2026-10-04' }, admin.cookie), env);
      const res = await app.request(
        `${BASE}/api/menu`,
        jsonRequest({ meal_date: '2026-10-04', status: 'published' }, admin.cookie),
        env
      );

      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.data.status).toBe('published');
    });

    it('rejects a menu day mutation from a non-admin employee', async () => {
      const res = await app.request(
        `${BASE}/api/menu`,
        jsonRequest({ meal_date: '2026-10-04' }, employee.cookie),
        env
      );
      expect(res.status).toBe(403);
    });

    it('publish works and is audited', async () => {
      const menuDayId = await seedMenuDay(db, '2026-10-05', 'draft');

      const res = await app.request(
        `${BASE}/api/menu/${menuDayId}/publish`,
        { method: 'PUT', headers: { Cookie: admin.cookie } },
        env
      );

      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.data.status).toBe('published');

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'PUBLISH_MENU_DAY'")
        .all<{ actor_id: number; entity_id: number }>();
      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
    });
  });

  describe('option mutations are audited', () => {
    it('creating Option 1 writes a CREATE_MENU_OPTION audit record', async () => {
      const menuDayId = await seedMenuDay(db, '2026-10-06', 'draft');

      const res = await app.request(
        `${BASE}/api/menu/${menuDayId}/options`,
        jsonRequest({ option_number: 1, name: 'Test Dish Alpha' }, admin.cookie),
        env
      );

      expect(res.status).toBe(201);
      const body = await readJson(res);
      expect(body.data.name).toBe('Test Dish Alpha');

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'CREATE_MENU_OPTION'")
        .all<{ actor_id: number; entity_id: number; before_json: string | null; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      const record = audit.results[0];
      expect(record.actor_id).toBe(admin.id);
      expect(record.entity_id).toBe(menuDayId);
      expect(record.before_json).toBeNull();

      const after = JSON.parse(record.after_json);
      expect(after.meal_date).toBe('2026-10-06');
      expect(after.option_number).toBe(1);
      expect(after.option.name).toBe('Test Dish Alpha');
    });

    it('creating Option 2 is audited independently of Option 1', async () => {
      const menuDayId = await seedMenuDay(db, '2026-10-06', 'draft');

      await app.request(
        `${BASE}/api/menu/${menuDayId}/options`,
        jsonRequest({ option_number: 1, name: 'Test Dish Alpha' }, admin.cookie),
        env
      );
      const res = await app.request(
        `${BASE}/api/menu/${menuDayId}/options`,
        jsonRequest({ option_number: 2, name: 'Test Dish Beta' }, admin.cookie),
        env
      );

      expect(res.status).toBe(201);

      const audit = await db
        .prepare("SELECT after_json FROM audit_log WHERE action = 'CREATE_MENU_OPTION' ORDER BY id")
        .all<{ after_json: string }>();

      expect(audit.results).toHaveLength(2);
      expect(JSON.parse(audit.results[1].after_json).option_number).toBe(2);
    });

    it('updating an option records before AND after state', async () => {
      const menuDayId = await seedMenuDay(db, '2026-10-07', 'draft');

      await app.request(
        `${BASE}/api/menu/${menuDayId}/options`,
        jsonRequest({ option_number: 1, name: 'Original Name' }, admin.cookie),
        env
      );
      const res = await app.request(
        `${BASE}/api/menu/${menuDayId}/options`,
        jsonRequest({ option_number: 1, name: 'Revised Name' }, admin.cookie),
        env
      );

      expect(res.status).toBe(200);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'UPDATE_MENU_OPTION'")
        .all<{ before_json: string; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(JSON.parse(audit.results[0].before_json).name).toBe('Original Name');
      expect(JSON.parse(audit.results[0].after_json).option.name).toBe('Revised Name');
    });

    it('an option mutation cannot happen without an audit record', async () => {
      const menuDayId = await seedMenuDay(db, '2026-10-08', 'draft');

      await app.request(
        `${BASE}/api/menu/${menuDayId}/options`,
        jsonRequest({ option_number: 1, name: 'Audited Dish' }, admin.cookie),
        env
      );

      const options = await db.prepare('SELECT COUNT(*) as n FROM menu_options').first<{ n: number }>();
      const audits = await db
        .prepare("SELECT COUNT(*) as n FROM audit_log WHERE entity_type = 'MENU_OPTION'")
        .first<{ n: number }>();

      expect(Number(options?.n)).toBe(1);
      expect(Number(audits?.n)).toBe(1);
    });
  });

  describe('component mutations are audited', () => {
    it('creating a component writes a CREATE_MENU_COMPONENT audit record', async () => {
      const menuDayId = await seedMenuDay(db, '2026-10-09', 'draft');

      const res = await app.request(
        `${BASE}/api/menu/${menuDayId}/components`,
        jsonRequest({ component_type: 'beverage', name: 'Test Beverage' }, admin.cookie),
        env
      );

      expect(res.status).toBe(201);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'CREATE_MENU_COMPONENT'")
        .all<{ actor_id: number; entity_id: number; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(audit.results[0].entity_id).toBe(menuDayId);
      expect(JSON.parse(audit.results[0].after_json).component.name).toBe('Test Beverage');
    });

    it('updating a component records before AND after state', async () => {
      const menuDayId = await seedMenuDay(db, '2026-10-10', 'draft');

      const created = await app.request(
        `${BASE}/api/menu/${menuDayId}/components`,
        jsonRequest({ component_type: 'dessert', name: 'Original Dessert' }, admin.cookie),
        env
      );
      const componentId = (await readJson(created)).data.id;

      const res = await app.request(
        `${BASE}/api/menu/${menuDayId}/components`,
        jsonRequest(
          { component_id: componentId, component_type: 'dessert', name: 'Revised Dessert' },
          admin.cookie
        ),
        env
      );

      expect(res.status).toBe(200);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'UPDATE_MENU_COMPONENT'")
        .all<{ before_json: string; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(JSON.parse(audit.results[0].before_json).name).toBe('Original Dessert');
      expect(JSON.parse(audit.results[0].after_json).component.name).toBe('Revised Dessert');
    });

    it('rejects a component mutation from a non-admin employee', async () => {
      const menuDayId = await seedMenuDay(db, '2026-10-11', 'draft');
      const res = await app.request(
        `${BASE}/api/menu/${menuDayId}/components`,
        jsonRequest({ component_type: 'salad', name: 'Nope' }, employee.cookie),
        env
      );
      expect(res.status).toBe(403);
    });
  });

  describe('employee visibility respects publication status', () => {
    it('an employee cannot read a draft menu', async () => {
      await seedMenuDay(db, '2026-10-12', 'draft');
      const res = await app.request(
        `${BASE}/api/menu/2026-10-12`,
        { headers: { Cookie: employee.cookie } },
        env
      );
      expect(res.status).toBe(404);
    });

    it('an employee can read a published menu', async () => {
      await seedMenuDay(db, '2026-10-13', 'published');
      const res = await app.request(
        `${BASE}/api/menu/2026-10-13`,
        { headers: { Cookie: employee.cookie } },
        env
      );
      expect(res.status).toBe(200);
      expect((await readJson(res)).data.meal_date).toBe('2026-10-13');
    });

    it('an admin CAN read a draft menu', async () => {
      await seedMenuDay(db, '2026-10-14', 'draft');
      const res = await app.request(
        `${BASE}/api/menu/2026-10-14`,
        { headers: { Cookie: admin.cookie } },
        env
      );
      expect(res.status).toBe(200);
      expect((await readJson(res)).data.status).toBe('draft');
    });
  });

  describe('GET /api/menu/upcoming', () => {
    it('is reachable and returns only published menus', async () => {
      await seedMenuDay(db, '2026-10-20', 'published');
      await seedMenuDay(db, '2026-10-21', 'draft');
      await seedMenuDay(db, '2026-10-22', 'published');

      const res = await app.request(
        `${BASE}/api/menu/upcoming?from=2026-10-20`,
        { headers: { Cookie: employee.cookie } },
        env
      );

      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.success).toBe(true);
      expect(body.data.map((m: { meal_date: string }) => m.meal_date)).toEqual([
        '2026-10-20',
        '2026-10-22',
      ]);
    });

    it('rejects a malformed from date rather than silently ignoring it', async () => {
      const res = await app.request(
        `${BASE}/api/menu/upcoming?from=not-a-date`,
        { headers: { Cookie: employee.cookie } },
        env
      );
      expect(res.status).toBe(400);
    });
  });
});
