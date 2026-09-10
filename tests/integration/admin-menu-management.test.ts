// @vitest-environment node
/**
 * Integration Tests - admin menu management and publishing.
 *
 * Real Hono routes, real SQL against the real migrations. Every dish name is
 * invented; no real menu content appears.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { createTestR2 } from '../helpers/r2.js';
import { buildMenuWorkbook, menuRow } from '../helpers/xlsxFixture.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  seedMenuDay,
  countRows,
  jsonRequest,
  readJson,
  ROLE_ADMIN,
  ROLE_SUPER_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';

describe('Admin menu management', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let superAdmin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db, createTestR2());
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    superAdmin = await seedEmployee(db, { amcoId: 'TEST901', roleId: ROLE_SUPER_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST100', rosterType: 'regular' });
  });

  const get = (path: string, cookie = admin.cookie) =>
    app.request(`${BASE}${path}`, cookie ? { headers: { Cookie: cookie } } : {}, env);

  const post = (path: string, body: unknown, cookie = admin.cookie) =>
    app.request(`${BASE}${path}`, jsonRequest(body, cookie), env);

  const put = (path: string, cookie = admin.cookie) =>
    app.request(`${BASE}${path}`, { method: 'PUT', headers: cookie ? { Cookie: cookie } : {} }, env);

  /** A complete, publishable menu day. */
  const seedFullMenu = async (date: string, status: 'draft' | 'published' | 'archived' = 'draft') => {
    const id = await seedMenuDay(db, date, status);
    await db.prepare("INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 1, 'Test Main Alpha')").bind(id).run();
    await db.prepare("INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 2, 'Test Main Beta')").bind(id).run();
    return id;
  };

  const menuStatus = async (date: string) =>
    (await db.prepare('SELECT status FROM menu_days WHERE meal_date = ?').bind(date).first<{ status: string }>())
      ?.status ?? null;

  // ==========================================================================
  // AUTHORIZATION
  // ==========================================================================

  describe('authorization', () => {
    it('an unauthenticated caller cannot list the admin month', async () => {
      expect((await get('/api/menu/admin/range?month=2027-03', '')).status).toBe(401);
    });

    it('an employee cannot list the admin month', async () => {
      expect((await get('/api/menu/admin/range?month=2027-03', employee.cookie)).status).toBe(403);
    });

    it('an admin can list the admin month', async () => {
      expect((await get('/api/menu/admin/range?month=2027-03')).status).toBe(200);
    });

    it('a super_admin can list the admin month', async () => {
      expect((await get('/api/menu/admin/range?month=2027-03', superAdmin.cookie)).status).toBe(200);
    });

    it('an employee cannot create, edit, publish or archive a menu', async () => {
      const id = await seedFullMenu('2027-03-01');

      expect((await post('/api/menu', { meal_date: '2027-03-02' }, employee.cookie)).status).toBe(403);
      expect(
        (await post(`/api/menu/${id}/options`, { option_number: 1, name: 'Hack' }, employee.cookie)).status
      ).toBe(403);
      expect(
        (await post(`/api/menu/${id}/components`, { component_type: 'salad', name: 'Hack' }, employee.cookie)).status
      ).toBe(403);
      expect((await put(`/api/menu/${id}/publish`, employee.cookie)).status).toBe(403);
      expect((await put(`/api/menu/${id}/archive`, employee.cookie)).status).toBe(403);

      // Nothing changed.
      expect(await menuStatus('2027-03-01')).toBe('draft');
      expect((await db.prepare('SELECT name FROM menu_options WHERE menu_day_id = ? AND option_number = 1').bind(id).first<{ name: string }>())!.name)
        .toBe('Test Main Alpha');
    });

    it('an unauthenticated caller cannot mutate menus', async () => {
      const id = await seedFullMenu('2027-03-01');
      expect((await post('/api/menu', { meal_date: '2027-03-02' }, '')).status).toBe(401);
      expect((await put(`/api/menu/${id}/publish`, '')).status).toBe(401);
    });
  });

  // ==========================================================================
  // MONTH LISTING
  // ==========================================================================

  describe('month listing', () => {
    it('includes DRAFTS, which the employee-facing endpoint does not', async () => {
      await seedFullMenu('2027-03-01', 'draft');
      await seedFullMenu('2027-03-02', 'published');
      await seedFullMenu('2027-03-03', 'archived');

      const body = await readJson(await get('/api/menu/admin/range?month=2027-03'));
      const statuses = body.data.menus.map((m: { meal_date: string; status: string }) => [m.meal_date, m.status]);

      expect(statuses).toEqual([
        ['2027-03-01', 'draft'],
        ['2027-03-02', 'published'],
        ['2027-03-03', 'archived'],
      ]);
    });

    it('returns options and components with each day', async () => {
      const id = await seedFullMenu('2027-03-01');
      await db.prepare("INSERT INTO menu_components (menu_day_id, component_type, name, sort_order) VALUES (?, 'salad', 'Test Salad', 0)").bind(id).run();

      const body = await readJson(await get('/api/menu/admin/range?month=2027-03'));
      const day = body.data.menus[0];

      expect(day.options.map((o: { option_number: number; name: string }) => [o.option_number, o.name]))
        .toEqual([[1, 'Test Main Alpha'], [2, 'Test Main Beta']]);
      expect(day.components.map((c: { component_type: string; name: string }) => [c.component_type, c.name]))
        .toEqual([['salad', 'Test Salad']]);
    });

    it('the SERVER decides the month boundaries and what today is', async () => {
      await seedFullMenu('2027-02-28');
      await seedFullMenu('2027-03-01');
      await seedFullMenu('2027-04-01');

      const body = await readJson(await get('/api/menu/admin/range?month=2027-03'));
      expect(body.data.from).toBe('2027-03-01');
      expect(body.data.to).toBe('2027-03-31');
      expect(body.data.menus).toHaveLength(1);
      // A server-supplied business date, so the browser never derives one.
      expect(body.data.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('gets February right, including a leap year', async () => {
      expect((await readJson(await get('/api/menu/admin/range?month=2027-02'))).data.to).toBe('2027-02-28');
      expect((await readJson(await get('/api/menu/admin/range?month=2028-02'))).data.to).toBe('2028-02-29');
    });

    it('defaults to the server\'s current month when none is given', async () => {
      const body = await readJson(await get('/api/menu/admin/range'));
      expect(body.data.month).toBe(body.data.today.slice(0, 7));
    });

    it('rejects a malformed month', async () => {
      for (const month of ['2027-13', 'March', '2027-3', '2027']) {
        expect((await get(`/api/menu/admin/range?month=${month}`)).status).toBe(400);
      }
    });
  });

  // ==========================================================================
  // CREATE AND EDIT
  // ==========================================================================

  describe('create and edit', () => {
    it('creates a menu day as a DRAFT', async () => {
      const res = await post('/api/menu', { meal_date: '2027-03-01' });
      expect(res.status).toBe(201);
      expect((await readJson(res)).data.status).toBe('draft');
    });

    it('rejects an invalid calendar date', async () => {
      for (const date of ['2027-02-30', '2027-13-01', 'tomorrow', '']) {
        expect((await post('/api/menu', { meal_date: date })).status).toBe(400);
      }
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
    });

    it('REFUSES to set status through the create endpoint', async () => {
      const res = await post('/api/menu', { meal_date: '2027-03-01', status: 'published' });
      expect(res.status).toBe(400);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
    });

    it('saves both options', async () => {
      const id = (await readJson(await post('/api/menu', { meal_date: '2027-03-01' }))).data.id;

      expect((await post(`/api/menu/${id}/options`, { option_number: 1, name: 'Test Alpha' })).status).toBe(201);
      expect((await post(`/api/menu/${id}/options`, { option_number: 2, name: 'Test Beta' })).status).toBe(201);

      const options = await db
        .prepare('SELECT option_number, name FROM menu_options WHERE menu_day_id = ? ORDER BY option_number')
        .bind(id).all<{ option_number: number; name: string }>();
      expect(options.results).toEqual([
        { option_number: 1, name: 'Test Alpha' },
        { option_number: 2, name: 'Test Beta' },
      ]);
    });

    it('REFUSES option_number 3', async () => {
      const id = await seedFullMenu('2027-03-01');
      const res = await post(`/api/menu/${id}/options`, { option_number: 3, name: 'Third' });
      expect(res.status).toBe(400);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_options WHERE menu_day_id = ?', id)).toBe(2);
    });

    it('rejects an empty option name and a missing option_number', async () => {
      const id = await seedFullMenu('2027-03-01');
      expect((await post(`/api/menu/${id}/options`, { option_number: 1, name: '' })).status).toBe(400);
      expect((await post(`/api/menu/${id}/options`, { name: 'No number' })).status).toBe(400);
    });

    it('updating an option keeps its row id - never delete and recreate', async () => {
      const id = await seedFullMenu('2027-03-01');
      const before = await db
        .prepare('SELECT id FROM menu_options WHERE menu_day_id = ? AND option_number = 1')
        .bind(id).first<{ id: number }>();

      await post(`/api/menu/${id}/options`, { option_number: 1, name: 'Renamed Alpha' });

      const after = await db
        .prepare('SELECT id, name FROM menu_options WHERE menu_day_id = ? AND option_number = 1')
        .bind(id).first<{ id: number; name: string }>();
      expect(after!.id).toBe(before!.id);
      expect(after!.name).toBe('Renamed Alpha');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_options WHERE menu_day_id = ?', id)).toBe(2);
    });

    it('rejects an invalid component_type and accepts every allowed one', async () => {
      const id = await seedFullMenu('2027-03-01');

      expect((await post(`/api/menu/${id}/components`, { component_type: 'side', name: 'X' })).status).toBe(400);
      expect((await post(`/api/menu/${id}/components`, { component_type: 'nonsense', name: 'X' })).status).toBe(400);

      for (const type of ['condiment', 'beverage', 'dessert', 'salad', 'soup', 'bread', 'other']) {
        expect((await post(`/api/menu/${id}/components`, { component_type: type, name: `Test ${type}` })).status).toBe(201);
      }
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_components WHERE menu_day_id = ?', id)).toBe(7);
    });

    it('editing a component in place keeps its row id', async () => {
      const id = await seedFullMenu('2027-03-01');
      const created = (await readJson(
        await post(`/api/menu/${id}/components`, { component_type: 'salad', name: 'Old Salad' })
      )).data;

      const res = await post(`/api/menu/${id}/components`, {
        component_type: 'salad',
        name: 'New Salad',
        component_id: created.id,
      });

      expect(res.status).toBe(200);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_components WHERE menu_day_id = ?', id)).toBe(1);
      const row = await db.prepare('SELECT id, name FROM menu_components WHERE menu_day_id = ?').bind(id).first<{ id: number; name: string }>();
      expect(row!.id).toBe(created.id);
      expect(row!.name).toBe('New Salad');
    });

    it('404s for a nonexistent menu day', async () => {
      expect((await post('/api/menu/99999/options', { option_number: 1, name: 'X' })).status).toBe(404);
      expect((await post('/api/menu/99999/components', { component_type: 'salad', name: 'X' })).status).toBe(404);
      expect((await put('/api/menu/99999/publish')).status).toBe(404);
      expect((await put('/api/menu/99999/archive')).status).toBe(404);
    });
  });

  // ==========================================================================
  // PUBLISHING
  // ==========================================================================

  describe('publishing', () => {
    it('a complete draft can be published', async () => {
      const id = await seedFullMenu('2027-03-01');
      const res = await put(`/api/menu/${id}/publish`);
      expect(res.status).toBe(200);
      expect(await menuStatus('2027-03-01')).toBe('published');
    });

    it('REFUSES to publish a menu with no options', async () => {
      const id = await seedMenuDay(db, '2027-03-01', 'draft');
      const res = await put(`/api/menu/${id}/publish`);

      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toMatch(/Option 1 and Option 2 are missing/);
      expect(await menuStatus('2027-03-01')).toBe('draft');
    });

    it('REFUSES to publish a menu with only one option', async () => {
      const id = await seedMenuDay(db, '2027-03-01', 'draft');
      await db.prepare("INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 1, 'Only One')").bind(id).run();

      const res = await put(`/api/menu/${id}/publish`);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toMatch(/Option 2 is missing/);
      expect(await menuStatus('2027-03-01')).toBe('draft');
    });

    it('REFUSES to publish when an option name is blank', async () => {
      const id = await seedMenuDay(db, '2027-03-01', 'draft');
      await db.prepare("INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 1, 'Test Alpha')").bind(id).run();
      await db.prepare("INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 2, '   ')").bind(id).run();

      expect((await put(`/api/menu/${id}/publish`)).status).toBe(400);
      expect(await menuStatus('2027-03-01')).toBe('draft');
    });

    it('publishing is audited as a PUBLISH, with the actor', async () => {
      const id = await seedFullMenu('2027-03-01');
      await put(`/api/menu/${id}/publish`);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'PUBLISH_MENU_DAY'")
        .all<{ actor_id: number; entity_id: number; before_json: string; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results![0].actor_id).toBe(admin.id);
      expect(audit.results![0].entity_id).toBe(id);
      // The audit service wraps after_json as { meal_date, menu_day }.
      expect(JSON.parse(audit.results![0].before_json).status).toBe('draft');
      const after = JSON.parse(audit.results![0].after_json);
      expect(after.meal_date).toBe('2027-03-01');
      expect(after.menu_day.status).toBe('published');
    });

    it('a REFUSED publish writes no audit record', async () => {
      const id = await seedMenuDay(db, '2027-03-01', 'draft');
      await put(`/api/menu/${id}/publish`);
      expect(await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'PUBLISH_MENU_DAY'")).toBe(0);
    });

    it('archiving is audited and takes the menu off the employee view', async () => {
      const id = await seedFullMenu('2027-03-01', 'published');
      expect((await put(`/api/menu/${id}/archive`)).status).toBe(200);
      expect(await menuStatus('2027-03-01')).toBe('archived');
      expect(await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'ARCHIVE_MENU_DAY'")).toBe(1);
    });

    it('editing NEVER publishes, and NEVER unpublishes a live menu', async () => {
      const id = await seedFullMenu('2027-03-01', 'published');

      // Ensuring the day exists, then editing both options and a component.
      await post('/api/menu', { meal_date: '2027-03-01' });
      await post(`/api/menu/${id}/options`, { option_number: 1, name: 'Corrected Alpha' });
      await post(`/api/menu/${id}/components`, { component_type: 'salad', name: 'Test Salad' });

      // Still live: fixing a typo does not take the menu off the screen.
      expect(await menuStatus('2027-03-01')).toBe('published');

      // And a draft is not published by being edited.
      const draftId = await seedFullMenu('2027-03-02', 'draft');
      await post(`/api/menu/${draftId}/options`, { option_number: 1, name: 'Edited' });
      expect(await menuStatus('2027-03-02')).toBe('draft');
    });
  });

  // ==========================================================================
  // EMPLOYEE VISIBILITY
  // ==========================================================================

  describe('employee visibility', () => {
    const select = (date: string, cookie: string) =>
      app.request(
        `${BASE}/api/selections/me`,
        jsonRequest({ meal_date: date, choice: 'option_1' }, cookie),
        env
      );

    it('a DRAFT is invisible and cannot be selected', async () => {
      await seedFullMenu('2027-03-01', 'draft');

      expect((await get('/api/menu/2027-03-01', employee.cookie)).status).toBe(404);
      const res = await select('2027-03-01', employee.cookie);
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toBe('Menu is not yet published');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(0);
    });

    it('a PUBLISHED menu is visible and selectable', async () => {
      const id = await seedFullMenu('2027-03-01', 'draft');
      await put(`/api/menu/${id}/publish`);

      const view = await get('/api/menu/2027-03-01', employee.cookie);
      expect(view.status).toBe(200);
      expect((await readJson(view)).data.options).toHaveLength(2);

      expect((await select('2027-03-01', employee.cookie)).status).toBeLessThan(300);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(1);
    });

    it('an ARCHIVED menu is not offered to employees', async () => {
      const id = await seedFullMenu('2027-03-01', 'published');
      await put(`/api/menu/${id}/archive`);

      expect((await get('/api/menu/2027-03-01', employee.cookie)).status).toBe(404);
      expect((await select('2027-03-01', employee.cookie)).status).toBe(400);
    });

    it('an ADMIN can see a draft even though an employee cannot', async () => {
      await seedFullMenu('2027-03-01', 'draft');
      expect((await get('/api/menu/2027-03-01', admin.cookie)).status).toBe(200);
      expect((await get('/api/menu/2027-03-01', employee.cookie)).status).toBe(404);
    });
  });

  // ==========================================================================
  // PRESERVATION
  // ==========================================================================

  describe('preservation', () => {
    const seedSelection = async (date: string) => {
      await db
        .prepare(`INSERT INTO lunch_selections (employee_id, meal_date, choice, source) VALUES (?, ?, 'option_1', 'employee')`)
        .bind(employee.id, date).run();
      await db
        .prepare(`INSERT INTO lunch_selection_history (employee_id, meal_date, new_choice, source) VALUES (?, ?, 'option_1', 'employee')`)
        .bind(employee.id, date).run();
    };

    it('an existing SELECTION survives editing and publishing the menu', async () => {
      const id = await seedFullMenu('2027-03-01', 'published');
      await seedSelection('2027-03-01');
      const before = await db
        .prepare('SELECT * FROM lunch_selections WHERE employee_id = ?')
        .bind(employee.id).first<Record<string, unknown>>();

      await post(`/api/menu/${id}/options`, { option_number: 1, name: 'Completely Different Dish' });
      await post(`/api/menu/${id}/options`, { option_number: 2, name: 'Also Different' });
      await post(`/api/menu/${id}/components`, { component_type: 'dessert', name: 'Test Fruit' });
      await put(`/api/menu/${id}/archive`);
      await put(`/api/menu/${id}/publish`);

      // Byte-identical: not deleted, not recreated.
      expect(
        await db.prepare('SELECT * FROM lunch_selections WHERE employee_id = ?').bind(employee.id).first<Record<string, unknown>>()
      ).toEqual(before);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history')).toBe(1);
    });

    it('menu management never writes to employees or roster', async () => {
      await setEmployeePasswordDirect(db, employee.id, 'original-password-here');
      const beforeEmployee = await db
        .prepare('SELECT * FROM employees WHERE id = ?').bind(employee.id).first<Record<string, unknown>>();
      await db.prepare(`INSERT INTO roster_entries (employee_id, work_date, shift_value, source) VALUES (?, '2027-03-01', 'day', 'manual')`)
        .bind(employee.id).run();
      const beforeRoster = await db
        .prepare('SELECT * FROM roster_entries WHERE employee_id = ?').bind(employee.id).first<Record<string, unknown>>();

      db.executedWrites.length = 0;
      const id = await seedFullMenu('2027-03-01');
      await post(`/api/menu/${id}/options`, { option_number: 1, name: 'Test Alpha' });
      await put(`/api/menu/${id}/publish`);

      const writes = db.executedWrites.join(' ');
      expect(writes).not.toMatch(/INSERT INTO employees|UPDATE employees|DELETE FROM employees/i);
      expect(writes).not.toMatch(/UPDATE roster_entries|DELETE FROM roster_entries/i);

      expect(await db.prepare('SELECT * FROM employees WHERE id = ?').bind(employee.id).first<Record<string, unknown>>())
        .toEqual(beforeEmployee);
      expect(await db.prepare('SELECT * FROM roster_entries WHERE employee_id = ?').bind(employee.id).first<Record<string, unknown>>())
        .toEqual(beforeRoster);
    });

    it('no menu response exposes a password hash or session token', async () => {
      await setEmployeePasswordDirect(db, employee.id, 'original-password-here');
      await seedFullMenu('2027-03-01');

      const raw = JSON.stringify(await readJson(await get('/api/menu/admin/range?month=2027-03')));
      expect(raw).not.toContain('password');
      expect(raw).not.toContain('pbkdf2');
      expect(raw).not.toContain('session');
    });
  });

  // ==========================================================================
  // THE FULL WORKFLOW
  // ==========================================================================

  describe('import to employee workflow', () => {
    it('import -> draft -> review -> publish -> employee can select', async () => {
      // 1. Import a lunch menu. It arrives as a draft.
      const form = new FormData();
      form.set('import_type', 'menu');
      form.set(
        'file',
        new File(
          [buildMenuWorkbook([menuRow('2027-03-01', 'Imported Alpha', 'Imported Beta')]) as unknown as BlobPart],
          'menu.xlsx'
        )
      );
      const upload = await app.request(
        `${BASE}/api/admin/imports`,
        { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
        env
      );
      const batch = (await readJson(upload)).data as { id: number };
      await app.request(`${BASE}/api/admin/imports/${batch.id}/validate`, { method: 'POST', headers: { Cookie: admin.cookie } }, env);
      await app.request(`${BASE}/api/admin/imports/${batch.id}/commit`, { method: 'POST', headers: { Cookie: admin.cookie } }, env);

      expect(await menuStatus('2027-03-01')).toBe('draft');

      // 2. It shows up on the admin screen, and is invisible to employees.
      const month = await readJson(await get('/api/menu/admin/range?month=2027-03'));
      expect(month.data.menus).toHaveLength(1);
      const menuDayId = month.data.menus[0].id;
      expect((await get('/api/menu/2027-03-01', employee.cookie)).status).toBe(404);

      // 3. The admin corrects a typo. Still a draft.
      await post(`/api/menu/${menuDayId}/options`, { option_number: 1, name: 'Corrected Alpha' });
      expect(await menuStatus('2027-03-01')).toBe('draft');

      // 4. The admin publishes deliberately.
      expect((await put(`/api/menu/${menuDayId}/publish`)).status).toBe(200);
      expect(await menuStatus('2027-03-01')).toBe('published');

      // 5. Now the employee can see it and select.
      const view = await readJson(await get('/api/menu/2027-03-01', employee.cookie));
      expect(view.data.options.find((o: { option_number: number }) => o.option_number === 1).name)
        .toBe('Corrected Alpha');

      const selection = await app.request(
        `${BASE}/api/selections/me`,
        jsonRequest({ meal_date: '2027-03-01', choice: 'option_1' }, employee.cookie),
        env
      );
      expect(selection.status).toBeLessThan(300);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(1);
    });

    it('importing still never publishes on its own', async () => {
      const form = new FormData();
      form.set('import_type', 'menu');
      form.set(
        'file',
        new File(
          [buildMenuWorkbook([menuRow('2027-03-01', 'Test Alpha', 'Test Beta')]) as unknown as BlobPart],
          'menu.xlsx'
        )
      );
      const upload = await app.request(
        `${BASE}/api/admin/imports`,
        { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
        env
      );
      const batch = (await readJson(upload)).data as { id: number };
      await app.request(`${BASE}/api/admin/imports/${batch.id}/validate`, { method: 'POST', headers: { Cookie: admin.cookie } }, env);
      await app.request(`${BASE}/api/admin/imports/${batch.id}/commit`, { method: 'POST', headers: { Cookie: admin.cookie } }, env);

      expect(await countRows(db, "SELECT COUNT(*) as n FROM menu_days WHERE status = 'published'")).toBe(0);
    });
  });
});
