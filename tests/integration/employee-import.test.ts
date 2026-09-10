// @vitest-environment node
/**
 * Integration Tests - employee Excel import.
 *
 * Real Hono routes, real SQL against the real migrations, the real XLSX reader
 * parsing genuine ZIP/SpreadsheetML built in-test, and the in-memory R2 double
 * the production path actually calls.
 *
 * Every value here is synthetic. No real employee name, AMCO ID, department,
 * section or roster value from the source workbook appears anywhere.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { createTestR2, type TestR2Bucket } from '../helpers/r2.js';
import { buildEmployeeWorkbook, buildWorkbook } from '../helpers/xlsxFixture.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  seedMenuDay,
  countRows,
  jsonRequest,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const IMPORTS = `${BASE}/api/admin/imports`;

/** Synthetic rows: AMCO ID, Name, Department, Section, Roster. */
const ROW_A = ['TEST100', 'Alpha Person', 'Mining', 'Operations', 'Regular'];
const ROW_B = ['TEST101', 'Beta Person', 'Technical Services', 'Planning', 'Shift'];
const ROW_C = ['TEST102', 'Gamma Person', 'Finance', 'Finance', 'Amman HQ'];

describe('Employee Excel import', () => {
  let db: TestD1Database;
  let bucket: TestR2Bucket;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    bucket = createTestR2();
    env = testEnv(db, bucket);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });
  });

  const uploadWorkbook = (
    bytes: Uint8Array,
    { cookie = admin.cookie, filename = 'employees.xlsx' } = {}
  ) => {
    const form = new FormData();
    form.set('import_type', 'employees');
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

  /** Upload + validate, returning the validation payload. */
  const uploadAndValidate = async (rows: Array<Array<string | null>>, opts = {}) => {
    const res = await uploadWorkbook(buildEmployeeWorkbook(rows, opts));
    expect(res.status).toBe(201);
    const batch = (await readJson(res)).data as { id: number };
    const validated = await readJson(await validate(batch.id));
    return { id: batch.id, body: validated };
  };

  const employeeRow = (amcoId: string) =>
    db
      .prepare('SELECT * FROM employees WHERE amco_id = ?')
      .bind(amcoId)
      .first<Record<string, unknown>>();

  // ==========================================================================
  // PARSER
  // ==========================================================================

  describe('parser', () => {
    it('reads a valid workbook and reports the row count', async () => {
      const { body } = await uploadAndValidate([ROW_A, ROW_B, ROW_C]);

      expect(body.data.outcome).toBe('ready');
      expect(body.data.status).toBe('preview');
      expect(body.data.total_rows).toBe(3);
      expect(body.data.valid_rows).toBe(3);
      expect(body.data.invalid_rows).toBe(0);
    });

    it('reports a missing worksheet by name and lists what the file contains', async () => {
      const wrongSheet = buildWorkbook([{ name: 'Sheet1', rows: [['AMCO ID#', 'Name', 'Roster']] }]);
      const res = await uploadWorkbook(wrongSheet);
      const batch = (await readJson(res)).data as { id: number };

      const body = await readJson(await validate(batch.id));
      expect(body.data.outcome).toBe('failed');
      expect(body.data.messages[0]).toContain('All Employees');
      expect(body.data.messages[0]).toContain('Sheet1');
    });

    it('names a missing required column', async () => {
      const { body } = await uploadAndValidate([['TEST100', 'Alpha Person']], {
        headers: ['AMCO ID#', 'Name'],
      });

      expect(body.data.outcome).toBe('failed');
      expect(body.data.messages.join(' ')).toContain('Roster');
    });

    it('normalizes header whitespace, case and invisible characters', async () => {
      const { body } = await uploadAndValidate([ROW_A], {
        headers: ['﻿  amco  id#  ', 'NAME', 'department', 'Section', ' roster '],
      });

      expect(body.data.outcome).toBe('ready');
      expect(body.data.total_rows).toBe(1);
    });

    it('skips blank rows without treating them as errors', async () => {
      const { body } = await uploadAndValidate([
        ROW_A,
        [null, null, null, null, null],
        ['', '', '', '', ''],
        ROW_B,
      ]);

      expect(body.data.outcome).toBe('ready');
      expect(body.data.total_rows).toBe(2);
      expect(body.data.messages.join(' ')).toContain('Skipped 2 blank rows');
    });

    it('trims leading and trailing whitespace in cells', async () => {
      const { id, body } = await uploadAndValidate([
        ['  TEST100  ', '  Alpha Person  ', ' Mining ', ' Operations ', ' Regular '],
      ]);

      expect(body.data.outcome).toBe('ready');
      const detail = await readJson(await preview(id));
      expect(detail.data.preview_rows[0].preview.amco_id).toBe('TEST100');
      expect(detail.data.preview_rows[0].preview.full_name).toBe('Alpha Person');
      expect(detail.data.preview_rows[0].preview.department).toBe('Mining');
    });

    it('accepts a numeric-looking AMCO ID', async () => {
      const { body } = await uploadAndValidate([['100200', 'Numeric Person', '', '', 'Regular']]);
      expect(body.data.outcome).toBe('ready');
    });

    it('warns about unexpected extra columns rather than failing', async () => {
      const { body } = await uploadAndValidate([[...ROW_A, 'ignore me']], {
        headers: [...['AMCO ID#', 'Name', 'Department', 'Section', 'Roster'], 'Internal Notes'],
      });

      expect(body.data.outcome).toBe('ready');
      expect(body.data.messages.join(' ')).toContain('Internal Notes');
    });

    it('rejects a malformed workbook without leaking internals', async () => {
      // A valid ZIP that is not a workbook.
      const notAWorkbook = buildWorkbook([]);
      const res = await uploadWorkbook(notAWorkbook);
      const batch = (await readJson(res)).data as { id: number };

      const body = await readJson(await validate(batch.id));
      expect(body.data.outcome).toBe('failed');
      const text = JSON.stringify(body);
      expect(text).not.toContain('at Object.');
      expect(text).not.toContain('SQLITE');
    });

    it('rejects a duplicated header column', async () => {
      const { body } = await uploadAndValidate([ROW_A], {
        headers: ['AMCO ID#', 'Name', 'Name', 'Section', 'Roster'],
      });
      expect(body.data.outcome).toBe('failed');
      expect(body.data.messages[0]).toContain('appears more than once');
    });
  });

  // ==========================================================================
  // VALIDATION AND CLASSIFICATION
  // ==========================================================================

  describe('classification', () => {
    it('classifies an unknown AMCO ID as CREATE', async () => {
      const { id } = await uploadAndValidate([ROW_A]);
      const detail = await readJson(await preview(id));

      expect(detail.data.preview_rows[0].preview.action).toBe('CREATE');
      expect(detail.data.preview_rows[0].preview.amco_id).toBe('TEST100');
    });

    it('classifies a changed existing employee as UPDATE and shows before/after', async () => {
      await seedEmployee(db, {
        amcoId: 'TEST100',
        fullName: 'Old Name',
        department: 'Old Department',
        section: 'Old Section',
        rosterType: 'regular',
      });

      const { id } = await uploadAndValidate([ROW_A]);
      const detail = await readJson(await preview(id));
      const row = detail.data.preview_rows[0].preview;

      expect(row.action).toBe('UPDATE');
      const byField = Object.fromEntries(
        row.changes.map((c: { field: string; from: string; to: string }) => [c.field, c])
      );
      expect(byField.full_name).toEqual({ field: 'full_name', from: 'Old Name', to: 'Alpha Person' });
      expect(byField.department.from).toBe('Old Department');
      expect(byField.department.to).toBe('Mining');
    });

    it('classifies an identical existing employee as UNCHANGED', async () => {
      await seedEmployee(db, {
        amcoId: 'TEST100',
        fullName: 'Alpha Person',
        department: 'Mining',
        section: 'Operations',
        rosterType: 'regular',
      });

      const { id } = await uploadAndValidate([ROW_A]);
      const detail = await readJson(await preview(id));

      expect(detail.data.preview_rows[0].preview.action).toBe('UNCHANGED');
      expect(detail.data.preview_rows[0].preview.changes).toBeUndefined();
    });

    it('maps every supported roster value and rejects anything else', async () => {
      const { id, body } = await uploadAndValidate([
        ['TEST100', 'A', '', '', 'Regular'],
        ['TEST101', 'B', '', '', 'Shift'],
        ['TEST102', 'C', '', '', 'Amman HQ'],
      ]);
      expect(body.data.outcome).toBe('ready');

      const detail = await readJson(await preview(id));
      expect(detail.data.preview_rows.map((r: { preview: { roster_type: string } }) => r.preview.roster_type))
        .toEqual(['regular', 'shift', 'amman_hq']);

      const bad = await uploadAndValidate([['TEST200', 'D', '', '', 'Contractor']]);
      expect(bad.body.data.outcome).toBe('failed');
      expect(bad.body.data.invalid_rows).toBe(1);
    });

    it('rejects a duplicate AMCO ID within the workbook rather than picking one', async () => {
      const { id, body } = await uploadAndValidate([
        ['TEST100', 'First Entry', '', '', 'Regular'],
        ['TEST100', 'Second Entry', '', '', 'Shift'],
      ]);

      expect(body.data.outcome).toBe('failed');
      expect(body.data.invalid_rows).toBe(2);

      const detail = await readJson(await preview(id));
      for (const row of detail.data.preview_rows) {
        expect(row.messages.join(' ')).toContain('appears more than once');
      }
    });

    it('rejects rows missing a required field', async () => {
      const { id, body } = await uploadAndValidate([
        ['', 'No Id Person', '', '', 'Regular'],
        ['TEST101', '', '', '', 'Regular'],
        ['TEST102', 'No Roster Person', '', '', ''],
      ]);

      expect(body.data.invalid_rows).toBe(3);
      const detail = await readJson(await preview(id));
      const messages = detail.data.preview_rows.map((r: { messages: string[] }) => r.messages.join(' '));
      expect(messages[0]).toContain('AMCO ID is missing');
      expect(messages[1]).toContain('Name is missing');
      expect(messages[2]).toContain('Roster is missing');
    });

    it('rejects an AMCO ID containing unsupported characters', async () => {
      const { body } = await uploadAndValidate([['BAD ID/../x', 'Odd Person', '', '', 'Regular']]);
      expect(body.data.invalid_rows).toBe(1);
    });

    it('reports a mixed workbook with accurate counts', async () => {
      await seedEmployee(db, {
        amcoId: 'TEST101',
        fullName: 'Beta Person',
        department: 'Technical Services',
        section: 'Planning',
        rosterType: 'shift',
      });
      await seedEmployee(db, { amcoId: 'TEST102', fullName: 'Stale Name', rosterType: 'regular' });

      const { body } = await uploadAndValidate([
        ROW_A, // CREATE
        ROW_B, // UNCHANGED
        ROW_C, // UPDATE
        ['TEST103', 'Bad Roster', '', '', 'Nonsense'], // INVALID
      ]);

      expect(body.data.total_rows).toBe(4);
      expect(body.data.valid_rows).toBe(3);
      expect(body.data.invalid_rows).toBe(1);
      expect(body.data.outcome).toBe('failed'); // any invalid row blocks commit
    });
  });

  // ==========================================================================
  // COMMIT
  // ==========================================================================

  describe('commit', () => {
    it('inserts new employees', async () => {
      const { id } = await uploadAndValidate([ROW_A, ROW_B]);
      expect((await commit(id)).status).toBe(200);

      const created = await employeeRow('TEST100');
      expect(created).not.toBeNull();
      expect(created!.full_name).toBe('Alpha Person');
      expect(created!.department).toBe('Mining');
      expect(created!.roster_type).toBe('regular');
      expect(await employeeRow('TEST101')).not.toBeNull();
    });

    it('a created employee has no password and cannot sign in', async () => {
      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      const created = await employeeRow('TEST100');
      expect(created!.password_hash).toBeNull();

      const login = await app.request(
        `${BASE}/api/auth/login`,
        jsonRequest({ amco_id: 'TEST100', password: 'anything-at-all' }),
        env
      );
      expect(login.status).toBe(401);
    });

    it('updates an existing employee in place, keeping their row id', async () => {
      const seeded = await seedEmployee(db, {
        amcoId: 'TEST100',
        fullName: 'Old Name',
        rosterType: 'shift',
      });

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      const updated = await employeeRow('TEST100');
      expect(updated!.id).toBe(seeded.id); // same row, not delete-and-recreate
      expect(updated!.full_name).toBe('Alpha Person');
      expect(updated!.roster_type).toBe('regular');
    });

    it('PRESERVES an existing password across an update', async () => {
      const target = await seedEmployee(db, { amcoId: 'TEST100', fullName: 'Old Name' });
      await setEmployeePasswordDirect(db, target.id, 'original-password-here');

      const before = await employeeRow('TEST100');

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      const after = await employeeRow('TEST100');
      expect(after!.password_hash).toBe(before!.password_hash);
      expect(after!.full_name).toBe('Alpha Person'); // the update did happen

      // And the credential still works end to end.
      const login = await app.request(
        `${BASE}/api/auth/login`,
        jsonRequest({ amco_id: 'TEST100', password: 'original-password-here' }),
        env
      );
      expect(login.status).toBe(200);
    });

    it('PRESERVES role and active status across an update', async () => {
      await seedEmployee(db, {
        amcoId: 'TEST100',
        fullName: 'Old Name',
        roleId: ROLE_ADMIN,
        isActive: false,
      });

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      const after = await employeeRow('TEST100');
      expect(after!.role_id).toBe(ROLE_ADMIN);
      expect(after!.is_active).toBe(0);
    });

    it('PRESERVES lunch selections and selection history across an update', async () => {
      const target = await seedEmployee(db, { amcoId: 'TEST100', fullName: 'Old Name' });
      await seedMenuDay(db, '2027-03-07', 'published');
      await db
        .prepare(
          `INSERT INTO lunch_selections (employee_id, meal_date, choice, source)
           VALUES (?, '2027-03-07', 'option_1', 'employee')`
        )
        .bind(target.id)
        .run();
      await db
        .prepare(
          `INSERT INTO lunch_selection_history (employee_id, meal_date, new_choice, source)
           VALUES (?, '2027-03-07', 'option_1', 'employee')`
        )
        .bind(target.id)
        .run();

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections WHERE employee_id = ?', target.id)
      ).toBe(1);
      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?', target.id)
      ).toBe(1);
    });

    it('PRESERVES roster history across an update', async () => {
      const target = await seedEmployee(db, { amcoId: 'TEST101', rosterType: 'shift' });
      await db
        .prepare(
          `INSERT INTO roster_entries (employee_id, work_date, shift_value, source)
           VALUES (?, '2027-03-07', 'day', 'manual')`
        )
        .bind(target.id)
        .run();

      const { id } = await uploadAndValidate([ROW_B]);
      await commit(id);

      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries WHERE employee_id = ?', target.id)
      ).toBe(1);
    });

    it('leaves employees ABSENT from the workbook completely untouched', async () => {
      const before = await employeeRow('TEST001'); // seeded, not in the workbook

      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      const after = await employeeRow('TEST001');
      expect(after).toEqual(before);
      expect(after!.is_active).toBe(1); // NOT deactivated for being absent
    });

    it('issues NO update for an UNCHANGED row', async () => {
      await seedEmployee(db, {
        amcoId: 'TEST100',
        fullName: 'Alpha Person',
        department: 'Mining',
        section: 'Operations',
        rosterType: 'regular',
      });

      const { id } = await uploadAndValidate([ROW_A]);

      db.executedWrites.length = 0;
      await commit(id);

      const employeeWrites = db.executedWrites.filter((sql) => /employees/i.test(sql));
      expect(employeeWrites).toEqual([]);
    });

    it('is idempotent: re-importing the same workbook yields all UNCHANGED', async () => {
      const first = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(first.id);

      const second = await uploadAndValidate([ROW_A, ROW_B]);
      expect(second.body.data.outcome).toBe('ready');

      const detail = await readJson(await preview(second.id));
      const actions = detail.data.preview_rows.map((r: { preview: { action: string } }) => r.preview.action);
      expect(actions).toEqual(['UNCHANGED', 'UNCHANGED']);

      db.executedWrites.length = 0;
      await commit(second.id);
      expect(db.executedWrites.filter((sql) => /employees/i.test(sql))).toEqual([]);
    });

    it('COMMIT is the only step that writes to employees', async () => {
      // Upload, validate and preview must all leave production employee rows
      // alone; the batch is staged in import_batch_rows, never applied.
      const snapshot = await db
        .prepare('SELECT * FROM employees ORDER BY id')
        .all<Record<string, unknown>>();

      db.executedWrites.length = 0;

      const res = await uploadWorkbook(buildEmployeeWorkbook([ROW_A, ROW_B]));
      const batch = (await readJson(res)).data as { id: number };
      expect(db.executedWrites.filter((sql) => /\bemployees\b/i.test(sql))).toEqual([]);

      await validate(batch.id);
      expect(db.executedWrites.filter((sql) => /\bemployees\b/i.test(sql))).toEqual([]);

      await preview(batch.id);
      expect(db.executedWrites.filter((sql) => /\bemployees\b/i.test(sql))).toEqual([]);

      // The staged rows exist, so the work really was done - it just was not applied.
      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM import_batch_rows WHERE import_batch_id = ?', batch.id)
      ).toBe(2);
      const unchanged = await db
        .prepare('SELECT * FROM employees ORDER BY id')
        .all<Record<string, unknown>>();
      expect(unchanged.results).toEqual(snapshot.results);

      // Only now does anything land.
      await commit(batch.id);
      expect(db.executedWrites.filter((sql) => /\bemployees\b/i.test(sql)).length).toBeGreaterThan(0);
      expect(await employeeRow('TEST100')).not.toBeNull();
    });

    it('validating an INVALID workbook writes no employee row either', async () => {
      const snapshot = await db
        .prepare('SELECT * FROM employees ORDER BY id')
        .all<Record<string, unknown>>();

      db.executedWrites.length = 0;
      await uploadAndValidate([ROW_A, ['TEST999', 'Bad', '', '', 'Nonsense']]);

      expect(db.executedWrites.filter((sql) => /\bemployees\b/i.test(sql))).toEqual([]);
      const after = await db
        .prepare('SELECT * FROM employees ORDER BY id')
        .all<Record<string, unknown>>();
      expect(after.results).toEqual(snapshot.results);
    });

    it('refuses to commit a workbook containing any invalid row', async () => {
      const { id } = await uploadAndValidate([ROW_A, ['TEST999', 'Bad', '', '', 'Nonsense']]);

      const res = await commit(id);
      expect(res.status).toBe(409);
      // The valid row was NOT partially applied.
      expect(await employeeRow('TEST100')).toBeNull();
    });

    it('commits atomically: a constraint violation applies nothing', async () => {
      // Seed an employee whose id collides on insert to force a failure.
      await seedEmployee(db, { amcoId: 'TEST101', fullName: 'Beta Person' });

      const { id } = await uploadAndValidate([ROW_A, ROW_B]);

      // Between validation and commit, someone inserts the CREATE row's id,
      // so the batch's INSERT will violate the UNIQUE constraint.
      await seedEmployee(db, { amcoId: 'TEST100', fullName: 'Race Winner' });

      const res = await commit(id);
      expect(res.status).toBe(500);

      // The UPDATE for TEST101 must NOT have landed: all or nothing. The row
      // still carries its seeded department, not the workbook's value.
      const untouched = await employeeRow('TEST101');
      expect(untouched!.department).toBe('Test Department');
      expect(untouched!.department).not.toBe('Technical Services');
      expect(untouched!.section).not.toBe('Planning');

      const batch = await db
        .prepare('SELECT status, committed_at FROM import_batches WHERE id = ?')
        .bind(id)
        .first<{ status: string; committed_at: string | null }>();
      expect(batch!.status).toBe('commit_failed');
      expect(batch!.committed_at).toBeNull();
    });
  });

  // ==========================================================================
  // STATE MACHINE (foundation behaviour must survive)
  // ==========================================================================

  describe('state machine', () => {
    it('cannot commit before validation', async () => {
      const res = await uploadWorkbook(buildEmployeeWorkbook([ROW_A]));
      const batch = (await readJson(res)).data as { id: number };

      expect((await commit(batch.id)).status).toBe(409);
      expect(await employeeRow('TEST100')).toBeNull();
    });

    it('cannot commit twice', async () => {
      const { id } = await uploadAndValidate([ROW_A]);
      expect((await commit(id)).status).toBe(200);

      const second = await commit(id);
      expect(second.status).toBe(409);
      expect((await readJson(second)).error).toContain('already been committed');
    });

    it('CONCURRENT commits apply the workbook exactly once', async () => {
      const { id } = await uploadAndValidate([ROW_A, ROW_B]);

      const results = await Promise.all([commit(id), commit(id), commit(id)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);

      expect(await countRows(db, "SELECT COUNT(*) as n FROM employees WHERE amco_id = 'TEST100'")).toBe(1);
      expect(await countRows(db, "SELECT COUNT(*) as n FROM employees WHERE amco_id = 'TEST101'")).toBe(1);
    });

    it('a committed import stays committed', async () => {
      const { id } = await uploadAndValidate([ROW_A]);
      await commit(id);

      expect((await validate(id)).status).toBe(409);
      const row = await db
        .prepare('SELECT status FROM import_batches WHERE id = ?')
        .bind(id)
        .first<{ status: string }>();
      expect(row!.status).toBe('committed');
    });
  });

  // ==========================================================================
  // SECURITY AND AUDIT
  // ==========================================================================

  describe('security and audit', () => {
    it('a non-admin cannot upload, validate or commit an employee import', async () => {
      expect((await uploadWorkbook(buildEmployeeWorkbook([ROW_A]), { cookie: employee.cookie })).status).toBe(403);

      const { id } = await uploadAndValidate([ROW_A]);
      expect((await validate(id, employee.cookie)).status).toBe(403);
      expect((await commit(id, employee.cookie)).status).toBe(403);
      expect(await employeeRow('TEST100')).toBeNull();
    });

    it('an unauthenticated caller cannot upload or commit', async () => {
      expect((await uploadWorkbook(buildEmployeeWorkbook([ROW_A]), { cookie: '' })).status).toBe(401);
    });

    it('no preview or response exposes a password hash', async () => {
      const target = await seedEmployee(db, { amcoId: 'TEST100', fullName: 'Old Name' });
      await setEmployeePasswordDirect(db, target.id, 'original-password-here');

      const { id } = await uploadAndValidate([ROW_A]);
      const raw = JSON.stringify(await readJson(await preview(id)));

      expect(raw).not.toContain('password_hash');
      expect(raw).not.toContain('pbkdf2');
      expect(raw).not.toContain('original-password-here');
    });

    it('the audit records the import without the workbook contents', async () => {
      const { id } = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(id);

      const audit = await db.prepare('SELECT * FROM audit_log').all<Record<string, unknown>>();
      const raw = JSON.stringify(audit.results);

      // Batch-level records exist...
      expect(raw).toContain('CREATE_IMPORT');
      expect(raw).toContain('VALIDATE_IMPORT');
      expect(raw).toContain('COMMIT_IMPORT');
      // ...but no row-level employee data or file bytes.
      expect(raw).not.toContain('Alpha Person');
      expect(raw).not.toContain('password');
      expect(raw).not.toContain('r2_object_key');
    });

    it('does not create one audit row per imported employee', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => [
        `TEST2${String(i).padStart(2, '0')}`,
        `Person ${i}`,
        'Mining',
        'Operations',
        'Regular',
      ]);

      const { id } = await uploadAndValidate(rows);
      await commit(id);

      // One CREATE, one VALIDATE, one COMMIT - not ten employee audit rows.
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(3);
    });

    it('the import touches no other domain table', async () => {
      const { id } = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(id);

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM holidays')).toBe(0);
    });
  });

  // ==========================================================================
  // R2 AND HISTORY
  // ==========================================================================

  describe('R2 and history', () => {
    it('preserves the ORIGINAL workbook in R2, unmodified', async () => {
      const bytes = buildEmployeeWorkbook([ROW_A]);
      const res = await uploadWorkbook(bytes);
      const batch = (await readJson(res)).data as { id: number };

      await validate(batch.id);
      await commit(batch.id);

      const stored = bucket.objects.get(`imports/employees/${batch.id}/source.xlsx`);
      expect(stored).toBeDefined();
      // Byte-for-byte the file that was uploaded - not a normalized rewrite.
      expect(new Uint8Array(stored!.body)).toEqual(bytes);
    });

    it('import history shows the employee import with its counts and result', async () => {
      const { id } = await uploadAndValidate([ROW_A, ROW_B]);
      await commit(id);

      const body = await readJson(
        await app.request(IMPORTS, { headers: { Cookie: admin.cookie } }, env)
      );

      const entry = body.data.imports.find((i: { id: number }) => i.id === id);
      expect(entry.import_type).toBe('employees');
      expect(entry.status).toBe('committed');
      expect(entry.original_filename).toBe('employees.xlsx');
      expect(entry.uploaded_by_amco_id).toBe('TEST900');
      expect(entry.total_rows).toBe(2);
      expect(entry.file_archived).toBe(true);
    });
  });
});
