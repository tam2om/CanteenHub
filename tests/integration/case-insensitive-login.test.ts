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
