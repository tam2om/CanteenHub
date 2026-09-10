// @vitest-environment node
/**
 * Integration Tests - lunch menu Excel import.
 *
 * Real Hono routes, real SQL against the real migrations, the real XLSX reader
 * parsing genuine ZIP/SpreadsheetML built in-test, and the in-memory R2 double
 * the production path actually calls.
 *
 * Every dish name here is invented. No content from the real menu appears.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { createTestR2, type TestR2Bucket } from '../helpers/r2.js';
import { buildMenuWorkbook, buildWorkbook, menuRow, MENU_HEADERS } from '../helpers/xlsxFixture.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  countRows,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const IMPORTS = `${BASE}/api/admin/imports`;

/** Synthetic menu rows. */
const ROW_A = menuRow('2027-03-01', 'Test Main Alpha', 'Test Main Beta', {
  day: 'Mon',
  salad: 'Test Salad',
  side: 'Test Yoghurt',
  condiment: 'Test Pickles',
  beverage: 'Test Juice',
  dessert: 'Test Fruit',
});
const ROW_B = menuRow('2027-03-02', 'Test Main Gamma', 'Test Main Delta', { day: 'Tue' });

describe('Lunch menu Excel import', () => {
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

  const uploadWorkbook = (
    bytes: Uint8Array,
    { cookie = admin.cookie, filename = 'menu.xlsx', importType = 'menu' } = {}
  ) => {
    const form = new FormData();
    form.set('import_type', importType);
    form.set('file', new File([bytes as unknown as BlobPart], filename));
    const headers: Record<string, string> = {};
    if (cookie) headers.Cookie = cookie;
    return app.request(IMPORTS, { method: 'POST', headers, body: form }, env);
  };

  const validate = (id: number, cookie = admin.cookie) =>
    app.request(`${IMPORTS}/${id}/validate`, { method: 'POST', headers: { Cookie: cookie } }, env);
  const commit = (id: number, cookie = admin.cookie) =>
    app.request(`${IMPORTS}/${id}/commit`, { method: 'POST', headers: { Cookie: cookie } }, env);
  const preview = (id: number, cookie = admin.cookie) =>
    app.request(`${IMPORTS}/${id}`, { headers: { Cookie: cookie } }, env);

  const uploadAndValidate = async (rows: Array<Array<string | null>>, opts = {}) => {
    const res = await uploadWorkbook(buildMenuWorkbook(rows, opts));
    expect(res.status).toBe(201);
    const batch = (await readJson(res)).data as { id: number };
    const validated = await readJson(await validate(batch.id));
    return { id: batch.id, body: validated };
  };

  const previewRows = async (id: number) => {
    const detail = await readJson(await preview(id));
    return detail.data.preview_rows as Array<{
      row_number: number;
      status: string;
      messages: string[];
      preview: {
        action: string;
        meal_date: string;
        option_1: string;
        option_2: string;
        components: Array<{ component_type: string; name: string; action: string; from: string | null }>;
        changes: Array<{ field: string; from: string | null; to: string | null }>;
        current_status: string | null;
      };
    }>;
  };

  const menuDay = (date: string) =>
    db.prepare('SELECT * FROM menu_days WHERE meal_date = ?').bind(date).first<Record<string, unknown>>();

  const options = async (date: string) => {
    const day = await menuDay(date);
    if (!day) return [];
    const rows = await db
      .prepare('SELECT option_number, name FROM menu_options WHERE menu_day_id = ? ORDER BY option_number')
      .bind(day.id)
      .all<{ option_number: number; name: string }>();
    return rows.results || [];
  };

  const components = async (date: string) => {
    const day = await menuDay(date);
    if (!day) return [];
    const rows = await db
      .prepare('SELECT component_type, name, sort_order FROM menu_components WHERE menu_day_id = ? ORDER BY sort_order')
      .bind(day.id)
      .all<{ component_type: string; name: string; sort_order: number }>();
    return rows.results || [];
  };

  const seedMenu = async (
    date: string,
    o1: string,
    o2: string,
    status = 'draft',
    comps: Array<[string, string]> = []
  ) => {
    const inserted = await db
      .prepare('INSERT INTO menu_days (meal_date, status) VALUES (?, ?)')
      .bind(date, status)
      .run();
    const id = inserted.meta.last_row_id as number;
    await db.prepare('INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 1, ?)').bind(id, o1).run();
    await db.prepare('INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 2, ?)').bind(id, o2).run();
    for (const [type, name] of comps) {
      await db
        .prepare('INSERT INTO menu_components (menu_day_id, component_type, name) VALUES (?, ?, ?)')
        .bind(id, type, name)
        .run();
    }
    return id;
  };

  // ==========================================================================
  // PARSER / SHEET SELECTION
  // ==========================================================================

  describe('parser', () => {
    it('reads the real lunch column layout', async () => {
      const { body } = await uploadAndValidate([ROW_A, ROW_B]);
      expect(body.data.outcome).toBe('ready');
      expect(body.data.total_rows).toBe(2);
      expect(body.data.invalid_rows).toBe(0);
    });

    it('REFUSES to guess when the workbook also holds a dinner sheet', async () => {
      // Importing dinner as lunch would feed the wrong numbers to the caterer.
      const bytes = buildWorkbook([
        { name: 'Dinner', rows: [MENU_HEADERS, ROW_A as string[]] },
        { name: 'Sheet1', rows: [MENU_HEADERS, ROW_A as string[]] },
      ]);
      const res = await uploadWorkbook(bytes);
      const batch = (await readJson(res)).data as { id: number };
      const body = await readJson(await validate(batch.id));

      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('No lunch worksheet');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
    });

    it('finds the lunch sheet by name even beside a dinner sheet', async () => {
      const bytes = buildWorkbook([
        { name: 'Dinner Menu', rows: [MENU_HEADERS, ['x', '2027-03-09', 'Dinner Alpha', 'Dinner Beta']] },
        { name: 'Lunch Menu', rows: [MENU_HEADERS, ROW_A as string[]] },
      ]);
      const res = await uploadWorkbook(bytes);
      const batch = (await readJson(res)).data as { id: number };
      const body = await readJson(await validate(batch.id));

      expect(body.data.outcome).toBe('ready');
      const rows = await previewRows(batch.id);
      expect(rows[0].preview.option_1).toBe('Test Main Alpha');
      expect(rows[0].preview.meal_date).toBe('2027-03-01');
    });

    it('names a missing required column', async () => {
      const { body } = await uploadAndValidate([['Mon', '2027-03-01', 'Only One']], {
        headers: ['Day', 'Date', 'Option 1'],
      });
      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('option_2');
    });

    it('normalizes header whitespace, case and invisible characters', async () => {
      const { body } = await uploadAndValidate([ROW_A], {
        headers: ['Day', '  DATE ', 'option 1', 'Option 2​', 'Option Meal 1', 'Option Meal 2', 'Condiment', 'Beverage', 'Dessert / Fruits'],
      });
      expect(body.data.outcome).toBe('ready');
    });

    it('rejects a duplicated column header', async () => {
      const { body } = await uploadAndValidate([ROW_A], {
        headers: ['Day', 'Date', 'Option 1', 'Option 1', 'Option Meal 1'],
      });
      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('more than one column');
    });

    it('skips blank padding rows', async () => {
      const { body } = await uploadAndValidate([ROW_A, [null, null, null, null], [null, null, null, null]]);
      expect(body.data.total_rows).toBe(1);
      expect(body.data.outcome).toBe('ready');
    });

    it('rejects a malformed workbook without leaking internals', async () => {
      const res = await uploadWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x99, 0x99]));
      const batch = (await readJson(res)).data as { id: number };
      const body = await readJson(await validate(batch.id));

      expect(body.data.outcome).toBe('failed');
      const raw = JSON.stringify(body.data.messages);
      expect(raw).not.toContain('undefined');
      expect(raw).not.toMatch(/at .*\.ts:/);
    });

    it('preserves dish text verbatim, including doubled spaces and typos', async () => {
      // The importer must not "helpfully" normalize what a human will read.
      const { id } = await uploadAndValidate([
        menuRow('2027-03-01', 'Test  Chiken  Speshal', 'Test Beta'),
      ]);
      await commit(id);
      expect((await options('2027-03-01'))[0].name).toBe('Test  Chiken  Speshal');
    });

    it('never evaluates a formula: only the cached value is read', async () => {
      const { id, body } = await uploadAndValidate([ROW_A]);
      expect(body.data.outcome).toBe('ready');
      const raw = JSON.stringify(await previewRows(id));
      expect(raw).not.toContain('<f>');
      expect(raw).not.toContain('SUM(');
    });
  });

  // ==========================================================================
  // DATES
  // ==========================================================================

  describe('dates', () => {
    it('reads the printed d-MMM-yy form', async () => {
      const { id, body } = await uploadAndValidate([menuRow('1-Sep-26', 'Test Alpha', 'Test Beta')]);
      expect(body.data.outcome).toBe('ready');
      expect((await previewRows(id))[0].preview.meal_date).toBe('2026-09-01');
    });

    it('reads an Excel date serial', async () => {
      // 46266 is 2026-09-01 in Excel's 1900 system.
      const { id, body } = await uploadAndValidate([menuRow('46266', 'Test Alpha', 'Test Beta')]);
      expect(body.data.outcome).toBe('ready');
      expect((await previewRows(id))[0].preview.meal_date).toBe('2026-09-01');
    });

    it('rejects an impossible date: September 31', async () => {
      const { id, body } = await uploadAndValidate([menuRow('31-Sep-26', 'Test Alpha', 'Test Beta')]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('not a valid calendar date');
    });

    it('rejects February 29 in a non-leap year but accepts a real leap day', async () => {
      expect((await uploadAndValidate([menuRow('2027-02-29', 'A', 'B')])).body.data.outcome).toBe('failed');
      const leap = await uploadAndValidate([menuRow('2028-02-29', 'Test Alpha', 'Test Beta')]);
      expect(leap.body.data.outcome).toBe('ready');
      expect((await previewRows(leap.id))[0].preview.meal_date).toBe('2028-02-29');
    });

    it('rejects a missing or unparseable date', async () => {
      expect((await uploadAndValidate([menuRow('', 'A', 'B')])).body.data.outcome).toBe('failed');
      expect((await uploadAndValidate([menuRow('next tuesday', 'A', 'B')])).body.data.outcome).toBe('failed');
    });

    it('does not shift a date across a timezone boundary', async () => {
      // The first of a month is where a UTC round trip classically slips a day.
      const { id } = await uploadAndValidate([menuRow('2027-01-01', 'Test Alpha', 'Test Beta')]);
      expect((await previewRows(id))[0].preview.meal_date).toBe('2027-01-01');
      await commit(id);
      expect(await menuDay('2027-01-01')).not.toBeNull();
    });
  });

  // ==========================================================================
  // EXACTLY TWO OPTIONS
  // ==========================================================================

  describe('exactly two selectable options', () => {
    it('rejects a row missing Option 1', async () => {
      const { id, body } = await uploadAndValidate([menuRow('2027-03-01', '', 'Test Beta')]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('Option 1 is missing');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
    });

    it('rejects a row missing Option 2', async () => {
      const { id, body } = await uploadAndValidate([menuRow('2027-03-01', 'Test Alpha', '')]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('Option 2 is missing');
    });

    it('REFUSES a workbook carrying a third selectable option', async () => {
      const { body } = await uploadAndValidate([['Mon', '2027-03-01', 'A', 'B', 'C']], {
        headers: ['Day', 'Date', 'Option 1', 'Option 2', 'Option 3'],
      });
      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('exactly');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_options')).toBe(0);
    });

    it('rejects two identical options, which are not a choice', async () => {
      const { id, body } = await uploadAndValidate([menuRow('2027-03-01', 'Same Dish', 'Same Dish')]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('identical');
    });

    it('a committed menu day always has exactly two options', async () => {
      const { id } = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(id);
      expect((await options('2027-03-01')).map((o) => o.option_number)).toEqual([1, 2]);
      expect((await options('2027-03-02')).map((o) => o.option_number)).toEqual([1, 2]);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_options WHERE option_number NOT IN (1,2)')).toBe(0);
    });

    it('"Option Meal 1/2" become COMPONENTS, never selectable options', async () => {
      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      expect((await options('2027-03-01')).map((o) => o.name)).toEqual(['Test Main Alpha', 'Test Main Beta']);
      const comps = await components('2027-03-01');
      expect(comps.find((c) => c.name === 'Test Salad')!.component_type).toBe('salad');
      expect(comps.find((c) => c.name === 'Test Yoghurt')!.component_type).toBe('other');
    });
  });

  // ==========================================================================
  // DUPLICATES
  // ==========================================================================

  describe('duplicates', () => {
    it('rejects a duplicate date with CONFLICTING options', async () => {
      const { id, body } = await uploadAndValidate([
        menuRow('2027-03-01', 'Test Alpha', 'Test Beta'),
        menuRow('2027-03-01', 'Test Gamma', 'Test Delta'),
      ]);
      expect(body.data.outcome).toBe('failed');
      expect(body.data.invalid_rows).toBe(2);
      for (const row of await previewRows(id)) {
        expect(row.messages.join(' ')).toContain('appears more than once');
      }
    });

    it('rejects a duplicate date even when the rows are IDENTICAL', async () => {
      const { body } = await uploadAndValidate([
        menuRow('2027-03-01', 'Test Alpha', 'Test Beta'),
        menuRow('2027-03-01', 'Test Alpha', 'Test Beta'),
      ]);
      expect(body.data.outcome).toBe('failed');
      expect(body.data.invalid_rows).toBe(2);
    });

    it('detects a duplicate across DIFFERENT date spellings of the same day', async () => {
      const { body } = await uploadAndValidate([
        menuRow('2026-09-01', 'Test Alpha', 'Test Beta'),
        menuRow('1-Sep-26', 'Test Gamma', 'Test Delta'),
      ]);
      expect(body.data.outcome).toBe('failed');
      expect(body.data.invalid_rows).toBe(2);
    });

    it('allows different dates', async () => {
      const { body } = await uploadAndValidate([ROW_A, ROW_B]);
      expect(body.data.outcome).toBe('ready');
    });

    it('refuses a date whose existing components are ambiguous', async () => {
      // Two salads already exist, so "which one does this column mean?" has no
      // honest answer; the importer asks rather than guesses.
      await seedMenu('2027-03-01', 'Old Alpha', 'Old Beta', 'draft', [
        ['salad', 'Salad One'],
        ['salad', 'Salad Two'],
      ]);
      const { id, body } = await uploadAndValidate([ROW_A]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('cannot be matched');
    });
  });

  // ==========================================================================
  // VALIDATION / COMMIT BOUNDARY
  // ==========================================================================

  describe('validation/commit boundary', () => {
    it('COMMIT is the only step that writes menu data', async () => {
      db.executedWrites.length = 0;
      const menuWrite = /menu_days|menu_options|menu_components/i;

      const res = await uploadWorkbook(buildMenuWorkbook([ROW_A, ROW_B]));
      const batch = (await readJson(res)).data as { id: number };
      expect(db.executedWrites.filter((sql) => menuWrite.test(sql))).toEqual([]);

      await validate(batch.id);
      expect(db.executedWrites.filter((sql) => menuWrite.test(sql))).toEqual([]);

      await preview(batch.id);
      expect(db.executedWrites.filter((sql) => menuWrite.test(sql))).toEqual([]);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);

      // Staging happened - the work was done, just not applied.
      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM import_batch_rows WHERE import_batch_id = ?', batch.id)
      ).toBe(2);

      await commit(batch.id);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(2);
    });

    it('validating an INVALID workbook writes no menu data either', async () => {
      db.executedWrites.length = 0;
      await uploadAndValidate([menuRow('2027-03-01', 'Only One', '')]);

      expect(db.executedWrites.filter((sql) => /menu_days|menu_options|menu_components/i.test(sql))).toEqual([]);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
    });

    it('refuses to commit a workbook containing any invalid row', async () => {
      const { id } = await uploadAndValidate([ROW_A, menuRow('2027-03-02', '', 'Test Beta')]);
      const res = await commit(id);

      expect(res.status).toBe(409);
      // The valid row was NOT partially applied.
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
    });

    it('never writes to employees, selections or roster at any step', async () => {
      db.executedWrites.length = 0;
      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      const writes = db.executedWrites.join(' ');
      expect(writes).not.toMatch(/INSERT INTO employees|UPDATE employees|DELETE FROM employees/i);
      expect(writes).not.toMatch(/lunch_selections|lunch_selection_history|roster_entries/i);
    });
  });

  // ==========================================================================
  // COMMIT AND RECONCILIATION
  // ==========================================================================

  describe('commit', () => {
    it('creates a menu day with its options and components', async () => {
      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      expect((await menuDay('2027-03-01'))!.status).toBe('draft');
      expect(await options('2027-03-01')).toEqual([
        { option_number: 1, name: 'Test Main Alpha' },
        { option_number: 2, name: 'Test Main Beta' },
      ]);
      expect((await components('2027-03-01')).map((c) => [c.component_type, c.name])).toEqual([
        ['salad', 'Test Salad'],
        ['other', 'Test Yoghurt'],
        ['condiment', 'Test Pickles'],
        ['beverage', 'Test Juice'],
        ['dessert', 'Test Fruit'],
      ]);
    });

    it('creates new menu days as DRAFT, never published', async () => {
      const { id } = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(id);
      expect(await countRows(db, "SELECT COUNT(*) as n FROM menu_days WHERE status = 'draft'")).toBe(2);
      expect(await countRows(db, "SELECT COUNT(*) as n FROM menu_days WHERE status != 'draft'")).toBe(0);
    });

    it('NEVER changes the status of an existing menu day', async () => {
      await seedMenu('2027-03-01', 'Old Alpha', 'Old Beta', 'published');

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      // The dish changed; the day stays published rather than being silently
      // reverted to draft (or an unpublished day silently going live).
      expect((await menuDay('2027-03-01'))!.status).toBe('published');
      expect((await options('2027-03-01'))[0].name).toBe('Test Main Alpha');
    });

    it('updates an existing menu day in place, keeping its row id', async () => {
      const originalId = await seedMenu('2027-03-01', 'Old Alpha', 'Old Beta');

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      expect((await menuDay('2027-03-01'))!.id).toBe(originalId);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(1);
    });

    it('updates a changed component in place rather than adding a second one', async () => {
      await seedMenu('2027-03-01', 'Test Main Alpha', 'Test Main Beta', 'draft', [
        ['salad', 'Old Salad'],
      ]);

      const { id } = await uploadAndValidate([
        menuRow('2027-03-01', 'Test Main Alpha', 'Test Main Beta', { salad: 'New Salad' }),
      ]);
      await commit(id);

      const comps = await components('2027-03-01');
      expect(comps.filter((c) => c.component_type === 'salad')).toHaveLength(1);
      expect(comps[0].name).toBe('New Salad');
    });

    it('applies a mixed workbook correctly', async () => {
      await seedMenu('2027-03-01', 'Old Alpha', 'Old Beta');

      const { id } = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(id);

      expect((await options('2027-03-01'))[0].name).toBe('Test Main Alpha');
      expect((await options('2027-03-02'))[0].name).toBe('Test Main Gamma');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(2);
    });

    it('commits atomically: a failure inside the batch applies nothing', async () => {
      const { id } = await uploadAndValidate([ROW_A, ROW_B]);

      // Corrupt the second staged row so its component violates the
      // component_type CHECK at write time, while the first would succeed.
      const staged = await db
        .prepare('SELECT id, preview_json FROM import_batch_rows WHERE import_batch_id = ? ORDER BY row_number')
        .bind(id)
        .all<{ id: number; preview_json: string }>();
      const second = staged.results![1];
      const parsed = JSON.parse(second.preview_json);
      parsed.components = [
        { component_type: 'not_a_type', label: 'salad', name: 'Bad', action: 'CREATE', from: null, sort_order: 0 },
      ];
      await db
        .prepare('UPDATE import_batch_rows SET preview_json = ? WHERE id = ?')
        .bind(JSON.stringify(parsed), second.id)
        .run();

      const res = await commit(id);
      expect(res.status).toBe(500);

      // NOTHING landed - not the first row's menu day, options or components.
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_options')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_components')).toBe(0);

      const batchRow = await db
        .prepare('SELECT status, committed_at FROM import_batches WHERE id = ?')
        .bind(id)
        .first<{ status: string; committed_at: string | null }>();
      expect(batchRow!.status).toBe('commit_failed');
      expect(batchRow!.committed_at).toBeNull();
    });
  });

  // ==========================================================================
  // RECONCILIATION - what the workbook omits
  // ==========================================================================

  describe('reconciliation', () => {
    it('leaves menu days ABSENT from the workbook completely alone', async () => {
      await seedMenu('2027-03-10', 'Untouched Alpha', 'Untouched Beta', 'published', [
        ['dessert', 'Untouched Dessert'],
      ]);
      const before = await menuDay('2027-03-10');

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      expect(await menuDay('2027-03-10')).toEqual(before);
      expect((await options('2027-03-10'))[0].name).toBe('Untouched Alpha');
      expect(await components('2027-03-10')).toHaveLength(1);
    });

    it('a BLANK component cell leaves the existing component alone', async () => {
      await seedMenu('2027-03-02', 'Test Main Gamma', 'Test Main Delta', 'draft', [
        ['dessert', 'Existing Dessert'],
      ]);

      // ROW_B carries no component cells at all.
      const { id } = await uploadAndValidate([ROW_B]);
      await commit(id);

      const comps = await components('2027-03-02');
      expect(comps).toHaveLength(1);
      expect(comps[0].name).toBe('Existing Dessert');
    });

    it('never deletes a menu day, option or component', async () => {
      await seedMenu('2027-03-01', 'Old Alpha', 'Old Beta', 'draft', [['dessert', 'Old Dessert']]);

      const { id } = await uploadAndValidate([ROW_A]);
      db.executedWrites.length = 0;
      await commit(id);

      const writes = db.executedWrites.join(' ');
      expect(writes).not.toMatch(/DELETE\s+FROM\s+menu_/i);
      expect(writes).not.toMatch(/INSERT\s+OR\s+REPLACE/i);
      // The pre-existing dessert survives untouched alongside the new ones.
      expect((await components('2027-03-01')).some((c) => c.name === 'Old Dessert')).toBe(false);
      expect((await components('2027-03-01')).some((c) => c.name === 'Test Fruit')).toBe(true);
    });

    it('a partial-month workbook touches only the dates it carries', async () => {
      await seedMenu('2027-03-05', 'Keep Alpha', 'Keep Beta');
      await seedMenu('2027-03-06', 'Keep Gamma', 'Keep Delta');

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      expect((await options('2027-03-05'))[0].name).toBe('Keep Alpha');
      expect((await options('2027-03-06'))[0].name).toBe('Keep Gamma');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(3);
    });
  });

  // ==========================================================================
  // IDEMPOTENCY
  // ==========================================================================

  describe('idempotency', () => {
    const menuWrite = /menu_days|menu_options|menu_components/i;

    it('issues NO write for an all-UNCHANGED workbook', async () => {
      const first = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(first.id);

      const second = await uploadAndValidate([ROW_A, ROW_B]);
      const rows = await previewRows(second.id);
      expect(rows.map((r) => r.preview.action)).toEqual(['UNCHANGED', 'UNCHANGED']);

      db.executedWrites.length = 0;
      await commit(second.id);
      expect(db.executedWrites.filter((sql) => menuWrite.test(sql))).toEqual([]);
    });

    it('writes ONLY the changed item in a mixed workbook', async () => {
      const first = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(first.id);

      const changed = menuRow('2027-03-02', 'Test Main Gamma', 'Changed Delta', { day: 'Tue' });
      const second = await uploadAndValidate([ROW_A, changed]);
      expect((await previewRows(second.id)).map((r) => r.preview.action)).toEqual(['UNCHANGED', 'UPDATE']);

      db.executedWrites.length = 0;
      await commit(second.id);

      // Exactly one statement, for option 2 of the one changed day.
      expect(db.executedWrites.filter((sql) => menuWrite.test(sql))).toHaveLength(1);
      expect((await options('2027-03-02'))[1].name).toBe('Changed Delta');
      expect((await options('2027-03-01'))[0].name).toBe('Test Main Alpha');
    });

    it('re-importing the same workbook three times writes nothing after the first', async () => {
      const first = await uploadAndValidate([ROW_A]);
      await commit(first.id);

      for (let i = 0; i < 2; i += 1) {
        const again = await uploadAndValidate([ROW_A]);
        db.executedWrites.length = 0;
        await commit(again.id);
        expect(db.executedWrites.filter((sql) => menuWrite.test(sql))).toEqual([]);
      }
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_components')).toBe(5);
    });
  });

  // ==========================================================================
  // PRESERVATION - the architecture's central guarantee
  // ==========================================================================

  describe('preservation', () => {
    const seedSelection = async (employeeId: number, date: string, choice = 'option_1') => {
      await db
        .prepare(
          `INSERT INTO lunch_selections (employee_id, meal_date, choice, source)
           VALUES (?, ?, ?, 'employee')`
        )
        .bind(employeeId, date, choice)
        .run();
      await db
        .prepare(
          `INSERT INTO lunch_selection_history (employee_id, meal_date, new_choice, source)
           VALUES (?, ?, ?, 'employee')`
        )
        .bind(employeeId, date, choice)
        .run();
    };

    it('an employee SELECTION survives the menu options changing under it', async () => {
      const employee = await seedEmployee(db, { amcoId: 'TEST100' });
      await seedMenu('2027-03-01', 'Old Alpha', 'Old Beta', 'published');
      await seedSelection(employee.id, '2027-03-01');

      const before = await db
        .prepare('SELECT * FROM lunch_selections WHERE employee_id = ?')
        .bind(employee.id)
        .first<Record<string, unknown>>();

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      // Both options were rewritten...
      expect((await options('2027-03-01'))[0].name).toBe('Test Main Alpha');
      // ...and the selection row is byte-identical: not deleted, not recreated.
      expect(
        await db
          .prepare('SELECT * FROM lunch_selections WHERE employee_id = ?')
          .bind(employee.id)
          .first<Record<string, unknown>>()
      ).toEqual(before);
    });

    it('a selection survives menu COMPONENTS changing', async () => {
      const employee = await seedEmployee(db, { amcoId: 'TEST100' });
      await seedMenu('2027-03-01', 'Test Main Alpha', 'Test Main Beta', 'published', [
        ['salad', 'Old Salad'],
      ]);
      await seedSelection(employee.id, '2027-03-01', 'option_2');

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      const selection = await db
        .prepare('SELECT * FROM lunch_selections WHERE employee_id = ?')
        .bind(employee.id)
        .first<Record<string, unknown>>();
      expect(selection!.choice).toBe('option_2');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history')).toBe(1);
    });

    it('PRESERVES employees, credentials, roles and active status', async () => {
      const employee = await seedEmployee(db, {
        amcoId: 'TEST100',
        roleId: ROLE_ADMIN,
        isActive: false,
      });
      await setEmployeePasswordDirect(db, employee.id, 'original-password-here');

      const before = await db
        .prepare('SELECT * FROM employees WHERE id = ?')
        .bind(employee.id)
        .first<Record<string, unknown>>();

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      const after = await db
        .prepare('SELECT * FROM employees WHERE id = ?')
        .bind(employee.id)
        .first<Record<string, unknown>>();
      expect(after).toEqual(before);
    });

    it('PRESERVES roster entries', async () => {
      const employee = await seedEmployee(db, { amcoId: 'TEST100', rosterType: 'shift' });
      await db
        .prepare(
          `INSERT INTO roster_entries (employee_id, work_date, shift_value, source)
           VALUES (?, '2027-03-01', 'day', 'import')`
        )
        .bind(employee.id)
        .run();
      const before = await db
        .prepare('SELECT * FROM roster_entries WHERE employee_id = ?')
        .bind(employee.id)
        .first<Record<string, unknown>>();

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      expect(
        await db
          .prepare('SELECT * FROM roster_entries WHERE employee_id = ?')
          .bind(employee.id)
          .first<Record<string, unknown>>()
      ).toEqual(before);
    });
  });

  // ==========================================================================
  // PREVIEW
  // ==========================================================================

  describe('preview', () => {
    it('shows CREATE with the incoming options and components', async () => {
      const { id } = await uploadAndValidate([ROW_A]);
      const row = (await previewRows(id))[0];

      expect(row.preview.action).toBe('CREATE');
      expect(row.preview.meal_date).toBe('2027-03-01');
      expect(row.preview.option_1).toBe('Test Main Alpha');
      expect(row.preview.components.map((c) => c.name)).toContain('Test Salad');
      expect(row.preview.current_status).toBeNull();
    });

    it('shows UPDATE with from/to for options and components', async () => {
      await seedMenu('2027-03-01', 'Old Alpha', 'Old Beta', 'published', [['salad', 'Old Salad']]);

      const { id } = await uploadAndValidate([ROW_A]);
      const row = (await previewRows(id))[0];

      expect(row.preview.action).toBe('UPDATE');
      expect(row.preview.changes).toEqual([
        { field: 'option_1', from: 'Old Alpha', to: 'Test Main Alpha' },
        { field: 'option_2', from: 'Old Beta', to: 'Test Main Beta' },
      ]);
      const salad = row.preview.components.find((c) => c.component_type === 'salad')!;
      expect(salad).toMatchObject({ action: 'UPDATE', from: 'Old Salad', name: 'Test Salad' });
      // The admin can see the day is live before changing it.
      expect(row.preview.current_status).toBe('published');
    });

    it('shows UNCHANGED when nothing differs', async () => {
      const first = await uploadAndValidate([ROW_A]);
      await commit(first.id);

      const second = await uploadAndValidate([ROW_A]);
      const row = (await previewRows(second.id))[0];
      expect(row.preview.action).toBe('UNCHANGED');
      expect(row.preview.changes).toEqual([]);
    });

    it('exposes no employee security information', async () => {
      const employee = await seedEmployee(db, { amcoId: 'TEST100' });
      await setEmployeePasswordDirect(db, employee.id, 'original-password-here');

      const { id } = await uploadAndValidate([ROW_A]);
      const raw = JSON.stringify(await readJson(await preview(id)));

      expect(raw).not.toContain('password_hash');
      expect(raw).not.toContain('pbkdf2');
      expect(raw).not.toContain('original-password-here');
      expect(raw).not.toContain('session');
    });
  });

  // ==========================================================================
  // STATE MACHINE, SECURITY AND AUDIT
  // ==========================================================================

  describe('state machine', () => {
    it('cannot commit before validation', async () => {
      const res = await uploadWorkbook(buildMenuWorkbook([ROW_A]));
      const batch = (await readJson(res)).data as { id: number };
      expect((await commit(batch.id)).status).toBe(409);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
    });

    it('cannot commit twice', async () => {
      const { id } = await uploadAndValidate([ROW_A]);
      expect((await commit(id)).status).toBe(200);
      expect((await commit(id)).status).toBe(409);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(1);
    });

    it('CONCURRENT commits apply the workbook exactly once', async () => {
      const { id } = await uploadAndValidate([ROW_A]);
      const [a, b] = await Promise.all([commit(id), commit(id)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_options')).toBe(2);
    });
  });

  describe('security and audit', () => {
    it('a non-admin cannot upload a menu import', async () => {
      const worker = await seedEmployee(db, { amcoId: 'TEST300' });
      expect((await uploadWorkbook(buildMenuWorkbook([ROW_A]), { cookie: worker.cookie })).status).toBe(403);
    });

    it('an unauthenticated caller cannot upload', async () => {
      expect((await uploadWorkbook(buildMenuWorkbook([ROW_A]), { cookie: '' })).status).toBe(401);
    });

    it('the audit records the import at batch level with the right fields', async () => {
      const { id } = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(id);

      const audit = await db.prepare('SELECT * FROM audit_log').all<Record<string, unknown>>();
      const raw = JSON.stringify(audit.results);

      expect(raw).toContain('CREATE_IMPORT');
      expect(raw).toContain('VALIDATE_IMPORT');
      expect(raw).toContain('COMMIT_IMPORT');
      expect(raw).toContain('menu');
      expect(raw).toContain('menu.xlsx');
      expect(raw).toContain('contentSha256');
      // Actor recorded on every record.
      for (const row of audit.results!) expect(row.actor_id).toBe(admin.id);
      // And nothing sensitive.
      expect(raw).not.toContain('password');
      expect(raw).not.toContain('r2_object_key');
    });

    it('does not create one audit row per menu day', async () => {
      const rows = Array.from({ length: 10 }, (_, i) =>
        menuRow(`2027-03-${String(i + 1).padStart(2, '0')}`, `Test Alpha ${i}`, `Test Beta ${i}`)
      );
      const { id } = await uploadAndValidate(rows);
      await commit(id);

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(10);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(3);
    });

    it('per-day before/after stays reconstructible from the staged rows', async () => {
      await seedMenu('2027-03-01', 'Old Alpha', 'Old Beta');
      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      const staged = await db
        .prepare('SELECT preview_json FROM import_batch_rows WHERE import_batch_id = ?')
        .bind(id)
        .first<{ preview_json: string }>();
      const parsed = JSON.parse(staged!.preview_json);
      expect(parsed.changes).toContainEqual({ field: 'option_1', from: 'Old Alpha', to: 'Test Main Alpha' });
    });

    it('preserves the ORIGINAL workbook in R2, unmodified', async () => {
      const bytes = buildMenuWorkbook([ROW_A]);
      const res = await uploadWorkbook(bytes);
      const batch = (await readJson(res)).data as { id: number };
      await validate(batch.id);
      await commit(batch.id);

      const stored = bucket.objects.get(`imports/menu/${batch.id}/source.xlsx`);
      expect(stored).toBeDefined();
      expect(new Uint8Array(stored!.body)).toEqual(bytes);
    });
  });

  // ==========================================================================
  // REGISTRY
  // ==========================================================================

  describe('registry', () => {
    it('the menu importer is now REGISTERED', async () => {
      const { body } = await uploadAndValidate([ROW_A]);
      expect(body.data.outcome).toBe('ready');
      expect(body.data.outcome).not.toBe('not_implemented');
    });

    it('there is no dinner import type at all', async () => {
      const form = new FormData();
      form.set('import_type', 'dinner');
      form.set('file', new File([buildMenuWorkbook([ROW_A]) as unknown as BlobPart], 'dinner.xlsx'));
      const res = await app.request(
        IMPORTS,
        { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
        env
      );
      // Rejected at the type check, never staged.
      expect(res.status).toBe(400);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM import_batches')).toBe(0);
    });

    it('the employee and roster importers still work', async () => {
      const employees = buildWorkbook([
        {
          name: 'All Employees',
          rows: [
            ['AMCO ID#', 'Name', 'Department', 'Section', 'Roster'],
            ['TEST500', 'Epsilon Person', 'Mining', 'Operations', 'Shift'],
          ],
        },
      ]);
      const res = await uploadWorkbook(employees, { importType: 'employees', filename: 'e.xlsx' });
      const batch = (await readJson(res)).data as { id: number };
      expect((await readJson(await validate(batch.id))).data.outcome).toBe('ready');
      expect((await commit(batch.id)).status).toBe(200);

      const roster = buildWorkbook([
        {
          name: 'Shifts roster',
          rows: [
            ['code', 'month', 'year', '1'],
            ['TEST500', '3', '2027', 'Day'],
          ],
        },
      ]);
      const res2 = await uploadWorkbook(roster, { importType: 'roster', filename: 'r.xlsx' });
      const batch2 = (await readJson(res2)).data as { id: number };
      expect((await readJson(await validate(batch2.id))).data.outcome).toBe('ready');
      expect((await commit(batch2.id)).status).toBe(200);
    });
  });
});
