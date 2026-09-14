// @vitest-environment node
/**
 * Integration Tests - identifying the lunch worksheet in a real-world workbook.
 *
 * Written against the file an administrator actually uploaded: one worksheet
 * called "Page 1", a title row reading "Lunch", and a header split across two
 * merged rows. Real Hono routes, real SQL against the real migrations, and the
 * real XLSX reader parsing genuine ZIP/SpreadsheetML built in-test.
 *
 * NOTHING from the source workbook is reproduced here except its STRUCTURE.
 * Every dish name is invented. No real menu text or business content appears in
 * this repository.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import {
  buildMenuWorkbook,
  buildRealWorldMenuWorkbook,
  buildWorkbook,
  menuRow,
  realWorldSheet,
  MENU_HEADERS,
  REAL_WORLD_UPPER_HEADERS,
  REAL_WORLD_LOWER_HEADERS,
} from '../helpers/xlsxFixture.js';
import {
  testEnv,
  seedEmployee,
  countRows,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const IMPORTS = `${BASE}/api/admin/imports`;

/**
 * Rows in the real-world column order:
 * [day, date, option 1, option 2, option meal 1, option meal 2, condiment,
 *  beverage, dessert].
 */
const DAY_ROWS: Array<Array<string | null>> = [
  ['Sun', '2027-04-04', 'Test Main Alpha', 'Test Main Beta', 'Test Salad', 'Test Yoghurt', 'Test Pickles', 'Test Juice', 'Test Fruit'],
  ['Mon', '2027-04-05', 'Test Main Gamma', 'Test Main Delta', 'Test Salad Two', null, null, null, null],
  ['Tue', '2027-04-06', 'Test Main Epsilon', 'Test Main Zeta', null, null, null, null, null],
  ['Wed', '2027-04-07', 'Test Main Eta', 'Test Main Theta', null, null, null, null, null],
];

describe('Lunch worksheet identification', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST910', roleId: ROLE_ADMIN });
  });

  const upload = (bytes: Uint8Array) => {
    const form = new FormData();
    form.set('import_type', 'menu');
    form.set('file', new File([bytes as unknown as BlobPart], 'menu.xlsx'));
    return app.request(IMPORTS, { method: 'POST', headers: { Cookie: admin.cookie }, body: form }, env);
  };

  const validate = (id: number) =>
    app.request(`${IMPORTS}/${id}/validate`, { method: 'POST', headers: { Cookie: admin.cookie } }, env);

  const detail = (id: number) =>
    app.request(`${IMPORTS}/${id}`, { headers: { Cookie: admin.cookie } }, env);

  const commit = (id: number, body: Record<string, unknown> = {}) =>
    app.request(
      `${IMPORTS}/${id}/commit`,
      {
        method: 'POST',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );

  const uploadAndValidate = async (bytes: Uint8Array) => {
    const res = await upload(bytes);
    expect(res.status).toBe(201);
    const batch = (await readJson(res)).data as { id: number };
    const body = await readJson(await validate(batch.id));
    return { id: batch.id, body };
  };

  const menuDayCount = () => countRows(db, 'SELECT COUNT(*) as n FROM menu_days');

  // ==========================================================================
  // A. An exactly-named "Lunch" worksheet is untouched by any of this
  // ==========================================================================

  describe('A. a worksheet named "Lunch"', () => {
    it('is accepted, with no confirmation required', async () => {
      const { body } = await uploadAndValidate(
        buildMenuWorkbook([menuRow('2027-04-04', 'Test Alpha', 'Test Beta')], { sheetName: 'Lunch' })
      );

      expect(body.data.outcome).toBe('ready');
      expect(body.data.sheet).toEqual({ name: 'Lunch', source: 'named' });
    });

    it('commits without a confirm_sheet field, exactly as before', async () => {
      const { id } = await uploadAndValidate(
        buildMenuWorkbook([menuRow('2027-04-04', 'Test Alpha', 'Test Beta')], { sheetName: 'Lunch' })
      );

      const res = await commit(id);
      expect(res.status).toBe(200);
      expect(await menuDayCount()).toBe(1);
    });

    it('is chosen by NAME even when another sheet would qualify on content', async () => {
      // Name beats content: the sheet called Lunch wins and the content-based
      // path never runs, so no confirmation is asked for.
      const bytes = buildWorkbook([
        realWorldSheet('Page 1', DAY_ROWS),
        { name: 'Lunch', rows: [MENU_HEADERS, menuRow('2027-05-01', 'Named Alpha', 'Named Beta')] },
      ]);

      const { id, body } = await uploadAndValidate(bytes);
      expect(body.data.sheet).toEqual({ name: 'Lunch', source: 'named' });

      expect((await commit(id)).status).toBe(200);
      const rows = await db
        .prepare('SELECT meal_date FROM menu_days ORDER BY meal_date')
        .all<{ meal_date: string }>();
      expect(rows.results?.map((r) => r.meal_date)).toEqual(['2027-05-01']);
    });
  });

  // ==========================================================================
  // B. The real workbook: "Page 1", title row, two-row merged header
  // ==========================================================================

  describe('B. a single worksheet identifiable only by its content', () => {
    it('is detected as a CANDIDATE and presented for confirmation', async () => {
      const { body } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));

      expect(body.data.outcome).toBe('ready');
      expect(body.data.sheet.name).toBe('Page 1');
      expect(body.data.sheet.source).toBe('candidate');
      expect(body.data.sheet.signals.length).toBeGreaterThan(0);
    });

    it('reads the two-row merged header: the title row is not data', async () => {
      const { id, body } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));

      expect(body.data.total_rows).toBe(DAY_ROWS.length);
      expect(body.data.invalid_rows).toBe(0);

      const rows = (await readJson(await detail(id))).data.preview_rows as Array<{
        preview: { meal_date: string; option_1: string; option_2: string; components: Array<{ component_type: string; name: string }> };
      }>;
      expect(rows[0].preview.meal_date).toBe('2027-04-04');
      expect(rows[0].preview.option_1).toBe('Test Main Alpha');
      expect(rows[0].preview.option_2).toBe('Test Main Beta');
      // "Option Meal 1/2" are still accompaniments, not selectable options.
      expect(rows[0].preview.components.map((c) => c.component_type)).toEqual([
        'salad', 'other', 'condiment', 'beverage', 'dessert',
      ]);
    });

    it('names the worksheet in the validation messages the administrator reads', async () => {
      const { body } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      const messages = JSON.stringify(body.data.messages);
      expect(messages).toContain('Page 1');
      expect(messages).toContain('Confirm');
    });

    it('reports the chosen worksheet on the preview endpoint too', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      const body = await readJson(await detail(id));
      expect(body.data.sheet).toMatchObject({ name: 'Page 1', source: 'candidate' });
    });

    it('REFUSES to commit until the worksheet is confirmed, and writes nothing', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));

      const res = await commit(id);
      expect(res.status).toBe(409);
      const body = await readJson<{ outcome: string; sheet: { name: string } }>(res);
      expect(body.outcome).toBe('confirmation_required');
      expect(body.sheet.name).toBe('Page 1');
      expect(await menuDayCount()).toBe(0);
    });

    it('REFUSES a confirmation naming a different worksheet', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));

      const res = await commit(id, { confirm_sheet: 'Dinner' });
      expect(res.status).toBe(409);
      expect(await menuDayCount()).toBe(0);
    });

    it('commits once the worksheet IS confirmed by name', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));

      const res = await commit(id, { confirm_sheet: 'Page 1' });
      expect(res.status).toBe(200);
      expect(await menuDayCount()).toBe(DAY_ROWS.length);

      const opts = await db
        .prepare(
          `SELECT o.option_number, o.name FROM menu_options o
             JOIN menu_days d ON d.id = o.menu_day_id
            WHERE d.meal_date = '2027-04-04' ORDER BY o.option_number`
        )
        .all<{ option_number: number; name: string }>();
      expect(opts.results).toEqual([
        { option_number: 1, name: 'Test Main Alpha' },
        { option_number: 2, name: 'Test Main Beta' },
      ]);
    });

    it('a refused commit leaves the batch committable, not stuck', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));

      expect((await commit(id)).status).toBe(409);
      const afterRefusal = await readJson(await detail(id));
      expect(afterRefusal.data.status).toBe('preview');

      expect((await commit(id, { confirm_sheet: 'Page 1' })).status).toBe(200);
    });

    it('publishes the days it commits, so they are immediately selectable', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      await commit(id, { confirm_sheet: 'Page 1' });

      const statuses = await db
        .prepare('SELECT DISTINCT status FROM menu_days')
        .all<{ status: string }>();
      expect(statuses.results).toEqual([{ status: 'published' }]);
    });
  });

  // ==========================================================================
  // C + D. Dinner is never lunch
  // ==========================================================================

  describe('C. a worksheet named "Dinner"', () => {
    it('is never classified as lunch, even alone and perfectly menu-shaped', async () => {
      const { body } = await uploadAndValidate(
        buildRealWorldMenuWorkbook(DAY_ROWS, { sheetName: 'Dinner' })
      );

      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('No lunch worksheet');
      expect(await menuDayCount()).toBe(0);
    });

    it('is never a candidate when its NAME is neutral but its title says dinner', async () => {
      // Content, not just the tab name: "Page 1" whose title cell reads Dinner
      // is a dinner sheet and must not be offered as lunch.
      const { body } = await uploadAndValidate(
        buildRealWorldMenuWorkbook(DAY_ROWS, { title: ['Dinner'] })
      );

      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('No lunch worksheet');
      expect(await menuDayCount()).toBe(0);
    });
  });

  describe('D. a workbook holding BOTH lunch and dinner', () => {
    it('selects lunch deterministically and never imports the dinner sheet', async () => {
      const dinnerRows: Array<Array<string | null>> = [
        ['Sun', '2027-04-04', 'Dinner Alpha', 'Dinner Beta', null, null, null, null, null],
      ];
      const bytes = buildWorkbook([
        realWorldSheet('Dinner', dinnerRows, ['Dinner']),
        { name: 'Lunch', rows: [MENU_HEADERS, menuRow('2027-04-04', 'Lunch Alpha', 'Lunch Beta')] },
      ]);

      const { id, body } = await uploadAndValidate(bytes);
      expect(body.data.sheet).toEqual({ name: 'Lunch', source: 'named' });

      expect((await commit(id)).status).toBe(200);
      const opts = await db
        .prepare(
          `SELECT o.name FROM menu_options o JOIN menu_days d ON d.id = o.menu_day_id
            WHERE d.meal_date = '2027-04-04' ORDER BY o.option_number`
        )
        .all<{ name: string }>();
      expect(opts.results?.map((r) => r.name)).toEqual(['Lunch Alpha', 'Lunch Beta']);
    });

    it('never falls back to a dinner sheet when the lunch sheet is unnamed', async () => {
      // "Page 1" says lunch and qualifies; "Dinner" is excluded outright rather
      // than competing with it.
      const bytes = buildWorkbook([
        realWorldSheet('Dinner', DAY_ROWS, ['Dinner']),
        realWorldSheet('Page 1', DAY_ROWS),
      ]);

      const { body } = await uploadAndValidate(bytes);
      expect(body.data.sheet).toMatchObject({ name: 'Page 1', source: 'candidate' });
    });
  });

  // ==========================================================================
  // E. Ambiguity is refused, never resolved by position
  // ==========================================================================

  describe('E. several plausible unnamed worksheets', () => {
    it('refuses with an explicit ambiguity error and commits nothing', async () => {
      const bytes = buildWorkbook([
        realWorldSheet('Page 1', DAY_ROWS),
        realWorldSheet('Page 2', DAY_ROWS),
      ]);

      const { id, body } = await uploadAndValidate(bytes);

      expect(body.data.outcome).toBe('failed');
      const messages = JSON.stringify(body.data.messages);
      expect(messages).toContain('More than one worksheet');
      expect(messages).toContain('Page 1');
      expect(messages).toContain('Page 2');
      expect(messages).toContain('rename');

      expect((await commit(id, { confirm_sheet: 'Page 1' })).status).toBe(409);
      expect(await menuDayCount()).toBe(0);
    });

    it('does not resolve the ambiguity by picking the first sheet', async () => {
      const bytes = buildWorkbook([
        realWorldSheet('Page 1', DAY_ROWS),
        realWorldSheet('Page 2', DAY_ROWS),
      ]);
      const { body } = await uploadAndValidate(bytes);
      expect(body.data.sheet).toBeNull();
      expect(await menuDayCount()).toBe(0);
    });
  });

  // ==========================================================================
  // F. Nothing plausible at all
  // ==========================================================================

  describe('F. no plausible lunch worksheet', () => {
    it('rejects a menu-SHAPED sheet that never says lunch', async () => {
      // Structure alone is not evidence: "Sheet1" with the right columns but no
      // lunch wording anywhere is refused rather than guessed at.
      const { body } = await uploadAndValidate(
        buildWorkbook([{ name: 'Sheet1', rows: [MENU_HEADERS, menuRow('2027-04-04', 'A', 'B')] }])
      );

      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('No lunch worksheet');
      expect(await menuDayCount()).toBe(0);
    });

    it('rejects a sheet that says lunch but has no menu structure', async () => {
      const { body } = await uploadAndValidate(
        buildWorkbook([
          {
            name: 'Page 1',
            rows: [['Lunch'], ['Notes', 'Owner'], ['Ask catering', 'Facilities']],
          },
        ])
      );

      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('No lunch worksheet');
    });

    it('rejects a lunch-titled TEMPLATE carrying no real dates', async () => {
      const { body } = await uploadAndValidate(
        buildRealWorldMenuWorkbook([
          ['Sun', '', 'Test Alpha', 'Test Beta', null, null, null, null, null],
          ['Mon', '', 'Test Gamma', 'Test Delta', null, null, null, null, null],
        ])
      );

      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('No lunch worksheet');
    });

    it('names the sheets the workbook actually contains', async () => {
      const { body } = await uploadAndValidate(
        buildWorkbook([{ name: 'Quarterly Costs', rows: [['Item', 'Amount'], ['Test', '1']] }])
      );
      expect(JSON.stringify(body.data.messages)).toContain('Quarterly Costs');
    });
  });

  // ==========================================================================
  // G. The lifecycle itself is unchanged
  // ==========================================================================

  describe('G. upload -> validate -> preview -> confirm -> commit', () => {
    it('writes NO menu data at upload, validate or preview', async () => {
      const res = await upload(buildRealWorldMenuWorkbook(DAY_ROWS));
      const batch = (await readJson(res)).data as { id: number };
      expect(await menuDayCount()).toBe(0);

      await validate(batch.id);
      expect(await menuDayCount()).toBe(0);

      await detail(batch.id);
      expect(await menuDayCount()).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_options')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_components')).toBe(0);
    });

    it('is still the only path that writes: commit alone changes data', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      expect(await menuDayCount()).toBe(0);
      await commit(id, { confirm_sheet: 'Page 1' });
      expect(await menuDayCount()).toBe(DAY_ROWS.length);
    });

    it('records the import in history exactly as before', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      await commit(id, { confirm_sheet: 'Page 1' });

      const body = await readJson(await detail(id));
      expect(body.data.status).toBe('committed');
      expect(body.data.import_type).toBe('menu');
      expect(
        await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'COMMIT_IMPORT'")
      ).toBe(1);
    });

    it('a refused confirmation writes NO audit COMMIT row', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      await commit(id);
      expect(
        await countRows(
          db,
          "SELECT COUNT(*) as n FROM audit_log WHERE action IN ('COMMIT_IMPORT', 'COMMIT_FAILED_IMPORT')"
        )
      ).toBe(0);
    });

    it('re-committing the same confirmed batch is still refused', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      expect((await commit(id, { confirm_sheet: 'Page 1' })).status).toBe(200);
      expect((await commit(id, { confirm_sheet: 'Page 1' })).status).toBe(409);
      expect(await menuDayCount()).toBe(DAY_ROWS.length);
    });

    it('touches nothing outside the menu tables', async () => {
      const before = {
        employees: await countRows(db, 'SELECT COUNT(*) as n FROM employees'),
        selections: await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections'),
        roster: await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries'),
      };

      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      await commit(id, { confirm_sheet: 'Page 1' });

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM employees')).toBe(before.employees);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(before.selections);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(before.roster);
    });

    it('a candidate workbook is still idempotent: re-importing writes nothing new', async () => {
      const first = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      await commit(first.id, { confirm_sheet: 'Page 1' });

      const second = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      await commit(second.id, { confirm_sheet: 'Page 1' });

      expect(await menuDayCount()).toBe(DAY_ROWS.length);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_options')).toBe(DAY_ROWS.length * 2);
    });
  });

  // ==========================================================================
  // A full month in the printed date form, the shape the real file uses
  // ==========================================================================

  describe('a full month in the real-world shape', () => {
    /** 30 days, dated as the printed menu writes them: 1-Sep-26. */
    const september = (): Array<Array<string | null>> =>
      Array.from({ length: 30 }, (_, i) => [
        ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i % 7],
        `${i + 1}-Sep-26`,
        `Test Main A${i + 1}`,
        `Test Main B${i + 1}`,
        'Test Salad',
        'Test Yoghurt',
        'Test Pickles',
        'Test Juice',
        'Test Fruit',
      ]);

    it('validates all 30 days and stages them for confirmation', async () => {
      const { body } = await uploadAndValidate(buildRealWorldMenuWorkbook(september()));

      expect(body.data.outcome).toBe('ready');
      expect(body.data.total_rows).toBe(30);
      expect(body.data.invalid_rows).toBe(0);
      expect(body.data.sheet).toMatchObject({ name: 'Page 1', source: 'candidate' });
    });

    it('commits the whole month once confirmed, published', async () => {
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(september()));
      expect((await commit(id, { confirm_sheet: 'Page 1' })).status).toBe(200);

      expect(await menuDayCount()).toBe(30);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_options')).toBe(60);
      expect(
        await countRows(db, "SELECT COUNT(*) as n FROM menu_days WHERE status = 'published'")
      ).toBe(30);

      const first = await db
        .prepare("SELECT meal_date FROM menu_days ORDER BY meal_date LIMIT 1")
        .first<{ meal_date: string }>();
      const last = await db
        .prepare("SELECT meal_date FROM menu_days ORDER BY meal_date DESC LIMIT 1")
        .first<{ meal_date: string }>();
      expect(first?.meal_date).toBe('2026-09-01');
      expect(last?.meal_date).toBe('2026-09-30');
    });
  });

  // ==========================================================================
  // Header location, independently of which sheet was chosen
  // ==========================================================================

  describe('header location', () => {
    it('still treats row 1 as the header when that is where it is', async () => {
      const { body } = await uploadAndValidate(
        buildMenuWorkbook([menuRow('2027-04-04', 'Test Alpha', 'Test Beta')], { sheetName: 'Lunch' })
      );
      expect(body.data.total_rows).toBe(1);
      expect(body.data.outcome).toBe('ready');
    });

    it('finds a header pushed down by title and blank rows', async () => {
      const bytes = buildWorkbook([
        {
          name: 'Lunch',
          rows: [
            ['Lunch'],
            [],
            ['Prepared by Facilities'],
            MENU_HEADERS,
            menuRow('2027-04-04', 'Test Alpha', 'Test Beta') as string[],
          ],
        },
      ]);

      const { body } = await uploadAndValidate(bytes);
      expect(body.data.outcome).toBe('ready');
      expect(body.data.total_rows).toBe(1);
    });

    it('still reports a missing required column when no row supplies one', async () => {
      const bytes = buildWorkbook([
        {
          name: 'Lunch',
          rows: [
            ['Lunch'],
            ['Day', 'Date', 'Option 1'],
            ['Sun', '2027-04-04', 'Only one option'],
          ],
        },
      ]);

      const { body } = await uploadAndValidate(bytes);
      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('option_2');
    });

    it('still refuses a third selectable option found in a two-row header', async () => {
      const bytes = buildWorkbook([
        {
          name: 'Lunch',
          rows: [
            ['Lunch'],
            REAL_WORLD_UPPER_HEADERS.concat(['Option 3']),
            REAL_WORLD_LOWER_HEADERS.concat([null]),
            ['Sun', '2027-04-04', 'A', 'B', null, null, null, null, null, 'C'],
          ],
        },
      ]);

      const { body } = await uploadAndValidate(bytes);
      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('two selectable options');
    });

    it('does not read a data row as a header', async () => {
      // The header is found top-down, so the genuine one always wins.
      const { id } = await uploadAndValidate(buildRealWorldMenuWorkbook(DAY_ROWS));
      const rows = (await readJson(await detail(id))).data.preview_rows as Array<{
        row_number: number;
        preview: { meal_date: string };
      }>;
      // Rows 1-3 are title and header; data starts at spreadsheet row 4.
      expect(rows[0].row_number).toBe(4);
      expect(rows.map((r) => r.preview.meal_date)).toEqual([
        '2027-04-04', '2027-04-05', '2027-04-06', '2027-04-07',
      ]);
    });
  });
});
