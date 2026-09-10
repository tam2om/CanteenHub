// @vitest-environment node
/**
 * Integration Tests - import foundation.
 *
 * Real Hono routes, real SQL against the real migrations, and an in-memory R2
 * double that the production code path actually calls. All fixtures are
 * synthetic: no real workbook, employee name or AMCO ID appears anywhere.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/worker/index.js';
import { createTestDb, type TestD1Database } from '../helpers/d1.js';
import { createTestR2, fakeXlsxBytes, notAZipFile, legacyXlsBytes, type TestR2Bucket } from '../helpers/r2.js';
import {
  testEnv,
  seedEmployee,
  countRows,
  readJson,
  ROLE_ADMIN,
  ROLE_SUPER_ADMIN,
  type SeededEmployee,
} from '../helpers/fixtures.js';
import { VALIDATORS, COMMITTERS } from '../../src/worker/services/imports.service.js';
import type { ImportType } from '../../src/worker/lib/importFile.js';

const BASE = 'http://localhost';
const IMPORTS = `${BASE}/api/admin/imports`;

function uploadRequest(
  cookie: string | null,
  {
    importType = 'employees',
    filename = 'staff-list.xlsx',
    bytes = fakeXlsxBytes(),
  }: { importType?: string; filename?: string; bytes?: Uint8Array } = {}
): RequestInit {
  const form = new FormData();
  form.set('import_type', importType);
  form.set('file', new File([bytes as unknown as BlobPart], filename));

  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  return { method: 'POST', headers, body: form };
}

describe('Import foundation', () => {
  let db: TestD1Database;
  let bucket: TestR2Bucket;
  let env: ReturnType<typeof testEnv>;
  let admin: SeededEmployee;
  let superAdmin: SeededEmployee;
  let employee: SeededEmployee;

  beforeEach(async () => {
    db = createTestDb();
    bucket = createTestR2();
    env = testEnv(db, bucket);
    admin = await seedEmployee(db, { amcoId: 'TEST900', roleId: ROLE_ADMIN });
    superAdmin = await seedEmployee(db, { amcoId: 'TEST901', roleId: ROLE_SUPER_ADMIN });
    employee = await seedEmployee(db, { amcoId: 'TEST001', rosterType: 'regular' });

    // The registries are module-level and empty by design; make sure one test
    // registering a stub cannot leak into the next.
    for (const key of Object.keys(VALIDATORS)) delete VALIDATORS[key as ImportType];
    for (const key of Object.keys(COMMITTERS)) delete COMMITTERS[key as ImportType];
  });

  const upload = (cookie: string | null, opts = {}) =>
    app.request(IMPORTS, uploadRequest(cookie, opts), env);

  const uploadOk = async () => {
    const res = await upload(admin.cookie);
    expect(res.status).toBe(201);
    return (await readJson(res)).data as { id: number; status: string };
  };

  const validate = (id: number, cookie = admin.cookie) =>
    app.request(`${IMPORTS}/${id}/validate`, { method: 'POST', headers: { Cookie: cookie } }, env);

  const commit = (id: number, cookie = admin.cookie) =>
    app.request(`${IMPORTS}/${id}/commit`, { method: 'POST', headers: { Cookie: cookie } }, env);

  const get = (id: number, cookie = admin.cookie) =>
    app.request(`${IMPORTS}/${id}`, { headers: { Cookie: cookie } }, env);

  // ==========================================================================
  // AUTHORIZATION
  // ==========================================================================

  describe('authorization', () => {
    it('unauthenticated cannot create an import', async () => {
      expect((await upload(null)).status).toBe(401);
    });

    it('a non-admin cannot create an import', async () => {
      expect((await upload(employee.cookie)).status).toBe(403);
    });

    it('unauthenticated cannot validate, view, list or commit', async () => {
      const batch = await uploadOk();
      for (const res of [
        await app.request(`${IMPORTS}/${batch.id}/validate`, { method: 'POST' }, env),
        await app.request(`${IMPORTS}/${batch.id}/commit`, { method: 'POST' }, env),
        await app.request(`${IMPORTS}/${batch.id}`, {}, env),
        await app.request(IMPORTS, {}, env),
      ]) {
        expect(res.status).toBe(401);
      }
    });

    it('a non-admin cannot validate, view, list or commit', async () => {
      const batch = await uploadOk();
      expect((await validate(batch.id, employee.cookie)).status).toBe(403);
      expect((await commit(batch.id, employee.cookie)).status).toBe(403);
      expect((await get(batch.id, employee.cookie)).status).toBe(403);
      expect(
        (await app.request(IMPORTS, { headers: { Cookie: employee.cookie } }, env)).status
      ).toBe(403);
    });

    it('a refused request mutates nothing', async () => {
      await upload(employee.cookie);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM import_batches')).toBe(0);
      expect(bucket.objects.size).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM audit_log')).toBe(0);
    });

    it('a non-admin cannot change the state of an existing import', async () => {
      const batch = await uploadOk();
      await validate(batch.id, employee.cookie);
      await commit(batch.id, employee.cookie);

      const row = await db
        .prepare('SELECT status FROM import_batches WHERE id = ?')
        .bind(batch.id)
        .first<{ status: string }>();
      expect(row!.status).toBe('pending');
    });

    it('both admin and super_admin are accepted', async () => {
      for (const actor of [admin, superAdmin]) {
        const res = await upload(actor.cookie);
        expect(res.status).toBe(201);
      }
    });
  });

  // ==========================================================================
  // UPLOAD
  // ==========================================================================

  describe('upload', () => {
    it('accepts a valid workbook and creates a pending batch', async () => {
      const res = await upload(admin.cookie);
      expect(res.status).toBe(201);

      const body = await readJson(res);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('pending');
      expect(body.data.import_type).toBe('employees');
      expect(body.data.original_filename).toBe('staff-list.xlsx');
      expect(body.data.uploaded_by).toBe(admin.id);
      expect(body.data.file_archived).toBe(true);
      // States plainly that no parser exists yet.
      expect(body.data.importer_available).toBe(false);
    });

    it('stores the object under a deterministic key derived from the batch id', async () => {
      const batch = await uploadOk();

      const expectedKey = `imports/employees/${batch.id}/source.xlsx`;
      expect(bucket.objects.has(expectedKey)).toBe(true);

      const stored = bucket.objects.get(expectedKey)!;
      expect(stored.customMetadata?.import_batch_id).toBe(String(batch.id));
      expect(stored.customMetadata?.original_filename).toBe('staff-list.xlsx');
    });

    it('the uploaded filename never steers the storage key', async () => {
      const res = await upload(admin.cookie, { filename: '../../etc/passwd.xlsx' });
      expect(res.status).toBe(201);
      const batch = (await readJson(res)).data as { id: number };

      const keys = [...bucket.objects.keys()];
      expect(keys).toEqual([`imports/employees/${batch.id}/source.xlsx`]);
      expect(keys[0]).not.toContain('..');
      expect(keys[0]).not.toContain('passwd');
    });

    it('archives the exact bytes uploaded', async () => {
      const bytes = fakeXlsxBytes(128);
      const res = await upload(admin.cookie, { bytes });
      const batch = (await readJson(res)).data as { id: number };

      const stored = bucket.objects.get(`imports/employees/${batch.id}/source.xlsx`)!;
      expect(new Uint8Array(stored.body)).toEqual(bytes);
    });

    it('records size and a SHA-256 content hash', async () => {
      const bytes = fakeXlsxBytes(200);
      const res = await upload(admin.cookie, { bytes });
      const batch = (await readJson(res)).data as { id: number };

      const row = await db
        .prepare('SELECT file_size_bytes, content_sha256 FROM import_batches WHERE id = ?')
        .bind(batch.id)
        .first<{ file_size_bytes: number; content_sha256: string }>();

      expect(row!.file_size_bytes).toBe(bytes.length);
      expect(row!.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('allows a duplicate file as a new import attempt', async () => {
      const bytes = fakeXlsxBytes(96);
      const first = (await readJson(await upload(admin.cookie, { bytes }))).data as { id: number };
      const second = (await readJson(await upload(admin.cookie, { bytes }))).data as { id: number };

      expect(second.id).not.toBe(first.id);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM import_batches')).toBe(2);
    });

    it('rejects an unsupported extension', async () => {
      const res = await upload(admin.cookie, { filename: 'staff.csv' });
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toContain('Unsupported file type');
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM import_batches')).toBe(0);
    });

    it('rejects a renamed non-workbook on its CONTENT, not its name', async () => {
      const res = await upload(admin.cookie, { filename: 'evil.xlsx', bytes: notAZipFile() });
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toContain('not a valid Excel workbook');
      expect(bucket.objects.size).toBe(0);
    });

    it('rejects a legacy .xls with a useful message', async () => {
      const res = await upload(admin.cookie, { filename: 'old.xlsx', bytes: legacyXlsBytes() });
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toContain('legacy');
    });

    it('rejects an empty file', async () => {
      const res = await upload(admin.cookie, { bytes: new Uint8Array(0) });
      expect(res.status).toBe(400);
    });

    it('rejects an oversized file', async () => {
      const oversized = new Uint8Array(11 * 1024 * 1024);
      oversized.set([0x50, 0x4b, 0x03, 0x04], 0);
      const res = await upload(admin.cookie, { bytes: oversized });
      expect(res.status).toBe(413);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM import_batches')).toBe(0);
    });

    it('rejects an invalid import type', async () => {
      const res = await upload(admin.cookie, { importType: 'payroll' });
      expect(res.status).toBe(400);
      expect((await readJson(res)).error).toContain('import_type must be one of');
    });

    it('rejects a missing file', async () => {
      const form = new FormData();
      form.set('import_type', 'employees');
      const res = await app.request(
        IMPORTS,
        { method: 'POST', headers: { Cookie: admin.cookie }, body: form },
        env
      );
      expect(res.status).toBe(400);
    });

    it('accepts every declared import type', async () => {
      for (const importType of ['employees', 'roster', 'menu']) {
        const res = await upload(admin.cookie, { importType });
        expect(res.status).toBe(201);
        expect((await readJson(res)).data.import_type).toBe(importType);
      }
    });
  });

  // ==========================================================================
  // FAILURE HANDLING
  // ==========================================================================

  describe('failure handling', () => {
    it('an R2 failure does not leave a falsely usable import', async () => {
      bucket.failNextPut();

      const res = await upload(admin.cookie);
      expect(res.status).toBe(502);

      // The batch survives as evidence, but is marked failed with no object key
      // and cannot be mistaken for something ready to commit.
      const row = await db
        .prepare('SELECT status, r2_object_key, failure_reason FROM import_batches')
        .first<{ status: string; r2_object_key: string | null; failure_reason: string }>();

      expect(row!.status).toBe('validation_failed');
      expect(row!.r2_object_key).toBeNull();
      expect(row!.failure_reason).toContain('could not be archived');
      expect(bucket.objects.size).toBe(0);
    });

    it('refuses the upload when no storage binding is configured', async () => {
      const envWithoutR2 = testEnv(db); // no bucket supplied
      const res = await app.request(IMPORTS, uploadRequest(admin.cookie), envWithoutR2);

      expect(res.status).toBe(503);
      // No half-created batch when storage is simply absent.
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM import_batches')).toBe(0);
    });

    it('validation failure preserves the batch and the archived file', async () => {
      const batch = await uploadOk();
      await validate(batch.id);

      const row = await db
        .prepare('SELECT status, r2_object_key FROM import_batches WHERE id = ?')
        .bind(batch.id)
        .first<{ status: string; r2_object_key: string }>();

      expect(row!.status).toBe('validation_failed');
      expect(row!.r2_object_key).not.toBeNull();
      expect(bucket.objects.has(row!.r2_object_key)).toBe(true);
    });

    it('a missing archived object is reported, not silently treated as valid', async () => {
      VALIDATORS.employees = async () => ({ rows: [], fileMessages: [], passed: true });

      const batch = await uploadOk();
      bucket.failNextGet();

      const res = await validate(batch.id);
      const body = await readJson(res);

      expect(body.data.outcome).toBe('failed');
      expect(body.data.status).toBe('validation_failed');
    });

    it('a committer that throws leaves the batch commit_failed, never committed', async () => {
      VALIDATORS.employees = async () => ({
        rows: [{ rowNumber: 1, status: 'valid' as const }],
        fileMessages: [],
        passed: true,
      });
      COMMITTERS.employees = async () => {
        throw new Error('simulated production write failure');
      };

      const batch = await uploadOk();
      await validate(batch.id);

      const res = await commit(batch.id);
      expect(res.status).toBe(500);

      const row = await db
        .prepare('SELECT status, committed_at FROM import_batches WHERE id = ?')
        .bind(batch.id)
        .first<{ status: string; committed_at: string | null }>();

      expect(row!.status).toBe('commit_failed');
      expect(row!.committed_at).toBeNull();
    });
  });

  // ==========================================================================
  // STATE MACHINE
  // ==========================================================================

  describe('state machine', () => {
    it('a new upload starts as pending', async () => {
      const batch = await uploadOk();
      expect(batch.status).toBe('pending');
    });

    it('an unimplemented import type does NOT pretend validation succeeded', async () => {
      const batch = await uploadOk();
      const res = await validate(batch.id);

      expect(res.status).toBe(200);
      const body = await readJson(res);
      expect(body.data.outcome).toBe('not_implemented');
      expect(body.data.status).toBe('validation_failed');
      expect(body.data.importer_available).toBe(false);
      expect(body.data.messages[0]).toContain('No importer is available');
    });

    it('commit is refused before validation', async () => {
      const batch = await uploadOk();
      const res = await commit(batch.id);

      expect(res.status).toBe(409);
      expect((await readJson(res)).error).toContain('must pass validation');
    });

    it('commit is refused for an import type with no committer', async () => {
      VALIDATORS.employees = async () => ({
        rows: [{ rowNumber: 1, status: 'valid' as const }],
        fileMessages: [],
        passed: true,
      });

      const batch = await uploadOk();
      await validate(batch.id);

      const res = await commit(batch.id);
      expect(res.status).toBe(501);
      expect((await readJson(res)).error).toContain('No importer is available');

      // Still committable later, once a real committer exists.
      const row = await db
        .prepare('SELECT status FROM import_batches WHERE id = ?')
        .bind(batch.id)
        .first<{ status: string }>();
      expect(row!.status).toBe('preview');
    });

    it('validation moves a valid file to preview', async () => {
      VALIDATORS.employees = async () => ({
        rows: [
          { rowNumber: 1, status: 'valid' as const, preview: { field: 'A' } },
          { rowNumber: 2, status: 'warning' as const, messages: ['Check this row'] },
        ],
        fileMessages: ['2 rows read'],
        passed: true,
      });

      const batch = await uploadOk();
      const body = await readJson(await validate(batch.id));

      expect(body.data.outcome).toBe('ready');
      expect(body.data.status).toBe('preview');
      expect(body.data.total_rows).toBe(2);
      expect(body.data.valid_rows).toBe(1);
      expect(body.data.warning_rows).toBe(1);
      expect(body.data.invalid_rows).toBe(0);
    });

    it('an invalid row blocks preview', async () => {
      VALIDATORS.employees = async () => ({
        rows: [
          { rowNumber: 1, status: 'valid' as const },
          { rowNumber: 2, status: 'invalid' as const, messages: ['Unknown AMCO ID'] },
        ],
        fileMessages: [],
        passed: true,
      });

      const batch = await uploadOk();
      const body = await readJson(await validate(batch.id));

      expect(body.data.outcome).toBe('failed');
      expect(body.data.status).toBe('validation_failed');
      expect(body.data.invalid_rows).toBe(1);

      expect((await commit(batch.id)).status).toBe(409);
    });

    it('re-validation replaces the previous staged rows rather than appending', async () => {
      VALIDATORS.employees = async () => ({
        rows: [
          { rowNumber: 1, status: 'valid' as const },
          { rowNumber: 2, status: 'valid' as const },
        ],
        fileMessages: [],
        passed: true,
      });

      const batch = await uploadOk();
      await validate(batch.id);
      await validate(batch.id);

      expect(
        await countRows(db, 'SELECT COUNT(*) as n FROM import_batch_rows WHERE import_batch_id = ?', batch.id)
      ).toBe(2);
    });

    it('a successful commit marks the batch committed and records who did it', async () => {
      VALIDATORS.employees = async () => ({
        rows: [{ rowNumber: 1, status: 'valid' as const }],
        fileMessages: [],
        passed: true,
      });
      let applied = 0;
      COMMITTERS.employees = async () => {
        applied += 1;
      };

      const batch = await uploadOk();
      await validate(batch.id);

      const res = await commit(batch.id);
      expect(res.status).toBe(200);
      expect(applied).toBe(1);

      const body = await readJson(res);
      expect(body.data.status).toBe('committed');
      expect(body.data.committed_by).toBe(admin.id);
      expect(body.data.committed_at).not.toBeNull();
    });

    it('returns 404 for an unknown import id on every operation', async () => {
      expect((await get(999999)).status).toBe(404);
      expect((await validate(999999)).status).toBe(404);
      expect((await commit(999999)).status).toBe(404);
    });

    it('rejects a non-numeric import id', async () => {
      const res = await app.request(`${IMPORTS}/not-a-number`, { headers: { Cookie: admin.cookie } }, env);
      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // DOUBLE-COMMIT PROTECTION
  // ==========================================================================

  describe('double-commit protection', () => {
    const registerWorkingImporter = () => {
      VALIDATORS.employees = async () => ({
        rows: [{ rowNumber: 1, status: 'valid' as const }],
        fileMessages: [],
        passed: true,
      });
      let applied = 0;
      COMMITTERS.employees = async () => {
        applied += 1;
      };
      return () => applied;
    };

    it('a second sequential commit is refused and does not re-apply', async () => {
      const timesApplied = registerWorkingImporter();
      const batch = await uploadOk();
      await validate(batch.id);

      expect((await commit(batch.id)).status).toBe(200);

      const second = await commit(batch.id);
      expect(second.status).toBe(409);
      expect((await readJson(second)).error).toContain('already been committed');
      expect(timesApplied()).toBe(1);
    });

    it('CONCURRENT commits apply the import exactly once', async () => {
      const timesApplied = registerWorkingImporter();
      const batch = await uploadOk();
      await validate(batch.id);

      // Fired together, as a double-click or a retried request would.
      const results = await Promise.all([
        commit(batch.id),
        commit(batch.id),
        commit(batch.id),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409]);
      expect(timesApplied()).toBe(1);
    });

    it('a committed import cannot be re-validated back into a committable state', async () => {
      registerWorkingImporter();
      const batch = await uploadOk();
      await validate(batch.id);
      await commit(batch.id);

      const res = await validate(batch.id);
      expect(res.status).toBe(409);

      const row = await db
        .prepare('SELECT status FROM import_batches WHERE id = ?')
        .bind(batch.id)
        .first<{ status: string }>();
      expect(row!.status).toBe('committed');
    });
  });

  // ==========================================================================
  // PREVIEW
  // ==========================================================================

  describe('preview', () => {
    it('returns metadata, counts and staged rows', async () => {
      VALIDATORS.employees = async () => ({
        rows: [
          { rowNumber: 1, status: 'valid' as const, preview: { amco_id: 'TEST100' } },
          { rowNumber: 2, status: 'invalid' as const, messages: ['Missing name'] },
        ],
        fileMessages: [],
        passed: true,
      });

      const batch = await uploadOk();
      await validate(batch.id);

      const body = await readJson(await get(batch.id));
      expect(body.data.total_rows).toBe(2);
      expect(body.data.preview_rows).toHaveLength(2);
      expect(body.data.preview_rows[0].preview).toEqual({ amco_id: 'TEST100' });
      expect(body.data.preview_rows[1].messages).toEqual(['Missing name']);
    });

    it('never exposes the R2 object key or the file itself', async () => {
      const batch = await uploadOk();
      const raw = JSON.stringify(await readJson(await get(batch.id)));

      expect(raw).not.toContain('r2_object_key');
      expect(raw).not.toContain('imports/employees/');
      expect(raw).not.toContain('source.xlsx');
      // But it does say a file is archived.
      expect(raw).toContain('file_archived');
    });
  });

  // ==========================================================================
  // HISTORY
  // ==========================================================================

  describe('history', () => {
    it('lists imports newest first with uploader details', async () => {
      await upload(admin.cookie, { importType: 'employees' });
      await upload(admin.cookie, { importType: 'roster' });

      const body = await readJson(
        await app.request(IMPORTS, { headers: { Cookie: admin.cookie } }, env)
      );

      expect(body.data.total).toBe(2);
      expect(body.data.imports).toHaveLength(2);
      expect(body.data.imports[0].import_type).toBe('roster');
      expect(body.data.imports[0].uploaded_by_amco_id).toBe('TEST900');
    });

    it('does NOT return row-level data in the list', async () => {
      VALIDATORS.employees = async () => ({
        rows: [{ rowNumber: 1, status: 'valid' as const, preview: { secret: 'row-detail' } }],
        fileMessages: [],
        passed: true,
      });

      const batch = await uploadOk();
      await validate(batch.id);

      const raw = JSON.stringify(
        await readJson(await app.request(IMPORTS, { headers: { Cookie: admin.cookie } }, env))
      );

      expect(raw).not.toContain('preview_rows');
      expect(raw).not.toContain('row-detail');
    });

    it('paginates and caps an excessive limit', async () => {
      for (let i = 0; i < 5; i++) await upload(admin.cookie);

      const page = await readJson(
        await app.request(`${IMPORTS}?limit=2&offset=2`, { headers: { Cookie: admin.cookie } }, env)
      );
      expect(page.data.imports).toHaveLength(2);
      expect(page.data.total).toBe(5);
      expect(page.data.offset).toBe(2);

      const capped = await readJson(
        await app.request(`${IMPORTS}?limit=9999`, { headers: { Cookie: admin.cookie } }, env)
      );
      expect(capped.data.limit).toBe(100);
    });

    it('filters by import type', async () => {
      await upload(admin.cookie, { importType: 'employees' });
      await upload(admin.cookie, { importType: 'menu' });

      const body = await readJson(
        await app.request(`${IMPORTS}?import_type=menu`, { headers: { Cookie: admin.cookie } }, env)
      );
      expect(body.data.total).toBe(1);
      expect(body.data.imports[0].import_type).toBe('menu');
    });

    it('rejects an unknown import_type filter', async () => {
      const res = await app.request(
        `${IMPORTS}?import_type=payroll`,
        { headers: { Cookie: admin.cookie } },
        env
      );
      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // AUDIT
  // ==========================================================================

  describe('audit', () => {
    it('the upload is audited with the batch and the content hash', async () => {
      const batch = await uploadOk();

      const audit = await db
        .prepare("SELECT * FROM audit_log WHERE action = 'CREATE_IMPORT'")
        .all<{ actor_id: number; entity_id: number; after_json: string }>();

      expect(audit.results).toHaveLength(1);
      expect(audit.results[0].actor_id).toBe(admin.id);
      expect(audit.results[0].entity_id).toBe(batch.id);

      const after = JSON.parse(audit.results[0].after_json);
      expect(after.importType).toBe('employees');
      expect(after.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('validation and commit attempts are audited', async () => {
      // A validator is needed to reach `preview`; without one, validation fails
      // and commit is refused as an out-of-state transition rather than
      // reaching the commit path at all.
      VALIDATORS.employees = async () => ({
        rows: [{ rowNumber: 1, status: 'valid' as const }],
        fileMessages: [],
        passed: true,
      });

      const batch = await uploadOk();
      await validate(batch.id);

      const res = await commit(batch.id); // reaches commit: refused, no committer
      expect(res.status).toBe(501);

      expect(await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'VALIDATE_IMPORT'")).toBe(1);
      expect(await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action = 'COMMIT_FAILED_IMPORT'")).toBe(1);
    });

    it('a refused out-of-state commit is a no-op and writes no audit row', async () => {
      // A 409 is a rejected transition, not an operationally significant
      // mutation attempt - same reasoning as not auditing a 403.
      const batch = await uploadOk();
      await validate(batch.id); // fails: no validator registered

      expect((await commit(batch.id)).status).toBe(409);
      expect(
        await countRows(db, "SELECT COUNT(*) as n FROM audit_log WHERE action LIKE 'COMMIT%'")
      ).toBe(0);
    });

    it('audit rows never contain file contents', async () => {
      // Distinctive bytes that would be unmistakable if they leaked.
      const bytes = fakeXlsxBytes(64);
      const marker = 'SENSITIVE-WORKBOOK-CONTENT';
      const withMarker = new Uint8Array([...bytes, ...new TextEncoder().encode(marker)]);
      withMarker.set([0x50, 0x4b, 0x03, 0x04], 0);

      const res = await upload(admin.cookie, { bytes: withMarker });
      const batch = (await readJson(res)).data as { id: number };
      await validate(batch.id);

      const audit = await db.prepare('SELECT * FROM audit_log').all<Record<string, unknown>>();
      const raw = JSON.stringify(audit.results);

      expect(raw).not.toContain(marker);
      expect(raw).not.toContain('r2_object_key');
      expect(raw).not.toContain('password');
    });
  });

  // ==========================================================================
  // SECURITY
  // ==========================================================================

  describe('security', () => {
    it('no import response leaks credentials or storage internals', async () => {
      const batch = await uploadOk();
      await validate(batch.id);

      const payloads = [
        JSON.stringify(await readJson(await get(batch.id))),
        JSON.stringify(await readJson(await app.request(IMPORTS, { headers: { Cookie: admin.cookie } }, env))),
      ];

      for (const raw of payloads) {
        expect(raw).not.toContain('password');
        expect(raw).not.toContain('pbkdf2');
        expect(raw).not.toContain('session_token');
        expect(raw).not.toContain('r2_object_key');
        expect(raw).not.toContain('access_key');
      }
    });

    it('the import endpoints write nothing to production tables', async () => {
      const employeesBefore = await countRows(db, 'SELECT COUNT(*) as n FROM employees');

      const batch = await uploadOk();
      await validate(batch.id);
      await commit(batch.id);

      expect(await countRows(db, 'SELECT COUNT(*) as n FROM employees')).toBe(employeesBefore);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM roster_entries')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM menu_days')).toBe(0);
      expect(await countRows(db, 'SELECT COUNT(*) as n FROM lunch_selections')).toBe(0);
    });
  });
});
