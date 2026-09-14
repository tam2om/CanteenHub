/**
 * Admin import routes - Phase 4 Slice 1 foundation.
 *
 * Mounted at /api/admin/imports. Guards are applied to the whole router, so a
 * new endpoint added here inherits them rather than relying on someone to
 * remember. Mirrors the structure of routes/me.ts rather than growing
 * routes/admin.ts further.
 *
 * NOTHING in this file writes to employees, roster, menu or selections. The
 * only production write path is the per-type committer registry, which is
 * empty in this slice.
 */

import { Hono } from 'hono';
import type { Env, Variables } from '../types/env.js';
import { requireAuth, requireRole } from '../middleware/session.js';
import {
  hashFileContents,
  isImportType,
  validateUploadedFile,
  IMPORT_TYPES,
  MAX_UPLOAD_BYTES,
} from '../lib/importFile.js';
import {
  createImportBatch,
  getImportBatch,
  getStagedRows,
  listImportBatches,
  type ImportStatus,
} from '../repositories/imports.repo.js';
import {
  commitImport,
  hasCommitter,
  hasValidator,
  readValidationSummary,
  validateImport,
  NOT_IMPLEMENTED_REASON,
} from '../services/imports.service.js';
import { logImportChange } from '../services/audit.service.js';
import { buildXlsx, XLSX_CONTENT_TYPE, type CellValue } from '../lib/xlsxWrite.js';
import { MEAL_LOCATIONS, MEAL_LOCATION_LABELS } from '../../shared/types/index.js';
import { MIN_PASSWORD_LENGTH } from '../lib/password.js';
import { ROSTER_TEMPLATE_VALUES } from '../imports/employees.js';
import {
  MAX_DAYS_IN_MONTH,
  ROSTER_SHEET_NAME,
  SHIFT_TEMPLATE_VALUES,
} from '../imports/roster.js';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', requireAuth);
app.use('*', requireRole(['admin', 'super_admin']));

const MAX_PREVIEW_ROWS = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

const clientIp = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header('X-Forwarded-For') || null;

/**
 * Shape a batch for an API response.
 *
 * `r2_object_key` is stripped rather than reported. CanteenHub no longer has an
 * object store, so the column is a dormant leftover that is always NULL on new
 * rows; surfacing it - or the old `file_archived: false` derived from it - would
 * tell a client something untrue about where the workbook is. What the file WAS
 * is still fully described by `original_filename`, `file_size_bytes` and
 * `content_sha256`, all of which stay.
 */
function toBatchResponse(batch: Record<string, unknown>) {
  const { r2_object_key: _unusedObjectKey, ...rest } = batch as {
    r2_object_key: string | null;
  } & Record<string, unknown>;
  return rest;
}

/**
 * POST /api/admin/imports - upload a workbook and open an import batch.
 *
 * The workbook is parsed and staged in THIS request, because this request is
 * the only time it exists. CanteenHub runs on Cloudflare's free tier with no
 * object store, so nothing durable holds the uploaded bytes: they are read,
 * validated into `import_batch_rows`, and dropped when the request ends.
 *
 * That costs the workflow nothing, because the workflow never needed them
 * again. Preview reads staged rows; confirm is a UI step; commit replays the
 * staged rows. The file was only ever the input to validation.
 *
 * The five stages are unchanged and still separately addressable - upload,
 * validate, preview, confirm, commit. Validation simply happens where the bytes
 * are, and `POST /:id/validate` returns the outcome that produced.
 */
app.post('/', async (c) => {
  const db = c.env.DB;
  const actorId = c.get('session')!.employee_id;

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ success: false, error: 'Send the file as multipart/form-data.' }, 400);
  }

  const importType = form.get('import_type');
  if (!isImportType(importType)) {
    return c.json(
      { success: false, error: `import_type must be one of: ${IMPORT_TYPES.join(', ')}` },
      400
    );
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return c.json({ success: false, error: 'A file is required.' }, 400);
  }

  const uploaded = file as unknown as { name?: string; size?: number; arrayBuffer(): Promise<ArrayBuffer> };
  const filename = typeof uploaded.name === 'string' ? uploaded.name : '';

  // Refuse an oversized upload before reading it into memory.
  if (typeof uploaded.size === 'number' && uploaded.size > MAX_UPLOAD_BYTES) {
    const limitMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
    return c.json({ success: false, error: `The file is larger than the ${limitMb} MB limit.` }, 413);
  }

  const buffer = await uploaded.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  const check = validateUploadedFile(filename, bytes);
  if (!check.valid) {
    return c.json({ success: false, error: check.error }, 400);
  }

  // The fingerprint of a file we are about to forget. `content_sha256` plus
  // `original_filename` and `file_size_bytes` is what lets an administrator
  // later say "this import came from that workbook" without the bytes.
  const contentSha256 = await hashFileContents(bytes);

  const batch = await createImportBatch(db, {
    importType,
    originalFilename: filename,
    fileSizeBytes: bytes.length,
    contentSha256,
    uploadedBy: actorId,
  });

  await logImportChange(
    db,
    actorId,
    batch.id,
    'CREATE',
    {
      importType,
      originalFilename: filename,
      contentSha256,
      status: 'pending',
    },
    clientIp(c)
  );

  // Validate NOW, from the bytes still in memory. This is the whole of the
  // change that removed the object store: the parse moved to the only request
  // that holds the file, and everything it produces lands in D1.
  const result = await validateImport(db, batch.id, buffer);

  if (result.kind === 'conflict') {
    // Unreachable for a batch created two statements ago, but a conflict here
    // would mean the state machine disagrees with itself - say so rather than
    // returning a batch in an unknown state.
    return c.json({ success: false, error: result.reason }, 409);
  }

  await logImportChange(
    db,
    actorId,
    batch.id,
    'VALIDATE',
    {
      importType,
      status: result.batch.status,
      totalRows: result.batch.total_rows,
      invalidRows: result.batch.invalid_rows,
      reason: result.batch.failure_reason ?? undefined,
    },
    clientIp(c)
  );

  return c.json(
    {
      success: true,
      data: {
        ...toBatchResponse(result.batch as unknown as Record<string, unknown>),
        importer_available: result.kind !== 'not_implemented',
        outcome: result.kind === 'not_implemented' ? 'not_implemented' : result.kind,
        messages: result.kind === 'not_implemented' ? [NOT_IMPLEMENTED_REASON] : result.fileMessages,
      },
    },
    201
  );
});

/**
 * GET /api/admin/imports - paginated history. Metadata only, no staged rows.
 */
app.get('/', async (c) => {
  const db = c.env.DB;

  const typeParam = c.req.query('import_type');
  if (typeParam !== undefined && !isImportType(typeParam)) {
    return c.json(
      { success: false, error: `import_type must be one of: ${IMPORT_TYPES.join(', ')}` },
      400
    );
  }

  const rawLimit = Number.parseInt(c.req.query('limit') || String(DEFAULT_PAGE_SIZE), 10);
  const rawOffset = Number.parseInt(c.req.query('offset') || '0', 10);
  const limit =
    Number.isNaN(rawLimit) || rawLimit < 1 ? DEFAULT_PAGE_SIZE : Math.min(rawLimit, MAX_PAGE_SIZE);
  const offset = Number.isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;

  const { batches, total } = await listImportBatches(db, {
    importType: typeParam,
    status: (c.req.query('status') as ImportStatus | undefined) || undefined,
    limit,
    offset,
  });

  return c.json({
    success: true,
    data: {
      imports: batches.map((b) => toBatchResponse(b as unknown as Record<string, unknown>)),
      total,
      limit,
      offset,
    },
  });
});

/**
 * GET /api/admin/imports/:id - preview state for one batch.
 *
 * Returns metadata, counts and staged rows. Never returns the workbook itself
 * and never returns the storage key.
 */
app.get('/:id', async (c) => {
  const db = c.env.DB;
  const id = Number.parseInt(c.req.param('id')!, 10);

  if (Number.isNaN(id)) {
    return c.json({ success: false, error: 'Invalid import id' }, 400);
  }

  const batch = await getImportBatch(db, id);
  if (!batch) {
    return c.json({ success: false, error: 'Import not found' }, 404);
  }

  const rows = await getStagedRows(db, id, MAX_PREVIEW_ROWS);

  return c.json({
    success: true,
    data: {
      ...toBatchResponse(batch as unknown as Record<string, unknown>),
      importer_available: hasValidator(batch.import_type),
      committer_available: hasCommitter(batch.import_type),
      preview_rows: rows.map((row) => ({
        row_number: row.row_number,
        status: row.status,
        messages: row.messages ? (JSON.parse(row.messages) as string[]) : [],
        preview: row.preview_json ? JSON.parse(row.preview_json) : null,
      })),
      preview_row_limit: MAX_PREVIEW_ROWS,
      sheet: readValidationSummary(batch.validation_summary).sheet ?? null,
      // Whole-batch tallies. The preview_rows array above is capped, so a
      // client must never count it to describe the file.
      action_counts: readValidationSummary(batch.validation_summary).actionCounts ?? null,
    },
  });
});

/**
 * POST /api/admin/imports/:id/validate - report this batch's validation outcome.
 *
 * Validation itself runs during the upload, because that is the only request
 * that holds the workbook. This endpoint reports what it produced, which keeps
 * the five stages separately addressable and keeps the client's upload ->
 * validate -> preview sequence working unchanged.
 *
 * It is deliberately a READ. It writes nothing and logs nothing: the state
 * change and its audit entry already happened at upload, and a second VALIDATE
 * audit row for a request that changed nothing would be a lie in the record.
 * Calling it repeatedly is therefore safe and always returns the same answer.
 *
 * A batch still `pending` has no outcome to report - that can only happen if
 * validation never ran - and the honest remedy is to upload the workbook again,
 * because nothing kept the bytes.
 */
app.post('/:id/validate', async (c) => {
  const db = c.env.DB;
  const id = Number.parseInt(c.req.param('id')!, 10);

  if (Number.isNaN(id)) {
    return c.json({ success: false, error: 'Invalid import id' }, 400);
  }

  const batch = await getImportBatch(db, id);
  if (!batch) {
    return c.json({ success: false, error: 'Import not found' }, 404);
  }

  if (batch.status === 'committed' || batch.status === 'committing') {
    return c.json({ success: false, error: 'This import has already been committed.' }, 409);
  }

  if (batch.status === 'pending' || batch.status === 'validating') {
    return c.json(
      {
        success: false,
        error:
          'This import has no validation result. Upload the workbook again - the file is not stored after the upload that carried it.',
      },
      409
    );
  }

  // `validation_summary` is written by the same call that set the status, so
  // the two cannot disagree. A summary we cannot parse is not worth failing the
  // request over; the status and counts on the row are the authoritative result.
  const summary = readValidationSummary(batch.validation_summary);
  const fileMessages = summary.fileMessages ?? [];
  const implemented = summary.implemented !== false;

  const outcome = !implemented
    ? 'not_implemented'
    : batch.status === 'preview'
      ? 'ready'
      : 'failed';

  return c.json({
    success: true,
    data: {
      ...toBatchResponse(batch as unknown as Record<string, unknown>),
      importer_available: implemented,
      outcome,
      messages: fileMessages,
      // Which worksheet produced this preview, and whether the administrator
      // has to confirm it. Absent for imports that do not choose a worksheet.
      sheet: summary.sheet ?? null,
      action_counts: summary.actionCounts ?? null,
    },
  });
});

/**
 * POST /api/admin/imports/:id/commit - the explicit commit boundary.
 *
 * The only endpoint in this router that could ever write production data, and
 * in this slice it cannot, because no committer is registered.
 */
app.post('/:id/commit', async (c) => {
  const db = c.env.DB;
  const actorId = c.get('session')!.employee_id;
  const id = Number.parseInt(c.req.param('id')!, 10);

  if (Number.isNaN(id)) {
    return c.json({ success: false, error: 'Invalid import id' }, 400);
  }

  const existing = await getImportBatch(db, id);
  if (!existing) {
    return c.json({ success: false, error: 'Import not found' }, 404);
  }

  // An optional, additive body field. Required only when validation identified
  // the worksheet by content; every existing client that posts `{}` is
  // unaffected for every workbook whose lunch sheet is named.
  let confirmSheet: string | undefined;
  try {
    const body = (await c.req.json()) as { confirm_sheet?: unknown };
    if (typeof body?.confirm_sheet === 'string') confirmSheet = body.confirm_sheet;
  } catch {
    // No body, or not JSON. Treated as "nothing confirmed", which is refused
    // below only when a confirmation is actually required.
  }

  const result = await commitImport(db, id, actorId, { confirmSheet });

  if (result.kind === 'confirmation_required') {
    // Not an audit event: nothing was attempted and nothing changed. The batch
    // is still in `preview`, so confirming and retrying is all that is needed.
    return c.json(
      {
        success: false,
        error: result.reason,
        outcome: 'confirmation_required',
        sheet: result.sheet,
      },
      409
    );
  }

  if (result.kind === 'not_implemented') {
    await logImportChange(
      db, actorId, id, 'COMMIT_FAILED',
      { importType: existing.import_type, reason: 'importer not implemented' },
      clientIp(c)
    );
    return c.json({ success: false, error: result.reason, outcome: 'not_implemented' }, 501);
  }

  if (result.kind === 'conflict') {
    return c.json({ success: false, error: result.reason }, 409);
  }

  if (result.kind === 'failed') {
    await logImportChange(
      db, actorId, id, 'COMMIT_FAILED',
      { importType: existing.import_type, reason: result.reason },
      clientIp(c)
    );
    return c.json({ success: false, error: result.reason }, 500);
  }

  await logImportChange(
    db,
    actorId,
    id,
    'COMMIT',
    {
      importType: existing.import_type,
      status: 'committed',
      totalRows: result.batch.total_rows,
    },
    clientIp(c)
  );

  return c.json({
    success: true,
    data: toBatchResponse(result.batch as unknown as Record<string, unknown>),
  });
});

/**
 * GET /api/admin/imports/templates/employees.xlsx - the blank workbook to fill in.
 *
 * WHY THIS EXISTS: every import failure so far has been a FORMAT mismatch, not
 * bad data - a sheet named "Page 1", a header the importer did not recognise, a
 * roster value spelled differently. Handing out the exact shape the importer
 * accepts removes the guesswork rather than documenting it.
 *
 * Generated from the SAME constants the importer validates against, so the
 * template cannot drift away from what the parser will accept. A test asserts
 * the generated file imports cleanly.
 */
app.get('/templates/employees.xlsx', () => {
  // NO Location column. Where a meal is collected is chosen by the employee
  // when they pick option 1 or 2, per day - it is not an attribute of the
  // person, so asking for it here would only invite a value that the daily
  // choice then overrides.
  const headers = ['ID', 'Name', 'Department', 'Section', 'Roster', 'Password'];

  // Example rows, clearly marked. They are deleted by whoever fills the file
  // in - and if they are left behind, they are ordinary rows that import as
  // ordinary employees, not something that can corrupt anything.
  const rows: CellValue[][] = [
    headers,
    ['EXAMPLE001', 'Example Person One', 'Mining', 'Operations', 'Regular', ''],
    ['EXAMPLE002', 'Example Person Two', 'Processing', 'Shifts', 'Shift', ''],
    ['EXAMPLE003', 'Example Person Three', 'Head Office', 'Finance', 'Amman HQ', ''],
  ];

  const notes: CellValue[][] = [
    ['Column', 'Required', 'Accepted values', 'Notes'],
    ['ID', 'Yes', 'Letters, digits, . _ -', 'The employee identifier. Matched ignoring case.'],
    ['Name', 'Yes', 'Any text', 'Stored exactly as typed.'],
    ['Department', 'No', 'Any text', 'Leading and trailing spaces are trimmed.'],
    ['Section', 'No', 'Any text', 'Leading and trailing spaces are trimmed.'],
    [
      'Roster',
      'Yes',
      `${ROSTER_TEMPLATE_VALUES.join(' / ')}`,
      'Decides who is entitled to a meal on a given day. Anything else is rejected.',
    ],
    [
      'Password',
      'No',
      `At least ${MIN_PASSWORD_LENGTH} characters`,
      'Optional. Blank leaves an existing password alone. Applied in a separate step after the import is committed.',
    ],
    [],
    ['How to use this file'],
    ['1. Delete the three EXAMPLE rows.'],
    ['2. Add one row per employee. Keep the header row exactly as it is.'],
    ['3. Keep the sheet named "All Employees".'],
    ['4. Save as .xlsx and upload it on the employee import screen.'],
    ['5. Check the preview before committing - nothing is written until you confirm.'],
    [],
    ['Re-importing the same file is safe: rows that have not changed are left alone.'],
    [
      `Where a meal is collected (${MEAL_LOCATIONS.map((l) => MEAL_LOCATION_LABELS[l]).join(', ')})`,
      'is chosen by the employee when they pick their meal, not set here.',
    ],
    ['This file is a template. It contains no real employee data.'],
  ];

  const bytes = buildXlsx([
    // The sheet name the importer looks for, so the file works unmodified.
    { name: 'All Employees', rows, columnWidths: [14, 26, 20, 20, 12, 16] },
    { name: 'Instructions', rows: notes, columnWidths: [14, 10, 40, 60] },
  ]);

  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': 'attachment; filename="canteenhub-employee-import-template.xlsx"',
      'Cache-Control': 'no-store',
    },
  });
});

/**
 * GET /api/admin/imports/templates/roster.xlsx - the blank roster workbook.
 *
 * Same reasoning as the employee template: the roster sheet is WIDE and its
 * shape is easy to get wrong - one row per employee-month, a column per day of
 * the month, and only three accepted words in the day cells. Handing out the
 * shape removes the guesswork.
 *
 * Generated from the importer's own constants: the sheet name, the accepted
 * shift words and the day-column count all come from `imports/roster.ts`, so
 * the template cannot drift from what the parser accepts.
 */
app.get('/templates/roster.xlsx', () => {
  const dayColumns = Array.from({ length: MAX_DAYS_IN_MONTH }, (_, i) => String(i + 1));
  const headers: CellValue[] = ['ID', 'Month', 'Year', ...dayColumns];

  /** A plausible month of shifts, so the pattern is visible rather than described. */
  const cycle = (offset: number): CellValue[] =>
    Array.from({ length: MAX_DAYS_IN_MONTH }, (_, i) => {
      const day = (i + offset) % 8;
      if (day < 3) return 'Day';
      if (day < 6) return 'Night';
      return 'Off';
    });

  const rows: CellValue[][] = [
    headers,
    ['EXAMPLE001', 'January', 2027, ...cycle(0)],
    ['EXAMPLE002', 'January', 2027, ...cycle(3)],
    ['EXAMPLE003', 'January', 2027, ...cycle(6)],
  ];

  const notes: CellValue[][] = [
    ['Column', 'Required', 'Accepted values', 'Notes'],
    [
      'ID',
      'Yes',
      'An ID that already exists',
      'The roster NEVER creates an employee. Import the employee first; an unknown ID is rejected.',
    ],
    ['Month', 'Yes', '1-12, or a month name such as January', 'The month these day columns belong to.'],
    ['Year', 'Yes', '2000-2100', 'Four digits.'],
    [
      '1 - 31',
      'No',
      SHIFT_TEMPLATE_VALUES.join(' / '),
      'One column per day of the month. A BLANK cell means the workbook says nothing about that date - which is NOT the same as Off.',
    ],
    [],
    ['How to use this file'],
    ['1. Delete the three EXAMPLE rows.'],
    ['2. Add one row per employee per month. Keep the header row exactly as it is.'],
    [`3. Keep the sheet named "${ROSTER_SHEET_NAME}".`],
    ['4. Leave day columns beyond the end of the month empty (for example 30 and 31 in February).'],
    ['5. Save as .xlsx and upload it on the roster import screen.'],
    ['6. Check the preview before committing - nothing is written until you confirm.'],
    [],
    ['Only Day, Night and Off are accepted. Single letters such as D or N are rejected on purpose,'],
    ['because a stray letter would otherwise become a real shift silently.'],
    ['Re-importing the same file is safe: days that have not changed are left alone.'],
    ['This file is a template. It contains no real employee data.'],
  ];

  const bytes = buildXlsx([
    { name: ROSTER_SHEET_NAME, rows, columnWidths: [14, 12, 8] },
    { name: 'Instructions', rows: notes, columnWidths: [12, 10, 38, 66] },
  ]);

  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': 'attachment; filename="canteenhub-roster-import-template.xlsx"',
      'Cache-Control': 'no-store',
    },
  });
});

export { app as importRoutes };
