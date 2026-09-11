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
  validateImport,
  NOT_IMPLEMENTED_REASON,
} from '../services/imports.service.js';
import { logImportChange } from '../services/audit.service.js';

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
  // the two cannot disagree.
  let fileMessages: string[] = [];
  let implemented = true;
  if (batch.validation_summary) {
    try {
      const summary = JSON.parse(batch.validation_summary) as {
        fileMessages?: string[];
        implemented?: boolean;
      };
      fileMessages = summary.fileMessages ?? [];
      implemented = summary.implemented !== false;
    } catch {
      // A summary we cannot parse is not worth failing the request over; the
      // status and counts on the row are the authoritative result.
      fileMessages = [];
    }
  }

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

  const result = await commitImport(db, id, actorId);

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

export { app as importRoutes };
