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
  importObjectKey,
  isImportType,
  validateUploadedFile,
  IMPORT_TYPES,
  MAX_UPLOAD_BYTES,
} from '../lib/importFile.js';
import {
  attachObjectKey,
  createImportBatch,
  getImportBatch,
  getStagedRows,
  listImportBatches,
  transitionStatus,
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
 * The R2 object key is deliberately NOT included: it is internal storage
 * addressing, and exposing it invites attempts to reach objects directly. The
 * response says whether a file is archived, not where it lives.
 */
function toBatchResponse(batch: Record<string, unknown>) {
  const { r2_object_key, ...rest } = batch as { r2_object_key: string | null } & Record<string, unknown>;
  return { ...rest, file_archived: r2_object_key !== null };
}

/**
 * POST /api/admin/imports - upload a workbook and open an import batch.
 *
 * Creates the batch first, then archives the file under a key derived from the
 * batch id. If the R2 write fails the batch is left in `validation_failed` with
 * a reason and no object key - visible and retryable, never a silently orphaned
 * object or a falsely usable import.
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

  const bucket = c.env.IMPORTS;
  if (!bucket) {
    // Fail loudly rather than creating an import whose file was never stored.
    console.error('R2 IMPORTS binding is not configured');
    return c.json(
      { success: false, error: 'File storage is not configured. Contact your administrator.' },
      503
    );
  }

  const contentSha256 = await hashFileContents(bytes);

  const batch = await createImportBatch(db, {
    importType,
    originalFilename: filename,
    fileSizeBytes: bytes.length,
    contentSha256,
    uploadedBy: actorId,
  });

  const objectKey = importObjectKey(importType, batch.id);

  try {
    await bucket.put(objectKey, buffer, {
      httpMetadata: {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      customMetadata: {
        import_batch_id: String(batch.id),
        import_type: importType,
        // Stored for display; never used to address the object.
        original_filename: filename,
      },
    });
  } catch (error) {
    console.error('R2 put failed for import batch', batch.id, error instanceof Error ? error.name : 'unknown');
    await transitionStatus(db, batch.id, 'pending', 'validation_failed', {
      failureReason: 'The uploaded file could not be archived. Please try uploading again.',
    });
    return c.json(
      { success: false, error: 'The file could not be stored. Please try again.', data: { id: batch.id } },
      502
    );
  }

  await attachObjectKey(db, batch.id, objectKey);

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

  const stored = await getImportBatch(db, batch.id);

  return c.json(
    {
      success: true,
      data: {
        ...toBatchResponse(stored as unknown as Record<string, unknown>),
        // Say plainly that this type cannot yet be validated or committed.
        importer_available: hasValidator(importType),
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
 * POST /api/admin/imports/:id/validate - run validation. Writes no production data.
 */
app.post('/:id/validate', async (c) => {
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

  const bucket = c.env.IMPORTS;

  const result = await validateImport(db, id, async () => {
    if (!bucket || !existing.r2_object_key) return null;
    const object = await bucket.get(existing.r2_object_key);
    return object ? await object.arrayBuffer() : null;
  });

  if (result.kind === 'conflict') {
    return c.json({ success: false, error: result.reason }, 409);
  }

  await logImportChange(
    db,
    actorId,
    id,
    'VALIDATE',
    {
      importType: existing.import_type,
      status: result.batch.status,
      totalRows: result.batch.total_rows,
      invalidRows: result.batch.invalid_rows,
      reason: result.batch.failure_reason ?? undefined,
    },
    clientIp(c)
  );

  if (result.kind === 'not_implemented') {
    // 200: the request was handled correctly. The honest answer is that this
    // import type has no parser yet, which the payload states explicitly.
    return c.json({
      success: true,
      data: {
        ...toBatchResponse(result.batch as unknown as Record<string, unknown>),
        importer_available: false,
        outcome: 'not_implemented',
        messages: [NOT_IMPLEMENTED_REASON],
      },
    });
  }

  return c.json({
    success: true,
    data: {
      ...toBatchResponse(result.batch as unknown as Record<string, unknown>),
      importer_available: true,
      outcome: result.kind,
      messages: result.fileMessages,
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
