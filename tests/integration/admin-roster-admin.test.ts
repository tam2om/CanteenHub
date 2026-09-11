// @vitest-environment node
/**
 * Integration Tests - manual roster administration.
 *
 * Real Hono routes, real SQL against the real migrations. Every employee here
 * is invented.
 *
 * 2027-03-01 is a Monday; 2027-03-05 is a Friday.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { getEligibilityWithNextDate } from '../../src/worker/services/eligibility.service.js';
import type { Employee } from '../../src/shared/types/index.js';
import type { BusinessDate } from '../../src/worker/lib/datetime.js';
import { buildRosterWorkbook, rosterRow } from '../helpers/xlsxFixture.js';
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
const ROSTER = `${BASE}/api/roster`;
const DATE = '2027-03-01';
const FRIDAY = '2027-03-05';

describe('Manual roster administration', () => {
  let db: TestD1Database;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let superAdmin: SeededEmployee;
  let shiftWorker: SeededEmployee;
  let regular: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    env = testEnv(db);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN, rosterType: 'amman_hq' });
    superAdmin = await seedEmployee(db, { amcoId: 'TEST901', roleId: ROLE_SUPER_ADMIN, rosterType: 'amman_hq' });
    shiftWorker = await seedEmployee(db, { amcoId: 'TEST100', fullName: 'Alpha Shift', rosterType: 'shift' });
    regular = await seedEmployee(db, { amcoId: 'TEST200', fullName: 'Beta Regular', rosterType: 'regular' });
  });

  const get = (path: string, cookie = admin.cookie) =>
    app.request(`${BASE}${path}`, cookie ? { headers: { Cookie: cookie } } : {}, env);
  const post = (body: unknown, cookie = admin.cookie) =>
    app.request(ROSTER, jsonRequest(body, cookie), env);
  const del = (employeeId: number, date: string, cookie = admin.cookie) =>
    app.request(`${ROSTER}/${employeeId}/${date}`, { method: 'DELETE', headers: cookie ? { Cookie: cookie } : {} }, env);

  const setShift = (employeeId: number, date: string, shift: string, cookie = admin.cookie) =>
    post({ employee_id: employeeId, work_date: date, shift_value: shift }, cookie);

  const dayView = async (query = `?date=${DATE}`, cookie = admin.cookie) => {
    const res = await get(`/api/roster/admin/day${query}`, cookie);
    return { res, body: res.status === 200 ? (await readJson(res)).data : await readJson(res) };
  };

  interface DayRow {
    employee_id: number;
    amco_id: string;
    full_name: string;
    roster_type: string;
    department: string | null;
    section: string | null;
    roster_entry_id: number | null;
    shift_value: string | null;
    source: string | null;
  }

  const rowFor = (body: { employees: DayRow[] }, id: number): DayRow | undefined =>
    body.employees.find((e) => e.employee_id === id);

  const storedShift = async (employeeId: number, date: string) =>
    (await db
      .prepare('SELECT shift_value FROM roster_entries WHERE employee_id = ? AND work_date = ? AND deleted_at IS NULL')
      .bind(employeeId, date)
      .first<{ shift_value: string }>())?.shift_value ?? null;

  /**
   * The authoritative eligibility verdict for an arbitrary date.
   *
   * Read straight from the service the portal and the selection endpoint use.
   * /api/me/today reports only today, so it cannot answer for a chosen date -
   * and calling the real service is the stronger evidence anyway: it proves the
   * manual roster change reaches the engine, not a copy of it.
   */
  const eligibilityFor = async (employeeId: number, date: string) => {
    const employee = await db
      .prepare('SELECT * FROM employees WHERE id = ?')
      .bind(employeeId)
      .first<Employee>();
    return getEligibilityWithNextDate(db, employee!, date as BusinessDate);
  };

  // ==========================================================================
  // AUTHORIZATION
  // ==========================================================================

  describe('authorization', () => {
    it('an admin can view the roster for a date', async () => {
      expect((await dayView()).res.status).toBe(200);
    });

    it('a super_admin can view it', async () => {
      expect((await dayView(`?date=${DATE}`, superAdmin.cookie)).res.status).toBe(200);
    });

    it('an EMPLOYEE cannot view it', async () => {
      expect((await dayView(`?date=${DATE}`, shiftWorker.cookie)).res.status).toBe(403);
    });

    it('an unauthenticated caller cannot view it', async () => {
      expect((await dayView(`?date=${DATE}`, '')).res.status).toBe(401);
    });

    it('an EMPLOYEE cannot set or remove a roster entry, even their own', async () => {
      await setShift(shiftWorker.id, DATE, 'day');

      expect((await setShift(shiftWorker.id, DATE, 'night', shiftWorker.cookie)).status).toBe(403);
      expect((await del(shiftWorker.id, DATE, shiftWorker.cookie)).status).toBe(403);

      // Their own id bought them nothing.
      expect(await storedShift(shiftWorker.id, DATE)).toBe('day');
    });

    it('an unauthenticated caller cannot mutate', async () => {
      expect((await setShift(shiftWorker.id, DATE, 'day', '')).status).toBe(401);
      expect((await del(shiftWorker.id, DATE, '')).status).toBe(401);
    });
  });

  // ==========================================================================
  // THE DAY VIEW
  // ==========================================================================

  describe('day view', () => {
    it('includes EVERY employee, with or without an entry', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      const { body } = await dayView();

      expect(body.employees).toHaveLength(4);
      expect(rowFor(body, shiftWorker.id)!.shift_value).toBe('day');
      // The employee with no entry is present and visible.
      expect(rowFor(body, regular.id)).toBeDefined();
    });

    it('represents a MISSING roster as null, never as Off', async () => {
      const { body } = await dayView();
      const row = rowFor(body, shiftWorker.id)!;

      expect(row.shift_value).toBeNull();
      expect(row.shift_value).not.toBe('off');
      expect(row.roster_entry_id).toBeNull();
    });

    it('returns day, night and off distinctly', async () => {
      const night = await seedEmployee(db, { amcoId: 'TEST101', rosterType: 'shift' });
      const off = await seedEmployee(db, { amcoId: 'TEST102', rosterType: 'shift' });
      await setShift(shiftWorker.id, DATE, 'day');
      await setShift(night.id, DATE, 'night');
      await setShift(off.id, DATE, 'off');

      const { body } = await dayView();
      expect(rowFor(body, shiftWorker.id)!.shift_value).toBe('day');
      expect(rowFor(body, night.id)!.shift_value).toBe('night');
      expect(rowFor(body, off.id)!.shift_value).toBe('off');
    });

    it('carries the identifying and organisational fields an admin needs', async () => {
      const { body } = await dayView();
      const row = rowFor(body, shiftWorker.id)!;

      expect(row.amco_id).toBe('TEST100');
      expect(row.full_name).toBe('Alpha Shift');
      expect(row.roster_type).toBe('shift');
      expect(row).toHaveProperty('department');
      expect(row).toHaveProperty('section');
    });

    it('scopes strictly to the requested date', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      await setShift(shiftWorker.id, '2027-03-02', 'night');

      expect(rowFor((await dayView(`?date=${DATE}`)).body, shiftWorker.id)!.shift_value).toBe('day');
      expect(rowFor((await dayView('?date=2027-03-02')).body, shiftWorker.id)!.shift_value).toBe('night');
    });

    it('a SOFT-DELETED entry reads as missing', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      await del(shiftWorker.id, DATE);

      expect(rowFor((await dayView()).body, shiftWorker.id)!.shift_value).toBeNull();
    });

    it('defaults to the SERVER business date when none is given', async () => {
      const { body } = await dayView('');
      expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('rejects an invalid date', async () => {
      for (const date of ['2027-02-30', '2027-13-01', 'today', '01-03-2027']) {
        expect((await dayView(`?date=${encodeURIComponent(date)}`)).res.status).toBe(400);
      }
    });
  });

  // ==========================================================================
  // SEARCH AND FILTER - server-side
  // ==========================================================================

  describe('search and filter', () => {
    it('searches by name, case-insensitively', async () => {
      const { body } = await dayView(`?date=${DATE}&search=alpha`);
      expect(body.employees).toHaveLength(1);
      expect(body.employees[0].amco_id).toBe('TEST100');
    });

    it('searches by AMCO ID', async () => {
      const { body } = await dayView(`?date=${DATE}&search=TEST200`);
      expect(body.employees).toHaveLength(1);
      expect(body.employees[0].full_name).toBe('Beta Regular');
    });

    it('filters by roster type', async () => {
      const { body } = await dayView(`?date=${DATE}&roster_type=shift`);
      expect(body.employees.map((e: { amco_id: string }) => e.amco_id)).toEqual(['TEST100']);
    });

    it('combines search and roster type', async () => {
      const { body } = await dayView(`?date=${DATE}&search=TEST&roster_type=regular`);
      expect(body.employees.map((e: { amco_id: string }) => e.amco_id)).toEqual(['TEST200']);
    });

    it('rejects an invalid roster type rather than ignoring it', async () => {
      expect((await dayView(`?date=${DATE}&roster_type=nonsense`)).res.status).toBe(400);
    });

    it('a SQL-shaped search term cannot alter the query', async () => {
      const { res, body } = await dayView(`?date=${DATE}&search=${encodeURIComponent("' OR '1'='1")}`);
      expect(res.status).toBe(200);
      // Bound as a value: it matches nobody rather than everybody.
      expect(body.employees).toHaveLength(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM employees')).toBe(4);
    });

    it('a LIKE wildcard in the term is matched literally, not as a wildcard', async () => {
      // Without escaping, '%' would match every employee. It is a character the
      // administrator typed, so it matches only a name that contains it.
      expect((await dayView(`?date=${DATE}&search=${encodeURIComponent('%')}`)).body.employees).toHaveLength(0);
      expect((await dayView(`?date=${DATE}&search=${encodeURIComponent('_')}`)).body.employees).toHaveLength(0);

      const percent = await seedEmployee(db, { amcoId: 'TEST500', fullName: 'Discount 50% Person', rosterType: 'shift' });
      const found = (await dayView(`?date=${DATE}&search=${encodeURIComponent('50%')}`)).body.employees;
      expect(found.map((e: DayRow) => e.employee_id)).toEqual([percent.id]);
    });
  });

  // ==========================================================================
  // MANUAL EDITING
  // ==========================================================================

  describe('manual editing', () => {
    it('sets day, night and off', async () => {
      for (const shift of ['day', 'night', 'off']) {
        const res = await setShift(shiftWorker.id, DATE, shift);
        expect(res.status).toBeLessThan(300);
        expect(await storedShift(shiftWorker.id, DATE)).toBe(shift);
      }
    });

    it('records a manual edit as MANUAL, and refuses to be told otherwise', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      const row = await db
        .prepare('SELECT source FROM roster_entries WHERE employee_id = ?')
        .bind(shiftWorker.id).first<{ source: string }>();
      expect(row!.source).toBe('manual');

      // A caller cannot dress a hand correction up as an import.
      const res = await post({
        employee_id: shiftWorker.id, work_date: DATE, shift_value: 'night', source: 'import',
      });
      expect(res.status).toBe(400);
      expect(await storedShift(shiftWorker.id, DATE)).toBe('day');
    });

    it('removes an entry so the roster is genuinely MISSING, not Off', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      expect((await del(shiftWorker.id, DATE)).status).toBe(200);

      expect(await storedShift(shiftWorker.id, DATE)).toBeNull();
      expect(rowFor((await dayView()).body, shiftWorker.id)!.shift_value).toBeNull();
    });

    it('rejects an invalid shift value', async () => {
      for (const shift of ['holiday', 'DAY', '', 'sick', 'null']) {
        expect((await setShift(shiftWorker.id, DATE, shift)).status).toBe(400);
      }
      expect(await storedShift(shiftWorker.id, DATE)).toBeNull();
    });

    it('rejects an invalid date', async () => {
      for (const date of ['2027-02-30', 'tomorrow', '2027-13-01']) {
        expect((await setShift(shiftWorker.id, date, 'day')).status).toBe(400);
      }
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);
    });

    it('rejects an UNKNOWN employee with 404, not a database error', async () => {
      const res = await setShift(99999, DATE, 'day');
      expect(res.status).toBe(404);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);
    });

    it('leaves OTHER dates for the same employee untouched', async () => {
      await setShift(shiftWorker.id, '2027-03-02', 'night');
      const before = await db
        .prepare("SELECT * FROM roster_entries WHERE employee_id = ? AND work_date = '2027-03-02'")
        .bind(shiftWorker.id).first<Record<string, unknown>>();

      await setShift(shiftWorker.id, DATE, 'day');

      expect(
        await db.prepare("SELECT * FROM roster_entries WHERE employee_id = ? AND work_date = '2027-03-02'")
          .bind(shiftWorker.id).first<Record<string, unknown>>()
      ).toEqual(before);
    });

    it('leaves OTHER employees untouched', async () => {
      const other = await seedEmployee(db, { amcoId: 'TEST101', rosterType: 'shift' });
      await setShift(other.id, DATE, 'night');
      const before = await db
        .prepare('SELECT * FROM roster_entries WHERE employee_id = ?')
        .bind(other.id).first<Record<string, unknown>>();

      await setShift(shiftWorker.id, DATE, 'day');

      expect(
        await db.prepare('SELECT * FROM roster_entries WHERE employee_id = ?').bind(other.id).first<Record<string, unknown>>()
      ).toEqual(before);
    });

    it('an UPDATE keeps the entry row id - never delete and recreate', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      const before = await db
        .prepare('SELECT id FROM roster_entries WHERE employee_id = ?').bind(shiftWorker.id).first<{ id: number }>();

      await setShift(shiftWorker.id, DATE, 'night');

      const after = await db
        .prepare('SELECT id, shift_value FROM roster_entries WHERE employee_id = ?').bind(shiftWorker.id).first<{ id: number; shift_value: string }>();
      expect(after!.id).toBe(before!.id);
      expect(after!.shift_value).toBe('night');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(1);
    });

    it('never touches employee status, role or roster_type', async () => {
      await setEmployeePasswordDirect(db, shiftWorker.id, 'original-password-here');
      const before = await db
        .prepare('SELECT * FROM employees WHERE id = ?').bind(shiftWorker.id).first<Record<string, unknown>>();

      db.executedWrites.length = 0;
      await setShift(shiftWorker.id, DATE, 'day');
      await setShift(shiftWorker.id, DATE, 'off');
      await del(shiftWorker.id, DATE);

      expect(db.executedWrites.filter((s) => /\bemployees\b/i.test(s))).toEqual([]);
      expect(
        await db.prepare('SELECT * FROM employees WHERE id = ?').bind(shiftWorker.id).first<Record<string, unknown>>()
      ).toEqual(before);
    });
  });

  // ==========================================================================
  // IDEMPOTENCY
  // ==========================================================================

  describe('idempotency', () => {
    it('setting the SAME value again is a true no-op', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      const auditBefore = await countRows(db, 'SELECT COUNT(*) as n FROM audit_log');

      db.executedWrites.length = 0;
      const res = await setShift(shiftWorker.id, DATE, 'day');

      expect(res.status).toBe(200);
      expect((await readJson(res)).changed).toBe(false);
      // No write at all, and no audit noise.
      expect(db.executedWrites.filter((s) => /roster_entries/i.test(s))).toEqual([]);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(auditBefore);
    });

    it('a genuine change still writes and audits', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      const auditBefore = await countRows(db, 'SELECT COUNT(*) as n FROM audit_log');

      const res = await setShift(shiftWorker.id, DATE, 'night');
      expect((await readJson(res)).changed).toBe(true);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(auditBefore + 1);
    });

    it('re-creating a SOFT-DELETED entry with the same value is a real change', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      await del(shiftWorker.id, DATE);

      const res = await setShift(shiftWorker.id, DATE, 'day');
      expect((await readJson(res)).changed).toBe(true);
      expect(await storedShift(shiftWorker.id, DATE)).toBe('day');
    });

    it('deleting an already-missing entry is a safe 404 and writes nothing', async () => {
      db.executedWrites.length = 0;
      const first = await del(shiftWorker.id, DATE);
      const second = await del(shiftWorker.id, DATE);

      expect(first.status).toBe(404);
      expect(second.status).toBe(404);
      expect(db.executedWrites.filter((s) => /roster_entries/i.test(s))).toEqual([]);
      expect(await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'DELETE_ROSTER_ENTRY'")).toBe(0);
    });
  });

  // ==========================================================================
  // ELIGIBILITY - delegated to the existing engine
  // ==========================================================================

  describe('eligibility integration', () => {
    it('setting Day makes a shift employee eligible', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      const verdict = await eligibilityFor(shiftWorker.id, DATE);
      expect(verdict.eligible).toBe(true);
      expect(verdict.reason).toBe('SHIFT_DAY');
    });

    it('setting Night makes a shift employee eligible', async () => {
      await setShift(shiftWorker.id, DATE, 'night');
      const verdict = await eligibilityFor(shiftWorker.id, DATE);
      expect(verdict.eligible).toBe(true);
      expect(verdict.reason).toBe('SHIFT_NIGHT');
    });

    it('setting Off makes a shift employee NOT eligible', async () => {
      await setShift(shiftWorker.id, DATE, 'off');
      const verdict = await eligibilityFor(shiftWorker.id, DATE);
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toBe('SHIFT_OFF');
    });

    it('REMOVING the entry produces ROSTER_MISSING, not SHIFT_OFF', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      await del(shiftWorker.id, DATE);

      const verdict = await eligibilityFor(shiftWorker.id, DATE);
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toBe('ROSTER_MISSING');
      expect(verdict.reason).not.toBe('SHIFT_OFF');
    });

    it('a change takes effect immediately, with no cache to invalidate', async () => {
      await setShift(shiftWorker.id, DATE, 'off');
      expect((await eligibilityFor(shiftWorker.id, DATE)).reason).toBe('SHIFT_OFF');
      await setShift(shiftWorker.id, DATE, 'day');
      expect((await eligibilityFor(shiftWorker.id, DATE)).reason).toBe('SHIFT_DAY');
    });

    it('a roster entry does NOT override the rules for a REGULAR employee', async () => {
      // A regular employee follows the working-day rule whatever the roster says.
      await setShift(regular.id, FRIDAY, 'day');
      const verdict = await eligibilityFor(regular.id, FRIDAY);
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toBe('REGULAR_NON_WORKING_DAY');
    });

    it('an AMMAN HQ employee stays AMMAN_HQ_NO_MEAL whatever the roster says', async () => {
      await setShift(admin.id, DATE, 'day');
      const verdict = await eligibilityFor(admin.id, DATE);
      expect(verdict.eligible).toBe(false);
      expect(verdict.reason).toBe('AMMAN_HQ_NO_MEAL');
    });

    it('the roster routes contain no eligibility logic of their own', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      const raw = JSON.stringify(await readJson(await get(`/api/roster/admin/day?date=${DATE}`)));
      // The day view reports roster facts, never verdicts.
      expect(raw).not.toContain('eligible');
      expect(raw).not.toContain('SHIFT_DAY');
      expect(raw).not.toContain('ROSTER_MISSING');
    });
  });

  // ==========================================================================
  // AUDIT
  // ==========================================================================

  describe('audit', () => {
    it('records the actor, employee, date and before/after of a change', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      await setShift(shiftWorker.id, DATE, 'night');

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action LIKE '%ROSTER%' ORDER BY id")
        .all<{ actor_id: number; action: string; entity_id: number; before_json: string; after_json: string }>();

      expect(audit.results).toHaveLength(2);
      const [created, updated] = audit.results!;

      expect(created.action).toBe('CREATE_ROSTER_ENTRY');
      expect(created.actor_id).toBe(admin.id);
      expect(created.before_json).toBeNull();

      expect(updated.action).toBe('UPDATE_ROSTER_ENTRY');
      expect(updated.actor_id).toBe(admin.id);
      expect(JSON.parse(updated.before_json).shift_value).toBe('day');
      const after = JSON.parse(updated.after_json);
      // The audit service wraps after_json with the date.
      expect(after.work_date ?? after.roster_entry?.work_date).toBe(DATE);
      expect(JSON.stringify(after)).toContain('night');
    });

    it('records a deletion', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      await del(shiftWorker.id, DATE);

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'DELETE_ROSTER_ENTRY'")
        .all<{ actor_id: number; before_json: string }>();
      expect(audit.results).toHaveLength(1);
      expect(audit.results![0].actor_id).toBe(admin.id);
      expect(JSON.parse(audit.results![0].before_json).shift_value).toBe('day');
    });

    it('carries no password, session or credential data', async () => {
      await setEmployeePasswordDirect(db, shiftWorker.id, 'original-password-here');
      await setShift(shiftWorker.id, DATE, 'day');

      const audit = await db.prepare('SELECT * FROM audit_log').all<Record<string, unknown>>();
      const raw = JSON.stringify(audit.results);
      expect(raw).not.toContain('password');
      expect(raw).not.toContain('pbkdf2');
      expect(raw).not.toContain('original-password-here');
    });

    it('there is ONE history mechanism - no second roster history table', async () => {
      await setShift(shiftWorker.id, DATE, 'day');
      const tables = await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%roster%'")
        .all<{ name: string }>();
      expect(tables.results!.map((t) => t.name)).toEqual(['roster_entries']);
    });
  });

  // ==========================================================================
  // PRESERVATION
  // ==========================================================================

  describe('preservation', () => {
    it('leaves lunch selections and history byte-identical', async () => {
      await seedMenuDay(db, DATE, 'published');
      await db.prepare(
        `INSERT INTO lunch_selections (employee_id, meal_date, choice, source) VALUES (?, ?, 'option_1', 'employee')`
      ).bind(shiftWorker.id, DATE).run();
      await db.prepare(
        `INSERT INTO lunch_selection_history (employee_id, meal_date, new_choice, source) VALUES (?, ?, 'option_1', 'employee')`
      ).bind(shiftWorker.id, DATE).run();

      const before = await db
        .prepare('SELECT * FROM lunch_selections WHERE employee_id = ?').bind(shiftWorker.id).first<Record<string, unknown>>();

      await setShift(shiftWorker.id, DATE, 'day');
      await setShift(shiftWorker.id, DATE, 'off');
      await del(shiftWorker.id, DATE);

      expect(
        await db.prepare('SELECT * FROM lunch_selections WHERE employee_id = ?').bind(shiftWorker.id).first<Record<string, unknown>>()
      ).toEqual(before);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selection_history')).toBe(1);
    });

    it('never writes to menu tables', async () => {
      await seedMenuDay(db, DATE, 'published');
      db.executedWrites.length = 0;

      await setShift(shiftWorker.id, DATE, 'day');
      await del(shiftWorker.id, DATE);

      expect(db.executedWrites.filter((s) => /menu_days|menu_options|menu_components/i.test(s))).toEqual([]);
    });

    it('the day view exposes no password hash or session data', async () => {
      await setEmployeePasswordDirect(db, shiftWorker.id, 'original-password-here');
      const { body } = await dayView();
      const raw = JSON.stringify(body);

      expect(raw).not.toContain('password');
      expect(raw).not.toContain('pbkdf2');
      expect(raw).not.toContain('session');
      expect(raw).not.toContain('ip_address');
    });
  });

  // ==========================================================================
  // PERFORMANCE AND IMPORT INTERACTION
  // ==========================================================================

  describe('performance', () => {
    it('the day view is ONE query however many employees there are', async () => {
      for (let i = 0; i < 30; i += 1) {
        await seedEmployee(db, { amcoId: `TEST3${String(i).padStart(2, '0')}`, rosterType: 'shift' });
      }

      db.executedReads.length = 0;
      const { body } = await dayView();

      expect(body.employees).toHaveLength(34);
      const rosterReads = db.executedReads.filter((s) => /roster_entries/i.test(s));
      expect(rosterReads).toHaveLength(1);
      // Well under one query per employee, and under D1's 50/invocation cap.
      expect(db.executedReads.length).toBeLessThan(10);
    });
  });

  describe('import interaction', () => {
    const importRoster = async (rows: Array<Array<string | null>>) => {
      const form = new FormData();
      form.set('import_type', 'roster');
      form.set('file', new File([buildRosterWorkbook(rows) as unknown as BlobPart], 'r.xlsx'));
      const upload = await app.request(
        `${BASE}/api/admin/imports`,
        { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
        env
      );
      const batch = (await readJson(upload)).data as { id: number };
      await app.request(`${BASE}/api/admin/imports/${batch.id}/validate`, { method: 'POST', headers: { Cookie: admin.cookie } }, env);
      return app.request(`${BASE}/api/admin/imports/${batch.id}/commit`, { method: 'POST', headers: { Cookie: admin.cookie } }, env);
    };

    it('the Excel importer still works after manual edits', async () => {
      await setShift(shiftWorker.id, DATE, 'off');

      const res = await importRoster([rosterRow('TEST100', 3, 2027, { 1: 'Day' })]);
      expect(res.status).toBe(200);

      // The importer remains the bulk source of truth for the dates it covers.
      expect(await storedShift(shiftWorker.id, DATE)).toBe('day');
      const row = await db
        .prepare('SELECT source FROM roster_entries WHERE employee_id = ?').bind(shiftWorker.id).first<{ source: string }>();
      expect(row!.source).toBe('import');
    });

    it('an import does not disturb manual entries on dates it does not cover', async () => {
      await setShift(shiftWorker.id, '2027-03-20', 'night');
      const before = await db
        .prepare("SELECT * FROM roster_entries WHERE work_date = '2027-03-20'").first<Record<string, unknown>>();

      await importRoster([rosterRow('TEST100', 3, 2027, { 1: 'Day' })]);

      expect(
        await db.prepare("SELECT * FROM roster_entries WHERE work_date = '2027-03-20'").first<Record<string, unknown>>()
      ).toEqual(before);
    });

    it('a manual edit after an import wins for that date, and is recorded as manual', async () => {
      await importRoster([rosterRow('TEST100', 3, 2027, { 1: 'Day' })]);
      await setShift(shiftWorker.id, DATE, 'off');

      expect(await storedShift(shiftWorker.id, DATE)).toBe('off');
      const row = await db
        .prepare('SELECT source FROM roster_entries WHERE employee_id = ?').bind(shiftWorker.id).first<{ source: string }>();
      expect(row!.source).toBe('manual');
    });
  });
});
