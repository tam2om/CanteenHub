// @vitest-environment node
/**
 * Integration Tests - shift roster Excel import.
 *
 * Real Hono routes, real SQL against the real migrations, the real XLSX reader
 * parsing genuine ZIP/SpreadsheetML built in-test, and the in-memory R2 double
 * the production path actually calls.
 *
 * Every value here is synthetic. No real employee name, AMCO ID, department or
 * roster value from the source workbook appears anywhere.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { createTestR2, type TestR2Bucket } from '../helpers/r2.js';
import { buildRosterWorkbook, buildWorkbook, rosterRow, rosterHeaders } from '../helpers/xlsxFixture.js';
import {
  testEnv,
  seedEmployee,
  setEmployeePasswordDirect,
  seedMenuDay,
  countRows,
  readJson,
  ROLE_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';

const BASE = 'http://localhost';
const IMPORTS = `${BASE}/api/admin/imports`;

/** March 2027 has 31 days; February 2027 has 28; September has 30. */
const MONTH = 3;
const YEAR = 2027;

describe('Shift roster Excel import', () => {
  let db: TestD1Database;
  let bucket: TestR2Bucket;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let shiftWorker: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    bucket = createTestR2();
    env = testEnv(db, bucket);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    shiftWorker = await seedEmployee(db, { amcoId: 'TEST100', rosterType: 'shift' });
  });

  const uploadWorkbook = (
    bytes: Uint8Array,
    { cookie = admin.cookie, filename = 'roster.xlsx' } = {}
  ) => {
    const form = new FormData();
    form.set('import_type', 'roster');
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
    const res = await uploadWorkbook(buildRosterWorkbook(rows, opts));
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
        amco_id: string;
        month: number | null;
        year: number | null;
        days: Array<{ work_date: string; action: string; from: string | null; to: string }>;
        counts: { create: number; update: number; unchanged: number };
      };
    }>;
  };

  const entry = (employeeId: number, workDate: string) =>
    db
      .prepare('SELECT * FROM roster_entries WHERE employee_id = ? AND work_date = ?')
      .bind(employeeId, workDate)
      .first<Record<string, unknown>>();

  const seedEntry = (employeeId: number, workDate: string, shift: string, source = 'manual') =>
    db
      .prepare(
        `INSERT INTO roster_entries (employee_id, work_date, shift_value, source)
         VALUES (?, ?, ?, ?)`
      )
      .bind(employeeId, workDate, shift, source)
      .run();

  /** One row covering days 1-3 of March 2027 for the seeded shift worker. */
  const ROW_BASIC = rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 2: 'Night', 3: 'Off' });

  // ==========================================================================
  // PARSER
  // ==========================================================================

  describe('parser', () => {
    it('reads the real wide-month shape and reports the row count', async () => {
      const { body } = await uploadAndValidate([ROW_BASIC]);
      expect(body.data.outcome).toBe('ready');
      expect(body.data.total_rows).toBe(1);
      expect(body.data.invalid_rows).toBe(0);
    });

    it('reports a missing worksheet by name and lists what the file contains', async () => {
      const bytes = buildWorkbook([{ name: 'Something Else', rows: [['a']] }]);
      const res = await uploadWorkbook(bytes);
      const batch = (await readJson(res)).data as { id: number };
      const body = await readJson(await validate(batch.id));

      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('Shifts roster');
      expect(JSON.stringify(body.data.messages)).toContain('Something Else');
    });

    it('names a missing required column', async () => {
      const { body } = await uploadAndValidate([['TEST100', '2027']], {
        headers: ['code', 'year', '1'],
      });
      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('month');
    });

    it('rejects a workbook with no day columns at all', async () => {
      const { body } = await uploadAndValidate([['TEST100', '3', '2027']], {
        headers: ['code', 'month', 'year'],
      });
      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('no day columns');
    });

    it('normalizes header whitespace, case and invisible characters', async () => {
      const { body } = await uploadAndValidate([ROW_BASIC], {
        headers: ['  CODE ', 'Month​', ' Year', ...rosterHeaders().slice(3)],
      });
      expect(body.data.outcome).toBe('ready');
    });

    it('accepts a month written as a name', async () => {
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST100', 'March', YEAR, { 1: 'Day' }),
      ]);
      expect(body.data.outcome).toBe('ready');
      const rows = await previewRows(id);
      expect(rows[0].preview.days[0].work_date).toBe('2027-03-01');
    });

    it('accepts Excel numeric-looking month, year and day headers', async () => {
      const { id, body } = await uploadAndValidate([rosterRow('TEST100', '3.0', '2027.0', { 1: 'Day' })], {
        headers: ['code', 'month', 'year', '1.0', ...rosterHeaders().slice(4)],
      });
      expect(body.data.outcome).toBe('ready');
      const rows = await previewRows(id);
      expect(rows[0].preview.days[0].work_date).toBe('2027-03-01');
    });

    it('trims whitespace and accepts mixed-case shift values', async () => {
      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: '  nIgHt  ', 2: 'OFF' }),
      ]);
      const rows = await previewRows(id);
      expect(rows[0].preview.days.map((d) => d.to)).toEqual(['night', 'off']);
    });

    it('skips blank padding rows without treating them as errors', async () => {
      const blank = rosterRow('', '', '', {});
      const { body } = await uploadAndValidate([ROW_BASIC, blank, blank]);
      expect(body.data.total_rows).toBe(1);
      expect(body.data.outcome).toBe('ready');
    });

    it('rejects a malformed workbook without leaking internals', async () => {
      const notAZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x99, 0x99, 0x99]);
      const res = await uploadWorkbook(notAZip);
      const batch = (await readJson(res)).data as { id: number };
      const body = await readJson(await validate(batch.id));

      expect(body.data.outcome).toBe('failed');
      const raw = JSON.stringify(body.data.messages);
      expect(raw).not.toContain('undefined');
      expect(raw).not.toMatch(/at .*\.ts:/);
    });

    it('rejects a duplicated day column', async () => {
      const { body } = await uploadAndValidate([['TEST100', '3', '2027', 'Day', 'Night']], {
        headers: ['code', 'month', 'year', '1', '1'],
      });
      expect(body.data.outcome).toBe('failed');
      expect(JSON.stringify(body.data.messages)).toContain('more than one column');
    });

    it('never evaluates a formula: only the cached value is read', async () => {
      // A cell carrying <f>…</f> with a cached <v> yields the value, and the
      // formula text never reaches the importer.
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' }),
      ]);
      expect(body.data.outcome).toBe('ready');
      const raw = JSON.stringify(await previewRows(id));
      expect(raw).not.toContain('<f>');
      expect(raw).not.toContain('SUM(');
    });
  });

  // ==========================================================================
  // DATE VALIDATION
  // ==========================================================================

  describe('date validation', () => {
    it('rejects an impossible date: September 31', async () => {
      const { id, body } = await uploadAndValidate([rosterRow('TEST100', 9, YEAR, { 31: 'Day' })]);
      expect(body.data.outcome).toBe('failed');
      const rows = await previewRows(id);
      expect(rows[0].messages.join(' ')).toContain('Day 31 does not exist');
    });

    it('rejects February 29 in a non-leap year', async () => {
      const { id, body } = await uploadAndValidate([rosterRow('TEST100', 2, 2027, { 29: 'Day' })]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('Day 29 does not exist');
    });

    it('ACCEPTS February 29 in a leap year', async () => {
      const { id, body } = await uploadAndValidate([rosterRow('TEST100', 2, 2028, { 29: 'Day' })]);
      expect(body.data.outcome).toBe('ready');
      expect((await previewRows(id))[0].preview.days[0].work_date).toBe('2028-02-29');
    });

    it('rejects an impossible date: April 31', async () => {
      const { body } = await uploadAndValidate([rosterRow('TEST100', 4, YEAR, { 31: 'Day' })]);
      expect(body.data.outcome).toBe('failed');
    });

    it('rejects a FRACTIONAL month or year, while still accepting Excel\'s .0', async () => {
      // "3.0" is Excel writing 3; "3.5" is not a month and must not truncate to 3.
      expect((await uploadAndValidate([rosterRow('TEST100', '3.5', YEAR, { 1: 'Day' })])).body.data.outcome)
        .toBe('failed');
      expect((await uploadAndValidate([rosterRow('TEST100', MONTH, '2027.5', { 1: 'Day' })])).body.data.outcome)
        .toBe('failed');
      expect((await uploadAndValidate([rosterRow('TEST100', '03.0', YEAR, { 1: 'Day' })])).body.data.outcome)
        .toBe('ready');
    });

    it('rejects an invalid month', async () => {
      const { id, body } = await uploadAndValidate([rosterRow('TEST100', 13, YEAR, { 1: 'Day' })]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('not a valid month');
    });

    it('rejects an implausible year', async () => {
      const { id, body } = await uploadAndValidate([rosterRow('TEST100', MONTH, 2206, { 1: 'Day' })]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('not a valid year');
    });

    it('rejects a missing month or year', async () => {
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST100', '', YEAR, { 1: 'Day' }),
      ]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('Month is missing');
    });

    it('composes dates arithmetically, with no UTC or offset drift', async () => {
      // A date at the very start of a month is the classic place a UTC round
      // trip slips a day.
      const { id } = await uploadAndValidate([rosterRow('TEST100', 1, YEAR, { 1: 'Day' })]);
      expect((await previewRows(id))[0].preview.days[0].work_date).toBe('2027-01-01');
    });
  });

  // ==========================================================================
  // SHIFT VALUES
  // ==========================================================================

  describe('shift values', () => {
    it('maps Off, Day and Night to the database enum', async () => {
      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Off', 2: 'Day', 3: 'Night' }),
      ]);
      const rows = await previewRows(id);
      expect(rows[0].preview.days.map((d) => d.to)).toEqual(['off', 'day', 'night']);
    });

    it('rejects an unsupported shift value rather than coercing it', async () => {
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 2: 'Holiday' }),
      ]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('unsupported shift value');
    });

    it('rejects a single-letter abbreviation rather than guessing at it', async () => {
      // "O" could be Off or a typo; "N" could be Night or "No". A loud error
      // the administrator can fix beats a quiet guess about who gets fed.
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'D', 2: 'N', 3: 'O' }),
      ]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('unsupported shift value');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);
    });

    it('a whitespace-only cell is blank, not a value', async () => {
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 2: '   ' }),
      ]);
      expect(body.data.outcome).toBe('ready');
      await commit(id);
      // Only day 1 was represented; the padded cell wrote nothing at all.
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(1);
      expect(await entry(shiftWorker.id, '2027-03-02')).toBeNull();
    });

    it('treats a blank day cell as "not represented", not as Off', async () => {
      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 3: 'Night' }),
      ]);
      const rows = await previewRows(id);
      // Day 2 is absent entirely; it is neither imported nor recorded as off.
      expect(rows[0].preview.days.map((d) => d.work_date)).toEqual(['2027-03-01', '2027-03-03']);
    });

    it('rejects a row that carries no shift values at all', async () => {
      const { id, body } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, {})]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('no shift values');
    });
  });

  // ==========================================================================
  // EMPLOYEE IDENTITY
  // ==========================================================================

  describe('employee identity', () => {
    it('rejects a roster row for an unknown AMCO ID and NEVER creates the employee', async () => {
      const before = await countRows(db, 'SELECT COUNT(*) as n FROM employees');

      const { id, body } = await uploadAndValidate([
        rosterRow('TEST404', MONTH, YEAR, { 1: 'Day' }),
      ]);

      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('No employee with AMCO ID');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM employees')).toBe(before);

      const res = await commit(id);
      expect(res.status).toBe(409);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM employees')).toBe(before);
    });

    it('rejects an AMCO ID with unsupported characters', async () => {
      const { body } = await uploadAndValidate([
        rosterRow('BAD ID/../x', MONTH, YEAR, { 1: 'Day' }),
      ]);
      expect(body.data.outcome).toBe('failed');
    });

    it('rejects a missing AMCO ID', async () => {
      const { id, body } = await uploadAndValidate([rosterRow('', MONTH, YEAR, { 1: 'Day' })]);
      expect(body.data.outcome).toBe('failed');
      expect((await previewRows(id))[0].messages.join(' ')).toContain('AMCO ID is missing');
    });

    it('imports a roster for a REGULAR employee without objecting', async () => {
      // The importer records roster data; eligibility decides what it means.
      const regular = await seedEmployee(db, { amcoId: 'TEST200', rosterType: 'regular' });
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST200', MONTH, YEAR, { 1: 'Day' }),
      ]);
      expect(body.data.outcome).toBe('ready');
      await commit(id);
      expect(await entry(regular.id, '2027-03-01')).not.toBeNull();
    });
  });

  // ==========================================================================
  // CLASSIFICATION
  // ==========================================================================

  describe('classification', () => {
    it('classifies a date with no existing entry as CREATE', async () => {
      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      const rows = await previewRows(id);
      expect(rows[0].preview.action).toBe('CREATE');
      expect(rows[0].preview.days[0]).toMatchObject({
        work_date: '2027-03-01',
        action: 'CREATE',
        from: null,
        to: 'day',
      });
    });

    it('classifies a changed entry as UPDATE and shows before/after', async () => {
      await seedEntry(shiftWorker.id, '2027-03-01', 'off');

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      const rows = await previewRows(id);

      expect(rows[0].preview.action).toBe('UPDATE');
      expect(rows[0].preview.days[0]).toMatchObject({ action: 'UPDATE', from: 'off', to: 'day' });
    });

    it('classifies an identical entry as UNCHANGED', async () => {
      await seedEntry(shiftWorker.id, '2027-03-01', 'day');

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      const rows = await previewRows(id);

      expect(rows[0].preview.action).toBe('UNCHANGED');
      expect(rows[0].preview.days[0]).toMatchObject({ action: 'UNCHANGED', from: 'day', to: 'day' });
    });

    it('reports a mixed row with accurate per-action counts', async () => {
      await seedEntry(shiftWorker.id, '2027-03-01', 'day'); // unchanged
      await seedEntry(shiftWorker.id, '2027-03-02', 'off'); // -> night, update

      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 2: 'Night', 3: 'Off' }),
      ]);
      const rows = await previewRows(id);

      expect(rows[0].preview.counts).toEqual({ create: 1, update: 1, unchanged: 1 });
      expect(rows[0].preview.action).toBe('UPDATE');
    });

    it('a soft-deleted entry reads as absent, so the workbook re-creates it', async () => {
      await seedEntry(shiftWorker.id, '2027-03-01', 'off');
      await db
        .prepare("UPDATE roster_entries SET deleted_at = datetime('now') WHERE employee_id = ?")
        .bind(shiftWorker.id)
        .run();

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      const rows = await previewRows(id);
      expect(rows[0].preview.days[0]).toMatchObject({ action: 'CREATE', from: null });

      await commit(id);
      const revived = await entry(shiftWorker.id, '2027-03-01');
      expect(revived!.shift_value).toBe('day');
      expect(revived!.deleted_at).toBeNull();
    });
  });

  // ==========================================================================
  // DUPLICATES
  // ==========================================================================

  describe('duplicates', () => {
    it('rejects the same employee and date twice rather than picking one', async () => {
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' }),
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Night' }),
      ]);

      expect(body.data.outcome).toBe('failed');
      expect(body.data.invalid_rows).toBe(2);

      const rows = await previewRows(id);
      for (const row of rows) {
        expect(row.messages.join(' ')).toContain('appears more than once');
        expect(row.messages.join(' ')).toContain('2027-03-01');
      }
    });

    it('rejects a duplicate employee/date even when the VALUE is identical', async () => {
      // Deduplicating silently would hide a workbook that is wrong about how
      // many times a person appears.
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' }),
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' }),
      ]);
      expect(body.data.outcome).toBe('failed');
      expect(body.data.invalid_rows).toBe(2);
      expect((await previewRows(id))[0].messages.join(' ')).toContain('appears more than once');
    });

    it('allows the same employee across DIFFERENT months', async () => {
      const { body } = await uploadAndValidate([
        rosterRow('TEST100', 3, YEAR, { 1: 'Day' }),
        rosterRow('TEST100', 4, YEAR, { 1: 'Night' }),
      ]);
      expect(body.data.outcome).toBe('ready');
    });

    it('allows different employees on the same date', async () => {
      await seedEmployee(db, { amcoId: 'TEST101', rosterType: 'shift' });
      const { body } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' }),
        rosterRow('TEST101', MONTH, YEAR, { 1: 'Night' }),
      ]);
      expect(body.data.outcome).toBe('ready');
    });

    it('flags only the overlapping dates, and blocks the whole batch', async () => {
      const { id, body } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 2: 'Day' }),
        rosterRow('TEST100', MONTH, YEAR, { 2: 'Night', 3: 'Off' }),
      ]);
      expect(body.data.outcome).toBe('failed');
      const rows = await previewRows(id);
      expect(rows[0].messages.join(' ')).toContain('2027-03-02');
      expect(rows[0].messages.join(' ')).not.toContain('2027-03-01');
    });
  });

  // ==========================================================================
  // BOUNDARY: nothing operational is written before commit
  // ==========================================================================

  describe('validation/commit boundary', () => {
    it('COMMIT is the only step that writes roster_entries', async () => {
      db.executedWrites.length = 0;

      const res = await uploadWorkbook(buildRosterWorkbook([ROW_BASIC]));
      const batch = (await readJson(res)).data as { id: number };
      expect(db.executedWrites.filter((sql) => /roster_entries/i.test(sql))).toEqual([]);

      await validate(batch.id);
      expect(db.executedWrites.filter((sql) => /roster_entries/i.test(sql))).toEqual([]);

      await preview(batch.id);
      expect(db.executedWrites.filter((sql) => /roster_entries/i.test(sql))).toEqual([]);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);

      // The work really was done - it just was not applied.
      expect(
        await countRows(
          db,
          'SELECT COUNT(*) as n FROM import_batch_rows WHERE import_batch_id = ?',
          batch.id
        )
      ).toBe(1);

      await commit(batch.id);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(3);
    });

    it('validating an INVALID workbook writes no roster entry either', async () => {
      db.executedWrites.length = 0;
      await uploadAndValidate([rosterRow('TEST404', MONTH, YEAR, { 1: 'Day' })]);

      expect(db.executedWrites.filter((sql) => /roster_entries/i.test(sql))).toEqual([]);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);
    });

    it('never writes to employees at any step', async () => {
      db.executedWrites.length = 0;
      const { id } = await uploadAndValidate([ROW_BASIC]);
      await commit(id);

      expect(db.executedWrites.filter((sql) => /\bemployees\b/i.test(sql))).toEqual([]);
    });
  });

  // ==========================================================================
  // COMMIT
  // ==========================================================================

  describe('commit', () => {
    it('creates the represented roster entries with source "import"', async () => {
      const { id } = await uploadAndValidate([ROW_BASIC]);
      await commit(id);

      expect((await entry(shiftWorker.id, '2027-03-01'))!.shift_value).toBe('day');
      expect((await entry(shiftWorker.id, '2027-03-02'))!.shift_value).toBe('night');
      expect((await entry(shiftWorker.id, '2027-03-03'))!.shift_value).toBe('off');
      expect((await entry(shiftWorker.id, '2027-03-01'))!.source).toBe('import');
    });

    it('updates an existing entry in place, keeping its row id', async () => {
      await seedEntry(shiftWorker.id, '2027-03-01', 'off');
      const before = await entry(shiftWorker.id, '2027-03-01');

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      await commit(id);

      const after = await entry(shiftWorker.id, '2027-03-01');
      expect(after!.id).toBe(before!.id); // updated, not deleted and re-inserted
      expect(after!.shift_value).toBe('day');
    });

    it('applies a mixed row correctly', async () => {
      await seedEntry(shiftWorker.id, '2027-03-01', 'day');
      await seedEntry(shiftWorker.id, '2027-03-02', 'off');

      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 2: 'Night', 3: 'Off' }),
      ]);
      await commit(id);

      expect((await entry(shiftWorker.id, '2027-03-01'))!.shift_value).toBe('day');
      expect((await entry(shiftWorker.id, '2027-03-02'))!.shift_value).toBe('night');
      expect((await entry(shiftWorker.id, '2027-03-03'))!.shift_value).toBe('off');
    });

    it('refuses to commit a workbook containing any invalid row', async () => {
      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' }),
        rosterRow('TEST404', MONTH, YEAR, { 1: 'Day' }),
      ]);

      const res = await commit(id);
      expect(res.status).toBe(409);
      // The valid row was NOT partially applied.
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);
    });

    it('an upsert preserves the row id, employee, date and created_at', async () => {
      await db
        .prepare(
          `INSERT INTO roster_entries (employee_id, work_date, shift_value, source, created_at)
           VALUES (?, '2027-03-01', 'off', 'manual', '2020-01-01 00:00:00')`
        )
        .bind(shiftWorker.id)
        .run();
      const before = await entry(shiftWorker.id, '2027-03-01');

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      await commit(id);

      const after = await entry(shiftWorker.id, '2027-03-01');
      // ON CONFLICT DO UPDATE touches shift_value, source, updated_at and
      // deleted_at only - never the identity columns or created_at.
      expect(after!.id).toBe(before!.id);
      expect(after!.employee_id).toBe(before!.employee_id);
      expect(after!.work_date).toBe(before!.work_date);
      expect(after!.created_at).toBe(before!.created_at);
      expect(after!.shift_value).toBe('day');
      // Still exactly one row: an upsert, never a delete-and-reinsert.
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(1);
    });

    it('a failure INSIDE the batch rolls back the earlier successful write', async () => {
      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 2: 'Night' }),
      ]);

      // Corrupt the staged row so the SECOND write violates the shift_value
      // CHECK constraint at write time, while the first would have succeeded.
      // This exercises rollback inside db.batch() itself, which a failure
      // before the batch (an employee vanishing) cannot reach.
      const staged = await db
        .prepare('SELECT preview_json FROM import_batch_rows WHERE import_batch_id = ?')
        .bind(id)
        .first<{ preview_json: string }>();
      const parsed = JSON.parse(staged!.preview_json);
      parsed.days[1].to = 'holiday';
      await db
        .prepare('UPDATE import_batch_rows SET preview_json = ? WHERE import_batch_id = ?')
        .bind(JSON.stringify(parsed), id)
        .run();

      const res = await commit(id);
      expect(res.status).toBe(500);

      // The FIRST day's write must be gone too: all or nothing.
      expect(await entry(shiftWorker.id, '2027-03-01')).toBeNull();
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);

      const batchRow = await db
        .prepare('SELECT status, committed_at FROM import_batches WHERE id = ?')
        .bind(id)
        .first<{ status: string; committed_at: string | null }>();
      expect(batchRow!.status).toBe('commit_failed');
      expect(batchRow!.committed_at).toBeNull();
    });

    it('commits atomically: a failed write applies nothing', async () => {
      const other = await seedEmployee(db, { amcoId: 'TEST101', rosterType: 'shift' });

      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' }),
        rosterRow('TEST101', MONTH, YEAR, { 1: 'Night' }),
      ]);

      // Between validation and commit the second employee is removed, so
      // resolving their roster fails and the whole commit must fail closed.
      await db.prepare('DELETE FROM employees WHERE id = ?').bind(other.id).run();

      const res = await commit(id);
      expect(res.status).toBe(500);

      // The FIRST employee's entry must NOT have landed: all or nothing.
      expect(await entry(shiftWorker.id, '2027-03-01')).toBeNull();

      const batchRow = await db
        .prepare('SELECT status, committed_at FROM import_batches WHERE id = ?')
        .bind(id)
        .first<{ status: string; committed_at: string | null }>();
      expect(batchRow!.status).toBe('commit_failed');
      expect(batchRow!.committed_at).toBeNull();
    });
  });

  // ==========================================================================
  // IDEMPOTENCY
  // ==========================================================================

  describe('idempotency', () => {
    it('issues NO write for an all-UNCHANGED workbook', async () => {
      await seedEntry(shiftWorker.id, '2027-03-01', 'day');
      await seedEntry(shiftWorker.id, '2027-03-02', 'night');

      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 2: 'Night' }),
      ]);

      db.executedWrites.length = 0;
      await commit(id);

      expect(db.executedWrites.filter((sql) => /roster_entries/i.test(sql))).toEqual([]);
    });

    it('writes ONLY the changed cells in a mixed workbook', async () => {
      await seedEntry(shiftWorker.id, '2027-03-01', 'day'); // unchanged
      await seedEntry(shiftWorker.id, '2027-03-02', 'off'); // -> night

      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 1: 'Day', 2: 'Night' }),
      ]);

      db.executedWrites.length = 0;
      await commit(id);

      // Exactly one statement, for the one cell that actually differs.
      expect(db.executedWrites.filter((sql) => /roster_entries/i.test(sql))).toHaveLength(1);
      expect((await entry(shiftWorker.id, '2027-03-02'))!.shift_value).toBe('night');
    });

    it('re-importing the same workbook yields all UNCHANGED and zero writes', async () => {
      const first = await uploadAndValidate([ROW_BASIC]);
      await commit(first.id);

      const second = await uploadAndValidate([ROW_BASIC]);
      expect(second.body.data.outcome).toBe('ready');

      const rows = await previewRows(second.id);
      expect(rows[0].preview.action).toBe('UNCHANGED');
      expect(rows[0].preview.counts).toEqual({ create: 0, update: 0, unchanged: 3 });

      db.executedWrites.length = 0;
      await commit(second.id);
      expect(db.executedWrites.filter((sql) => /roster_entries/i.test(sql))).toEqual([]);
    });
  });

  // ==========================================================================
  // MONTHLY RECONCILIATION - what happens to what the workbook omits
  // ==========================================================================

  describe('monthly reconciliation', () => {
    it('leaves dates the workbook does NOT mention completely alone', async () => {
      await seedEntry(shiftWorker.id, '2027-03-10', 'night');
      const before = await entry(shiftWorker.id, '2027-03-10');

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      await commit(id);

      // Not cleared, not zeroed, not soft-deleted: untouched.
      expect(await entry(shiftWorker.id, '2027-03-10')).toEqual(before);
    });

    it('leaves employees ABSENT from the workbook completely alone', async () => {
      const absent = await seedEmployee(db, { amcoId: 'TEST101', rosterType: 'shift' });
      await seedEntry(absent.id, '2027-03-01', 'night');
      const before = await entry(absent.id, '2027-03-01');

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      await commit(id);

      expect(await entry(absent.id, '2027-03-01')).toEqual(before);
      const employee = await db
        .prepare('SELECT * FROM employees WHERE id = ?')
        .bind(absent.id)
        .first<Record<string, unknown>>();
      expect(employee!.is_active).toBe(1);
    });

    it('never deletes or soft-deletes a roster entry', async () => {
      await seedEntry(shiftWorker.id, '2027-03-10', 'night');

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      db.executedWrites.length = 0;
      await commit(id);

      const writes = db.executedWrites.join(' ');
      expect(writes).not.toMatch(/DELETE\s+FROM\s+roster_entries/i);
      expect(writes).not.toMatch(/deleted_at\s*=\s*datetime/i);
      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries WHERE deleted_at IS NOT NULL')
      ).toBe(0);
    });

    it('leaves roster entries in OTHER months alone', async () => {
      await seedEntry(shiftWorker.id, '2027-04-01', 'night');
      const before = await entry(shiftWorker.id, '2027-04-01');

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      await commit(id);

      expect(await entry(shiftWorker.id, '2027-04-01')).toEqual(before);
    });
  });

  // ==========================================================================
  // PRESERVATION
  // ==========================================================================

  describe('preservation', () => {
    it('PRESERVES the employee password, role, active status and row id', async () => {
      const target = await seedEmployee(db, {
        amcoId: 'TEST101',
        rosterType: 'shift',
        roleId: ROLE_ADMIN,
        isActive: false,
      });
      await setEmployeePasswordDirect(db, target.id, 'original-password-here');

      const before = await db
        .prepare('SELECT * FROM employees WHERE id = ?')
        .bind(target.id)
        .first<Record<string, unknown>>();

      const { id } = await uploadAndValidate([rosterRow('TEST101', MONTH, YEAR, { 1: 'Day' })]);
      await commit(id);

      const after = await db
        .prepare('SELECT * FROM employees WHERE id = ?')
        .bind(target.id)
        .first<Record<string, unknown>>();

      // The entire employee row is byte-identical.
      expect(after).toEqual(before);
      expect(after!.password_hash).toBe(before!.password_hash);
      expect(after!.role_id).toBe(ROLE_ADMIN);
      expect(after!.is_active).toBe(0);
    });

    it('PRESERVES lunch selections and selection history', async () => {
      await seedMenuDay(db, '2027-03-01', 'published');
      await db
        .prepare(
          `INSERT INTO lunch_selections (employee_id, meal_date, choice, source)
           VALUES (?, '2027-03-01', 'option_1', 'employee')`
        )
        .bind(shiftWorker.id)
        .run();
      await db
        .prepare(
          `INSERT INTO lunch_selection_history (employee_id, meal_date, new_choice, source)
           VALUES (?, '2027-03-01', 'option_1', 'employee')`
        )
        .bind(shiftWorker.id)
        .run();

      const selectionBefore = await db
        .prepare('SELECT * FROM lunch_selections WHERE employee_id = ?')
        .bind(shiftWorker.id)
        .first<Record<string, unknown>>();

      const { id } = await uploadAndValidate([ROW_BASIC]);
      await commit(id);

      expect(
        await countRows(
          db,
          'SELECT COUNT(*) as n FROM lunch_selections WHERE employee_id = ?',
          shiftWorker.id
        )
      ).toBe(1);
      expect(
        await countRows(
          db,
          'SELECT COUNT(*) as n FROM lunch_selection_history WHERE employee_id = ?',
          shiftWorker.id
        )
      ).toBe(1);
      // Not deleted and re-created: the same row, unchanged.
      expect(
        await db
          .prepare('SELECT * FROM lunch_selections WHERE employee_id = ?')
          .bind(shiftWorker.id)
          .first<Record<string, unknown>>()
      ).toEqual(selectionBefore);
    });

    it('the import touches no other domain table', async () => {
      const { id } = await uploadAndValidate([ROW_BASIC]);
      await commit(id);

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM holidays')).toBe(0);
    });
  });

  // ==========================================================================
  // ELIGIBILITY REMAINS THE SINGLE AUTHORITY
  // ==========================================================================

  describe('eligibility', () => {
    it('the importer stores shift values without deciding eligibility', async () => {
      const { id } = await uploadAndValidate([ROW_BASIC]);
      await commit(id);

      // No eligibility verdict is recorded anywhere by the import.
      const raw = JSON.stringify(await previewRows(id));
      expect(raw).not.toContain('eligible');
      expect(raw).not.toContain('ROSTER_MISSING');
    });

    it('an imported Day shift becomes eligible through the EXISTING service', async () => {
      await seedMenuDay(db, '2027-03-02', 'published');
      const { id } = await uploadAndValidate([
        rosterRow('TEST100', MONTH, YEAR, { 2: 'Day' }),
      ]);
      await commit(id);

      const stored = await entry(shiftWorker.id, '2027-03-02');
      expect(stored!.shift_value).toBe('day');
    });
  });

  // ==========================================================================
  // STATE MACHINE
  // ==========================================================================

  describe('state machine', () => {
    it('cannot commit before validation', async () => {
      const res = await uploadWorkbook(buildRosterWorkbook([ROW_BASIC]));
      const batch = (await readJson(res)).data as { id: number };

      const commitRes = await commit(batch.id);
      expect(commitRes.status).toBe(409);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);
    });

    it('cannot commit twice', async () => {
      const { id } = await uploadAndValidate([ROW_BASIC]);
      expect((await commit(id)).status).toBe(200);
      expect((await commit(id)).status).toBe(409);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(3);
    });

    it('CONCURRENT commits apply the workbook exactly once', async () => {
      const { id } = await uploadAndValidate([ROW_BASIC]);
      const [a, b] = await Promise.all([commit(id), commit(id)]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(3);
    });
  });

  // ==========================================================================
  // SECURITY AND AUDIT
  // ==========================================================================

  describe('security and audit', () => {
    it('a non-admin cannot upload, validate or commit a roster import', async () => {
      const worker = await seedEmployee(db, { amcoId: 'TEST300' });
      const res = await uploadWorkbook(buildRosterWorkbook([ROW_BASIC]), { cookie: worker.cookie });
      expect(res.status).toBe(403);
    });

    it('an unauthenticated caller cannot upload', async () => {
      const res = await uploadWorkbook(buildRosterWorkbook([ROW_BASIC]), { cookie: '' });
      expect(res.status).toBe(401);
    });

    it('no preview or response exposes a password hash or session token', async () => {
      await setEmployeePasswordDirect(db, shiftWorker.id, 'original-password-here');

      const { id } = await uploadAndValidate([ROW_BASIC]);
      const raw = JSON.stringify(await readJson(await preview(id)));

      expect(raw).not.toContain('password_hash');
      expect(raw).not.toContain('pbkdf2');
      expect(raw).not.toContain('original-password-here');
      expect(raw).not.toContain('session');
    });

    it('the audit records the import at batch level, without workbook contents', async () => {
      const { id } = await uploadAndValidate([ROW_BASIC]);
      await commit(id);

      const audit = await db.prepare('SELECT * FROM audit_log').all<Record<string, unknown>>();
      const raw = JSON.stringify(audit.results);

      expect(raw).toContain('CREATE_IMPORT');
      expect(raw).toContain('VALIDATE_IMPORT');
      expect(raw).toContain('COMMIT_IMPORT');
      expect(raw).toContain('roster');
      expect(raw).not.toContain('password');
      expect(raw).not.toContain('r2_object_key');
    });

    it('does not create one audit row per roster day', async () => {
      // 20 day cells in one row: still three batch-level records, not twenty.
      const days: Record<number, string> = {};
      for (let d = 1; d <= 20; d += 1) days[d] = d % 2 === 0 ? 'Day' : 'Night';

      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, days)]);
      await commit(id);

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(20);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(3);
    });

    it('per-day before/after stays reconstructible from the staged rows', async () => {
      await seedEntry(shiftWorker.id, '2027-03-01', 'off');
      const { id } = await uploadAndValidate([rosterRow('TEST100', MONTH, YEAR, { 1: 'Day' })]);
      await commit(id);

      const staged = await db
        .prepare('SELECT preview_json FROM import_batch_rows WHERE import_batch_id = ?')
        .bind(id)
        .first<{ preview_json: string }>();

      const parsed = JSON.parse(staged!.preview_json);
      expect(parsed.days[0]).toMatchObject({ work_date: '2027-03-01', from: 'off', to: 'day' });
    });
  });

  // ==========================================================================
  // R2 AND HISTORY
  // ==========================================================================

  describe('R2 and history', () => {
    it('preserves the ORIGINAL workbook in R2, unmodified', async () => {
      const bytes = buildRosterWorkbook([ROW_BASIC]);
      const res = await uploadWorkbook(bytes);
      const batch = (await readJson(res)).data as { id: number };

      await validate(batch.id);
      await commit(batch.id);

      const stored = bucket.objects.get(`imports/roster/${batch.id}/source.xlsx`);
      expect(stored).toBeDefined();
      expect(new Uint8Array(stored!.body)).toEqual(bytes);
    });

    it('import history shows the roster import with its result', async () => {
      const { id } = await uploadAndValidate([ROW_BASIC]);
      await commit(id);

      const body = await readJson(
        await app.request(IMPORTS, { headers: { Cookie: admin.cookie } }, env)
      );
      const found = body.data.imports.find((i: { id: number }) => i.id === id);

      expect(found.import_type).toBe('roster');
      expect(found.status).toBe('committed');
      expect(found.file_archived).toBe(true);
    });
  });

  // ==========================================================================
  // REGISTRY
  // ==========================================================================

  describe('registry', () => {
    it('a roster workbook is NOT accepted as a menu import', async () => {
      // The menu importer is registered as of Phase 4 Slice 4, so this no
      // longer reports not_implemented. What must still hold is that the two
      // types are not interchangeable: a roster file offered as a menu is
      // rejected on its contents rather than half-imported.
      const form = new FormData();
      form.set('import_type', 'menu');
      form.set('file', new File([buildRosterWorkbook([ROW_BASIC]) as unknown as BlobPart], 'menu.xlsx'));
      const res = await app.request(
        IMPORTS,
        { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
        env
      );
      const batch = (await readJson(res)).data as { id: number };

      const validated = await readJson(await validate(batch.id));
      expect(validated.data.outcome).toBe('failed');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);
    });

    it('the employee importer still works alongside the roster importer', async () => {
      const form = new FormData();
      form.set('import_type', 'employees');
      form.set(
        'file',
        new File(
          [
            buildWorkbook([
              {
                name: 'All Employees',
                rows: [
                  ['AMCO ID#', 'Name', 'Department', 'Section', 'Roster'],
                  ['TEST500', 'Epsilon Person', 'Mining', 'Operations', 'Shift'],
                ],
              },
            ]) as unknown as BlobPart,
          ],
          'employees.xlsx'
        )
      );
      const res = await app.request(
        IMPORTS,
        { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
        env
      );
      const batch = (await readJson(res)).data as { id: number };

      expect((await readJson(await validate(batch.id))).data.outcome).toBe('ready');
      expect((await commit(batch.id)).status).toBe(200);

      const created = await db
        .prepare('SELECT * FROM employees WHERE amco_id = ?')
        .bind('TEST500')
        .first<Record<string, unknown>>();
      expect(created).not.toBeNull();
    });
  });
});
