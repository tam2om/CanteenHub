// @vitest-environment node
/**
 * Integration Tests - meal collection points, the Excel export, role changes,
 * and the import columns that came with them.
 *
 * Real Hono routes, real SQL against the real migrations, the real XLSX reader
 * checking the real XLSX writer. Every name and password here is invented.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { buildEmployeeWorkbook } from '../helpers/xlsxFixture.js';
import { readWorksheet, listWorksheets } from '../../src/worker/lib/xlsx.js';
import {
  testEnv,
  seedEmployee,
  seedMenuDay,
  countRows,
  readJson,
  setSetting,
  ROLE_ADMIN,
  ROLE_EMPLOYEE,
  ROLE_SUPER_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const DATE = '2027-06-06'; // A Sunday - a regular working day.

describe('Meal collection points', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST600', roleId: ROLE_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST601', defaultLocation: 'omco_canteen' });
    const dayId = await seedMenuDay(db, DATE, 'published');
    await db
      .prepare('INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 1, ?)')
      .bind(dayId, 'Test Main One')
      .run();
    await db
      .prepare('INSERT INTO menu_options (menu_day_id, option_number, name) VALUES (?, 2, ?)')
      .bind(dayId, 'Test Main Two')
      .run();
    await setSetting(db, 'lunch_cutoff_time', '"23:59"');
  });

  const select = (cookie: string, body: Record<string, unknown>) =>
    app.request(
      `${BASE}/api/selections/me`,
      {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );

  const storedLocation = async (employeeId: number) =>
    (
      await db
        .prepare('SELECT pickup_location FROM lunch_selections WHERE employee_id = ? AND meal_date = ?')
        .bind(employeeId, DATE)
        .first<{ pickup_location: string }>()
    )?.pickup_location;

  /**
   * Where the meal is collected is REQUIRED on every submission.
   *
   * It used to be optional and fall back to the employee's usual canteen. That
   * is exactly the case it got wrong: someone working at another site for the
   * day had a portion sent to where they normally eat, and nobody was asked.
   */
  it('a selection with no location is REFUSED, not defaulted', async () => {
    const res = await select(employee.cookie, { meal_date: DATE, choice: 'option_1' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(await readJson(res))).toMatch(/where you will collect/i);
    expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(0);
  });

  it('an employee can choose a different canteen for the day', async () => {
    const res = await select(employee.cookie, {
      meal_date: DATE,
      choice: 'option_1',
      pickup_location: 'whc_canteen',
    });
    expect(res.status).toBe(201);
    expect(await storedLocation(employee.id)).toBe('whc_canteen');
  });

  it('the per-day choice does NOT change the employee default', async () => {
    await select(employee.cookie, {
      meal_date: DATE,
      choice: 'option_1',
      pickup_location: 'whc_canteen',
    });
    const row = await db
      .prepare('SELECT default_location FROM employees WHERE id = ?')
      .bind(employee.id)
      .first<{ default_location: string }>();
    expect(row!.default_location).toBe('omco_canteen');
  });

  it('an unrecognised canteen is REFUSED, never defaulted', async () => {
    const res = await select(employee.cookie, {
      meal_date: DATE,
      choice: 'option_1',
      pickup_location: 'canteen_on_the_moon',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await readJson(res))).toContain('pickup_location must be one of');
    expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(0);
  });

  it('a later change must say where again, and is refused without it', async () => {
    await select(employee.cookie, {
      meal_date: DATE,
      choice: 'option_1',
      pickup_location: 'whc_canteen',
    });

    const res = await select(employee.cookie, { meal_date: DATE, choice: 'option_2' });

    expect(res.status).toBe(400);
    // Refused outright: the stored selection is untouched, not half-changed.
    expect(await storedLocation(employee.id)).toBe('whc_canteen');
    const stored = await db
      .prepare('SELECT choice FROM lunch_selections WHERE employee_id = ?')
      .bind(employee.id)
      .first<{ choice: string }>();
    expect(stored!.choice).toBe('option_1');
  });

  it('changing ONLY the canteen is a real change, and is recorded', async () => {
    await select(employee.cookie, {
      meal_date: DATE,
      choice: 'option_1',
      pickup_location: 'omco_canteen',
    });
    const res = await select(employee.cookie, {
      meal_date: DATE,
      choice: 'option_1',
      pickup_location: 'amco_canteen',
    });

    expect(res.status).toBe(200);
    expect((await readJson(res)).changed).toBe(true);
    expect(await storedLocation(employee.id)).toBe('amco_canteen');

    const history = await db
      .prepare(
        'SELECT previous_location, new_location FROM lunch_selection_history WHERE employee_id = ? ORDER BY id DESC LIMIT 1'
      )
      .bind(employee.id)
      .first<{ previous_location: string; new_location: string }>();
    expect(history).toMatchObject({
      previous_location: 'omco_canteen',
      new_location: 'amco_canteen',
    });
  });

  it('re-submitting the identical choice AND canteen writes nothing', async () => {
    await select(employee.cookie, {
      meal_date: DATE,
      choice: 'option_1',
      pickup_location: 'omco_canteen',
    });
    const before = await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history');

    const res = await select(employee.cookie, {
      meal_date: DATE,
      choice: 'option_1',
      pickup_location: 'omco_canteen',
    });
    expect((await readJson(res)).changed).toBe(false);
    expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history')).toBe(before);
  });

  // ==========================================================================
  // The report
  // ==========================================================================

  it('the report counts portions at the canteen the EMPLOYEE chose', async () => {
    const a = await seedEmployee(db, { amcoId: 'TEST610', defaultLocation: 'omco_canteen' });
    const b = await seedEmployee(db, { amcoId: 'TEST611', defaultLocation: 'omco_canteen' });
    const c = await seedEmployee(db, { amcoId: 'TEST612', defaultLocation: 'whc_canteen' });
    await select(a.cookie, { meal_date: DATE, choice: 'option_1', pickup_location: 'omco_canteen' });
    await select(b.cookie, { meal_date: DATE, choice: 'option_1', pickup_location: 'omco_canteen' });
    await select(c.cookie, { meal_date: DATE, choice: 'option_2', pickup_location: 'whc_canteen' });

    const body = await readJson(
      await app.request(`${BASE}/api/admin/reports/lunch?date=${DATE}`, { headers: { Cookie: admin.cookie } }, env)
    );
    const byLocation = body.data.by_location as Array<Record<string, number | string>>;

    const omco = byLocation.find((l) => l.location === 'omco_canteen')!;
    const whc = byLocation.find((l) => l.location === 'whc_canteen')!;
    // `employee` (TEST601) is eligible and chose nothing: one defaulted Option 1
    // portion at their usual canteen, OMCO.
    expect(omco.option_1).toBe(3);
    expect(omco.defaulted_to_option_1).toBe(1);
    expect(omco.total).toBe(3);
    expect(whc.option_2).toBe(1);
    expect(whc.total).toBe(1);
  });

  it('every canteen appears, including one with no orders', async () => {
    const body = await readJson(
      await app.request(`${BASE}/api/admin/reports/lunch?date=${DATE}`, { headers: { Cookie: admin.cookie } }, env)
    );
    const byLocation = body.data.by_location as Array<{
      location: string;
      total: number;
      defaulted_to_option_1: number;
    }>;
    expect(byLocation.map((l) => l.location)).toEqual([
      'amco_canteen',
      'omco_canteen',
      'whc_canteen',
    ]);

    // Nobody has chosen anything, but the two seeded employees are eligible on
    // this Sunday and are cooked for as Option 1 at their own canteens - AMCO
    // for the admin, OMCO for the employee. WHC has nobody at all.
    const whc = byLocation.find((l) => l.location === 'whc_canteen')!;
    expect(whc.total).toBe(0);
    expect(byLocation.reduce((sum, l) => sum + l.defaulted_to_option_1, 0)).toBe(
      byLocation.reduce((sum, l) => sum + l.total, 0)
    );
  });

  // ==========================================================================
  // The Excel export
  // ==========================================================================

  describe('Excel export', () => {
    const download = (cookie: string | null) =>
      app.request(
        `${BASE}/api/admin/reports/lunch.xlsx?date=${DATE}`,
        cookie ? { headers: { Cookie: cookie } } : {},
        env
      );

    it('is refused to anonymous callers and to employees', async () => {
      expect((await download(null)).status).toBe(401);
      expect((await download(employee.cookie)).status).toBe(403);
    });

    it('returns a real .xlsx as an attachment', async () => {
      const res = await download(admin.cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      expect(res.headers.get('Content-Disposition')).toContain(`canteenhub-lunch-${DATE}.xlsx`);

      const bytes = new Uint8Array(await res.arrayBuffer());
      // A real ZIP, which is what an .xlsx is.
      expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    });

    it('has a Totals sheet and a Detail sheet the app can read back', async () => {
      const res = await download(admin.cookie);
      const buffer = await res.arrayBuffer();
      expect(await listWorksheets(buffer)).toEqual(['Totals', 'Detail']);
    });

    it('the Totals sheet carries the per-canteen quantities', async () => {
      const a = await seedEmployee(db, { amcoId: 'TEST620', defaultLocation: 'omco_canteen' });
      await select(a.cookie, { meal_date: DATE, choice: 'option_1', pickup_location: 'omco_canteen' });

      const buffer = await (await download(admin.cookie)).arrayBuffer();
      const sheet = await readWorksheet(buffer, 'Totals');
      const rows = sheet.rows.map((r) => [...r.cells.values()]);

      expect(rows[0]).toEqual([
        'Canteen', 'Option 1', 'Option 2', 'Healthy meal', 'Total portions',
        'Of which not chosen',
      ]);
      const omcoRow = rows.find((r) => r[0] === 'OMCO Canteen')!;
      // TEST620 chose Option 1; TEST601 chose nothing and is counted as one too.
      expect(omcoRow[1]).toBe('2');
      expect(omcoRow[5]).toBe('1'); // exactly one of them was a default
      expect(rows.some((r) => r[0] === 'AMCO Canteen')).toBe(true);
      expect(rows.some((r) => r[0] === 'WHC Canteen')).toBe(true);
    });

    it('the Totals sheet counts a CONFIRMED healthy meal in its own column', async () => {
      const healthy = await seedEmployee(db, {
        amcoId: 'TEST630',
        defaultLocation: 'whc_canteen',
        mealPreference: 'healthy',
      });
      // They log in and confirm the day - what their own screen sends.
      await select(healthy.cookie, { meal_date: DATE, choice: 'healthy', pickup_location: 'whc_canteen' });

      const buffer = await (await download(admin.cookie)).arrayBuffer();
      const sheet = await readWorksheet(buffer, 'Totals');
      const rows = sheet.rows.map((r) => [...r.cells.values()]);

      const whcRow = rows.find((r) => r[0] === 'WHC Canteen')!;
      expect(whcRow[3]).toBe('1'); // Healthy meal
      expect(whcRow[4]).toBe('1'); // and it IS a portion to send
    });

    it('an UNCONFIRMED healthy meal is not prepared, and the sheet says how many', async () => {
      await seedEmployee(db, {
        amcoId: 'TEST631',
        defaultLocation: 'whc_canteen',
        mealPreference: 'healthy',
      }); // on leave: never logs in

      const buffer = await (await download(admin.cookie)).arrayBuffer();
      const sheet = await readWorksheet(buffer, 'Totals');
      const rows = sheet.rows.map((r) => [...r.cells.values()]);

      const whcRow = rows.find((r) => r[0] === 'WHC Canteen')!;
      expect(whcRow[3]).toBe('0');
      expect(whcRow[4]).toBe('0');
      expect(rows.find((r) => r[0] === 'Healthy meal not confirmed (not prepared)')![1]).toBe('1');
    });

    it('the Detail sheet says what is served AND whether it was chosen', async () => {
      await select(employee.cookie, {
        meal_date: DATE,
        choice: 'option_2',
        pickup_location: 'omco_canteen',
      });
      await seedEmployee(db, { amcoId: 'TEST640' }); // chooses nothing
      const confirmed = await seedEmployee(db, { amcoId: 'TEST650', mealPreference: 'healthy' });
      await select(confirmed.cookie, { meal_date: DATE, choice: 'healthy', pickup_location: 'amco_canteen' });
      await seedEmployee(db, { amcoId: 'TEST660', mealPreference: 'healthy' }); // does not confirm

      const buffer = await (await download(admin.cookie)).arrayBuffer();
      const sheet = await readWorksheet(buffer, 'Detail');
      const rows = sheet.rows.map((r) => [...r.cells.values()]);

      expect(rows[0]).toEqual([
        'ID', 'Name', 'Department', 'Section', 'Roster', 'Eligible', 'Reason',
        'Served', 'Chose', 'Canteen',
      ]);

      const chooser = rows.find((r) => r[0] === 'TEST601')!;
      expect(chooser[7]).toBe('Option 2');
      expect(chooser[8]).toBe('Option 2');
      expect(chooser[9]).toBe('OMCO Canteen');

      // Served a portion, but the kitchen can see nobody asked for it.
      const silent = rows.find((r) => r[0] === 'TEST640')!;
      expect(silent[7]).toBe('Option 1');
      expect(silent[8]).toBe('Not chosen');

      const healthy = rows.find((r) => r[0] === 'TEST650')!;
      expect(healthy[7]).toBe('Healthy meal');
      expect(healthy[8]).toBe('Healthy meal (confirmed)');

      // Eligible, on the healthy meal, never confirmed: nothing served, and the
      // row says why rather than looking like an oversight. Matched as whole
      // cells, since an empty "Served" cell may not be written at all.
      const unconfirmed = rows.find((r) => r[0] === 'TEST660')!;
      expect(unconfirmed).toContain('Healthy meal - NOT confirmed');
      expect(unconfirmed).not.toContain('Healthy meal');
    });

    it('exports a date with no menu without failing', async () => {
      const res = await app.request(
        `${BASE}/api/admin/reports/lunch.xlsx?date=2027-06-13`,
        { headers: { Cookie: admin.cookie } },
        env
      );
      expect(res.status).toBe(200);
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    });

    it('refuses a malformed date', async () => {
      const res = await app.request(
        `${BASE}/api/admin/reports/lunch.xlsx?date=not-a-date`,
        { headers: { Cookie: admin.cookie } },
        env
      );
      expect(res.status).toBe(400);
    });
  });
});

// ============================================================================
// Role assignment
// ============================================================================

describe('Assigning the super administrator role', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let superAdmin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST630', roleId: ROLE_ADMIN });
    superAdmin = await seedEmployee(db, { amcoId: 'TEST631', roleId: ROLE_SUPER_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST632', roleId: ROLE_EMPLOYEE });
  });

  const updateRole = (cookie: string, id: number, roleId: number) =>
    app.request(
      `${BASE}/api/admin/employees/${id}`,
      {
        method: 'PUT',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role_id: roleId }),
      },
      env
    );

  const roleOf = async (id: number) =>
    (
      await db.prepare('SELECT role_id FROM employees WHERE id = ?').bind(id).first<{ role_id: number }>()
    )?.role_id;

  it('a SUPER administrator can promote an employee to super administrator', async () => {
    const res = await updateRole(superAdmin.cookie, employee.id, ROLE_SUPER_ADMIN);
    expect(res.status).toBe(200);
    expect(await roleOf(employee.id)).toBe(ROLE_SUPER_ADMIN);
  });

  it('a super administrator can still make someone an ordinary administrator', async () => {
    expect((await updateRole(superAdmin.cookie, employee.id, ROLE_ADMIN)).status).toBe(200);
    expect(await roleOf(employee.id)).toBe(ROLE_ADMIN);
  });

  it('an ordinary administrator CANNOT grant the super administrator role', async () => {
    const res = await updateRole(admin.cookie, employee.id, ROLE_SUPER_ADMIN);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await readJson(res))).toContain('Only a super administrator');
    expect(await roleOf(employee.id)).toBe(ROLE_EMPLOYEE);
  });

  it('an ordinary administrator cannot promote THEMSELVES', async () => {
    const res = await updateRole(admin.cookie, admin.id, ROLE_SUPER_ADMIN);
    expect(res.status).toBe(403);
    expect(await roleOf(admin.id)).toBe(ROLE_ADMIN);
  });

  it('an ordinary administrator cannot DEMOTE a super administrator', async () => {
    const res = await updateRole(admin.cookie, superAdmin.id, ROLE_ADMIN);
    expect(res.status).toBe(403);
    expect(await roleOf(superAdmin.id)).toBe(ROLE_SUPER_ADMIN);
  });

  it('an ordinary administrator can still manage ordinary roles', async () => {
    expect((await updateRole(admin.cookie, employee.id, ROLE_ADMIN)).status).toBe(200);
    expect(await roleOf(employee.id)).toBe(ROLE_ADMIN);
  });

  it('an ordinary administrator cannot CREATE a super administrator', async () => {
    const res = await app.request(
      `${BASE}/api/admin/employees`,
      {
        method: 'POST',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amco_id: 'TEST639',
          full_name: 'Test Escalation',
          roster_type: 'regular',
          role_id: ROLE_SUPER_ADMIN,
        }),
      },
      env
    );
    expect(res.status).toBe(403);
    expect(await countRows(db, "SELECT COUNT(*) as n FROM employees WHERE amco_id = 'TEST639'")).toBe(0);
  });

  it('a super administrator CAN create one', async () => {
    const res = await app.request(
      `${BASE}/api/admin/employees`,
      {
        method: 'POST',
        headers: { Cookie: superAdmin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amco_id: 'TEST640',
          full_name: 'Test Super',
          roster_type: 'regular',
          role_id: ROLE_SUPER_ADMIN,
        }),
      },
      env
    );
    expect(res.status).toBe(201);
  });

  it('an employee cannot reach the endpoint at all', async () => {
    expect((await updateRole(employee.cookie, employee.id, ROLE_ADMIN)).status).toBe(403);
  });
});

// ============================================================================
// The employee import: location, password, and whole-batch counts
// ============================================================================

describe('Employee import - location and password columns', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST650', roleId: ROLE_ADMIN });
  });

  const uploadAndValidate = async (bytes: Uint8Array) => {
    const form = new FormData();
    form.set('import_type', 'employees');
    form.set('file', new File([bytes as unknown as BlobPart], 'employees.xlsx'));
    const up = await app.request(
      `${BASE}/api/admin/imports`,
      { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
      env
    );
    const batch = (await readJson(up)).data as { id: number };
    const body = await readJson(
      await app.request(
        `${BASE}/api/admin/imports/${batch.id}/validate`,
        { method: 'POST', headers: { Cookie: admin.cookie } },
        env
      )
    );
    return { id: batch.id, body };
  };

  const commit = (id: number) =>
    app.request(
      `${BASE}/api/admin/imports/${id}/commit`,
      { method: 'POST', headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' }, body: '{}' },
      env
    );

  const HEADERS = ['AMCO ID#', 'Name', 'Department', 'Section', 'Roster', 'Location', 'Password'];

  it('imports the canteen from a Location column', async () => {
    const bytes = buildEmployeeWorkbook(
      [
        ['TEST660', 'Test One', 'Dept', 'Sect', 'Regular', 'OMCO Canteen', null],
        ['TEST661', 'Test Two', 'Dept', 'Sect', 'Regular', 'WHC Canteen', null],
      ],
      { headers: HEADERS }
    );
    const { id, body } = await uploadAndValidate(bytes);
    expect(body.data.outcome).toBe('ready');
    expect((await commit(id)).status).toBe(200);

    const rows = await db
      .prepare("SELECT amco_id, default_location FROM employees WHERE amco_id LIKE 'TEST66%' ORDER BY amco_id")
      .all<{ amco_id: string; default_location: string }>();
    expect(rows.results).toEqual([
      { amco_id: 'TEST660', default_location: 'omco_canteen' },
      { amco_id: 'TEST661', default_location: 'whc_canteen' },
    ]);
  });

  it('a blank Location falls back to the default, it does not fail', async () => {
    const bytes = buildEmployeeWorkbook(
      [['TEST662', 'Test Three', 'Dept', 'Sect', 'Regular', '', null]],
      { headers: HEADERS }
    );
    const { id } = await uploadAndValidate(bytes);
    await commit(id);
    const row = await db
      .prepare("SELECT default_location FROM employees WHERE amco_id = 'TEST662'")
      .first<{ default_location: string }>();
    expect(row!.default_location).toBe('amco_canteen');
  });

  it('an unrecognised Location REJECTS the row rather than guessing', async () => {
    const bytes = buildEmployeeWorkbook(
      [['TEST663', 'Test Four', 'Dept', 'Sect', 'Regular', 'Moon Canteen', null]],
      { headers: HEADERS }
    );
    const { body } = await uploadAndValidate(bytes);
    expect(body.data.outcome).toBe('failed');
    expect(body.data.invalid_rows).toBe(1);
  });

  it('a password column NEVER puts the plaintext in the stored preview', async () => {
    const bytes = buildEmployeeWorkbook(
      [['TEST664', 'Test Five', 'Dept', 'Sect', 'Regular', '', 'Secret!2027']],
      { headers: HEADERS }
    );
    const { id, body } = await uploadAndValidate(bytes);
    expect(body.data.outcome).toBe('ready');

    const staged = await db
      .prepare('SELECT preview_json FROM import_batch_rows WHERE import_batch_id = ?')
      .bind(id)
      .all<{ preview_json: string }>();
    const raw = JSON.stringify(staged.results);
    expect(raw).not.toContain('Secret!2027');
    // A flag instead, so the screen can say a password is present.
    expect(raw).toContain('password_supplied');

    await commit(id);
    const row = await db
      .prepare("SELECT password_hash FROM employees WHERE amco_id = 'TEST664'")
      .first<{ password_hash: string | null }>();
    // The commit itself does NOT set passwords - that is the separate step.
    expect(row!.password_hash).toBeNull();
  });

  it('a password below the shared minimum rejects the row', async () => {
    const bytes = buildEmployeeWorkbook(
      [['TEST665', 'Test Six', 'Dept', 'Sect', 'Regular', '', 'abcd']],
      { headers: HEADERS }
    );
    const { body } = await uploadAndValidate(bytes);
    expect(body.data.outcome).toBe('failed');
    expect(body.data.invalid_rows).toBe(1);
    // The rule is named; the value is not echoed.
    expect(JSON.stringify(body.data.messages)).not.toContain('abcd');
  });

  it('a workbook with no Location or Password column still imports', async () => {
    const bytes = buildEmployeeWorkbook([['TEST666', 'Test Seven', 'Dept', 'Sect', 'Regular']]);
    const { id, body } = await uploadAndValidate(bytes);
    expect(body.data.outcome).toBe('ready');
    expect((await commit(id)).status).toBe(200);
  });

  // ------------------------------------------------------------------------
  // The counting defect
  // ------------------------------------------------------------------------

  it('reports WHOLE-BATCH action counts, not just the preview page', async () => {
    // More rows than MAX_PREVIEW_ROWS (100), which is what made a 253-row
    // import report "86 new": the client counted the page it was given.
    const rows = Array.from({ length: 150 }, (_, i) => [
      `TEST${7000 + i}`,
      `Test Person ${i}`,
      'Dept',
      'Sect',
      'Regular',
    ]);
    const { id, body } = await uploadAndValidate(buildEmployeeWorkbook(rows));

    expect(body.data.total_rows).toBe(150);
    expect(body.data.action_counts).toEqual({
      CREATE: 150,
      UPDATE: 0,
      UNCHANGED: 0,
      INVALID: 0,
    });

    // The preview really is capped, which is why the counts must not come from it.
    const detail = await readJson(
      await app.request(`${BASE}/api/admin/imports/${id}`, { headers: { Cookie: admin.cookie } }, env)
    );
    expect(detail.data.preview_rows.length).toBe(100);
    expect(detail.data.preview_row_limit).toBe(100);
    expect(detail.data.action_counts.CREATE).toBe(150);

    // And committing really does create all of them.
    expect((await commit(id)).status).toBe(200);
    expect(
      await countRows(db, "SELECT COUNT(*) as n FROM employees WHERE amco_id LIKE 'TEST7%'")
    ).toBe(150);
  });

  it('counts a mixed batch correctly across the cap', async () => {
    await seedEmployee(db, { amcoId: 'TEST7000', fullName: 'Test Person 0' });
    const rows = Array.from({ length: 120 }, (_, i) => [
      `TEST${7000 + i}`,
      `Test Person ${i}`,
      'Test Department',
      'Test Section',
      'Regular',
    ]);
    const { body } = await uploadAndValidate(buildEmployeeWorkbook(rows));

    const counts = body.data.action_counts as Record<string, number>;
    expect(counts.CREATE + counts.UPDATE + counts.UNCHANGED + counts.INVALID).toBe(120);
    expect(counts.CREATE).toBe(119);
    expect(counts.UNCHANGED + counts.UPDATE).toBe(1);
  });
});

// ============================================================================
// The employee list is PAGED - which the password step has to respect
// ============================================================================

describe('Employee list paging', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST670', roleId: ROLE_ADMIN });
    for (let i = 0; i < 120; i++) {
      await seedEmployee(db, { amcoId: `TESTP${String(i).padStart(3, '0')}` });
    }
  });

  const list = (query: string) =>
    app.request(`${BASE}/api/admin/employees?${query}`, { headers: { Cookie: admin.cookie } }, env);

  it('caps page_size at 100 however large a value is asked for', async () => {
    // The reason this matters: a caller that asks for 1000 and assumes it got
    // everything silently loses every employee past the first 100.
    const body = await readJson(await list('page_size=1000&page=1'));
    expect(body.data.employees.length).toBe(100);
    expect(body.data.total).toBe(121);
  });

  it('returns the remainder on the next page, so paging reaches everyone', async () => {
    const first = await readJson(await list('page_size=100&page=1'));
    const second = await readJson(await list('page_size=100&page=2'));

    const ids = new Set<string>([
      ...first.data.employees.map((e: { amco_id: string }) => e.amco_id),
      ...second.data.employees.map((e: { amco_id: string }) => e.amco_id),
    ]);
    expect(ids.size).toBe(121);
    expect(ids.has('TESTP000')).toBe(true);
    expect(ids.has('TESTP119')).toBe(true);
  });
});
