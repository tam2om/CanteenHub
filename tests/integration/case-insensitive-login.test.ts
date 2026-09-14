// @vitest-environment node
/**
 * Integration Tests - signing in without worrying about capitals.
 *
 * The ID is matched case-insensitively. Two things follow from that and are
 * tested here as hard as the feature itself: the lockout bucket must be
 * case-insensitive too, or an attacker gets a fresh allowance per spelling;
 * and a database holding two ids differing only in case must REFUSE the login
 * rather than pick one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { buildEmployeeWorkbook } from '../helpers/xlsxFixture.js';
import { listWorksheets, readWorksheet } from '../../src/worker/lib/xlsx.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const PASSWORD = 'Correct!2027';

describe('Case-insensitive sign-in', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    employee = await seedEmployee(db, { amcoId: 'AMCO002' });
    await setEmployeePasswordDirect(db, employee.id, PASSWORD);
  });

  const login = (id: string, password = PASSWORD, ip = '203.0.113.20') =>
    app.request(
      `${BASE}/api/auth/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ amco_id: id, password }),
      },
      env
    );

  it('accepts the id exactly as stored', async () => {
    expect((await login('AMCO002')).status).toBe(200);
  });

  it('accepts it in lower case', async () => {
    expect((await login('amco002')).status).toBe(200);
  });

  it('accepts it in mixed case', async () => {
    expect((await login('AmCo002')).status).toBe(200);
  });

  it('accepts it with surrounding whitespace', async () => {
    expect((await login('  amco002  ')).status).toBe(200);
  });

  it('still rejects a wrong password, whatever the case of the id', async () => {
    expect((await login('amco002', 'WrongPassword!2027')).status).toBe(401);
  });

  it('still rejects an id that does not exist', async () => {
    expect((await login('amco999')).status).toBe(401);
  });

  it('returns the id in its STORED case, not the case that was typed', async () => {
    const body = await readJson(await login('amco002'));
    expect(body.data.employee.amco_id).toBe('AMCO002');
  });

  it('does not let case bypass the inactive-account check', async () => {
    const inactive = await seedEmployee(db, { amcoId: 'AMCO003', isActive: false });
    await setEmployeePasswordDirect(db, inactive.id, PASSWORD);
    expect((await login('amco003')).status).toBe(401);
  });

  // ------------------------------------------------------------------------
  // The lockout bucket has to fold case too
  // ------------------------------------------------------------------------

  it('counts failures across SPELLINGS, so case cannot multiply the allowance', async () => {
    const ip = '203.0.113.21';
    // Five failures, each with a different capitalisation of the same id.
    for (const spelling of ['AMCO002', 'amco002', 'AmCo002', 'aMCO002', 'amcO002']) {
      expect((await login(spelling, 'WrongPassword!2027', ip)).status).toBe(401);
    }
    // The sixth is locked out - even with the CORRECT password, and even in a
    // spelling not yet tried.
    const res = await login('AMCo002', PASSWORD, ip);
    expect(res.status).toBe(429);
  });

  // ------------------------------------------------------------------------
  // Two ids differing only in case
  // ------------------------------------------------------------------------

  it('REFUSES an ambiguous id rather than signing someone into the wrong account', async () => {
    // The UNIQUE constraint is case-sensitive, so a pair like this can exist in
    // a database created before the lookup was relaxed.
    const other = await seedEmployee(db, { amcoId: 'amco002' });
    await setEmployeePasswordDirect(db, other.id, PASSWORD);

    // A spelling matching NEITHER exactly is ambiguous, and is refused.
    expect((await login('AmCo002')).status).toBe(401);

    // An EXACT match still works, and picks the right one.
    const upper = await readJson(await login('AMCO002', PASSWORD, '203.0.113.22'));
    expect(upper.data.employee.id).toBe(employee.id);
    const lower = await readJson(await login('amco002', PASSWORD, '203.0.113.23'));
    expect(lower.data.employee.id).toBe(other.id);
  });
});

describe('Case-variant ids cannot be created in the first place', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST680', roleId: ROLE_ADMIN });
    await seedEmployee(db, { amcoId: 'AMCO010' });
  });

  it('refuses a new employee whose id differs only in case', async () => {
    const res = await app.request(
      `${BASE}/api/admin/employees`,
      {
        method: 'POST',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amco_id: 'amco010', full_name: 'Test Clash', roster_type: 'regular' }),
      },
      env
    );
    expect(res.status).toBe(409);
  });

  it('still allows a genuinely different id', async () => {
    const res = await app.request(
      `${BASE}/api/admin/employees`,
      {
        method: 'POST',
        headers: { Cookie: admin.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amco_id: 'AMCO011', full_name: 'Test Fine', roster_type: 'regular' }),
      },
      env
    );
    expect(res.status).toBe(201);
  });
});

// ============================================================================
// The column is called ID now - Attarat has three entities (AMCO, OMCO, APCO),
// so an id is not an AMCO id.
// ============================================================================

describe('A workbook headed "ID"', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST690', roleId: ROLE_ADMIN });
  });

  const importWith = async (headers: string[]) => {
    const bytes = buildEmployeeWorkbook(
      [['OMCO500', 'Test Entity Person', 'Test Dept', 'Test Section', 'Regular']],
      { headers }
    );
    const form = new FormData();
    form.set('import_type', 'employees');
    form.set('file', new File([bytes as unknown as BlobPart], 'employees.xlsx'));
    const up = await app.request(
      `${BASE}/api/admin/imports`,
      { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
      env
    );
    const batch = (await readJson(up)).data as { id: number };
    return readJson(
      await app.request(
        `${BASE}/api/admin/imports/${batch.id}/validate`,
        { method: 'POST', headers: { Cookie: admin.cookie } },
        env
      )
    );
  };

  it('imports from a plain "ID" column', async () => {
    const body = await importWith(['ID', 'Name', 'Department', 'Section', 'Roster']);
    expect(body.data.outcome).toBe('ready');
    expect(body.data.total_rows).toBe(1);
  });

  it('still imports workbooks that say "AMCO ID#", so existing files keep working', async () => {
    const body = await importWith(['AMCO ID#', 'Name', 'Department', 'Section', 'Roster']);
    expect(body.data.outcome).toBe('ready');
    expect(body.data.total_rows).toBe(1);
  });
});

// ============================================================================
// The downloadable template
//
// The point of the template is that it MATCHES the parser. So the test does not
// check its headings against a list written by hand - it downloads the file and
// feeds it straight back to the importer.
// ============================================================================

describe('Employee import template', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST695', roleId: ROLE_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST696' });
  });

  const download = (cookie: string | null) =>
    app.request(
      `${BASE}/api/admin/imports/templates/employees.xlsx`,
      cookie ? { headers: { Cookie: cookie } } : {},
      env
    );

  it('is admin-only', async () => {
    expect((await download(null)).status).toBe(401);
    expect((await download(employee.cookie)).status).toBe(403);
  });

  it('downloads as a named .xlsx attachment', async () => {
    const res = await download(admin.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(res.headers.get('Content-Disposition')).toContain(
      'canteenhub-employee-import-template.xlsx'
    );
  });

  it('has the sheet the importer looks for, plus instructions', async () => {
    const buffer = await (await download(admin.cookie)).arrayBuffer();
    expect(await listWorksheets(buffer)).toEqual(['All Employees', 'Instructions']);
  });

  it('UPLOADS AND VALIDATES CLEANLY without being edited', async () => {
    // The whole point: what the portal hands out is what the parser accepts.
    const buffer = await (await download(admin.cookie)).arrayBuffer();

    const form = new FormData();
    form.set('import_type', 'employees');
    form.set('file', new File([buffer], 'template.xlsx'));
    const up = await app.request(
      `${BASE}/api/admin/imports`,
      { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
      env
    );
    expect(up.status).toBe(201);
    const batch = (await readJson(up)).data as { id: number };

    const body = await readJson(
      await app.request(
        `${BASE}/api/admin/imports/${batch.id}/validate`,
        { method: 'POST', headers: { Cookie: admin.cookie } },
        env
      )
    );

    expect(body.data.outcome).toBe('ready');
    expect(body.data.invalid_rows).toBe(0);
    // The three EXAMPLE rows, which the user is told to delete.
    expect(body.data.total_rows).toBe(3);
    expect(body.data.action_counts).toEqual({ CREATE: 3, UPDATE: 0, UNCHANGED: 0, INVALID: 0 });
  });

  it('its example rows exercise every roster type and every canteen', async () => {
    const buffer = await (await download(admin.cookie)).arrayBuffer();
    const sheet = await readWorksheet(buffer, 'All Employees');
    const rows = sheet.rows.slice(1).map((r) => [...r.cells.values()]);

    const rosters = rows.map((r) => r[4]);
    expect(new Set(rosters).size).toBe(3);
    const canteens = rows.map((r) => r[5]);
    expect(new Set(canteens)).toEqual(
      new Set(['AMCO Canteen', 'OMCO Canteen', 'WHC Canteen'])
    );
  });

  it('every roster value it suggests is one the parser accepts', async () => {
    // A template offering a value the importer rejects is worse than none.
    const buffer = await (await download(admin.cookie)).arrayBuffer();
    const sheet = await readWorksheet(buffer, 'All Employees');

    for (const [index, row] of sheet.rows.slice(1).entries()) {
      const roster = [...row.cells.values()][4];
      const bytes = buildEmployeeWorkbook(
        [[`TEMPL${index}`, 'Test Person', 'Dept', 'Section', roster]],
        { headers: ['ID', 'Name', 'Department', 'Section', 'Roster'] }
      );
      const form = new FormData();
      form.set('import_type', 'employees');
      form.set('file', new File([bytes as unknown as BlobPart], 'e.xlsx'));
      const up = await app.request(
        `${BASE}/api/admin/imports`,
        { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
        env
      );
      const b = (await readJson(up)).data as { id: number };
      const body = await readJson(
        await app.request(
          `${BASE}/api/admin/imports/${b.id}/validate`,
          { method: 'POST', headers: { Cookie: admin.cookie } },
          env
        )
      );
      expect(body.data.outcome, `roster value "${roster}" must be accepted`).toBe('ready');
    }
  });

  it('contains no real employee data', async () => {
    const buffer = await (await download(admin.cookie)).arrayBuffer();
    const sheet = await readWorksheet(buffer, 'All Employees');
    const raw = JSON.stringify(sheet.rows.map((r) => [...r.cells.values()]));
    expect(raw).toContain('EXAMPLE001');
    expect(raw).not.toMatch(/AMCO0\d\d/);
  });
});
