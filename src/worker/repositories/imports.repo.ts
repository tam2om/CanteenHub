/**
 * Repository Layer - Import batches and staged rows.
 *
 * The single data-access module for imports. State transitions are expressed as
 * conditional UPDATEs that assert the expected current status, so an illegal or
 * concurrent transition simply affects zero rows rather than corrupting state.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { ImportType } from '../lib/importFile.js';

export type ImportStatus =
  | 'pending'
  | 'validating'
  | 'validation_failed'
  | 'preview'
  | 'committing'
  | 'committed'
  | 'commit_failed'
  | 'cancelled';

export type ImportRowStatus = 'valid' | 'warning' | 'invalid';

export interface ImportBatch {
  id: number;
  import_type: ImportType;
  status: ImportStatus;
  original_filename: string;
  file_size_bytes: number | null;
  content_sha256: string | null;
  r2_object_key: string | null;
  uploaded_by: number;
  committed_by: number | null;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  warning_rows: number;
  failure_reason: string | null;
  validation_summary: string | null;
  created_at: string;
  validated_at: string | null;
  committed_at: string | null;
}

export interface ImportBatchRow {
  id: number;
  import_batch_id: number;
  row_number: number;
  status: ImportRowStatus;
  messages: string | null;
  preview_json: string | null;
  created_at: string;
}

export interface StagedRowInput {
  rowNumber: number;
  status: ImportRowStatus;
  messages?: string[];
  preview?: unknown;
}

/**
 * Create the batch row BEFORE the file is stored.
 *
 * Order matters: the batch id is what the deterministic object key is derived
 * from, and a batch with no object yet is a recoverable state that an
 * administrator can see and retry. The reverse order would leave an orphaned R2
 * object that nothing in the database points at.
 */
export async function createImportBatch(
  db: D1Database,
  input: {
    importType: ImportType;
    originalFilename: string;
    fileSizeBytes: number;
    contentSha256: string;
    uploadedBy: number;
  }
): Promise<ImportBatch> {
  const result = await db
    .prepare(
      `INSERT INTO import_batches
         (import_type, status, original_filename, file_size_bytes, content_sha256, uploaded_by)
       VALUES (?, 'pending', ?, ?, ?, ?)`
    )
    .bind(
      input.importType,
      input.originalFilename,
      input.fileSizeBytes,
      input.contentSha256,
      input.uploadedBy
    )
    .run();

  const batch = await getImportBatch(db, result.meta.last_row_id as number);
  if (!batch) {
    throw new Error('Failed to retrieve the created import batch');
  }
  return batch;
}

export async function getImportBatch(db: D1Database, id: number): Promise<ImportBatch | null> {
  const result = await db
    .prepare('SELECT * FROM import_batches WHERE id = ?')
    .bind(id)
    .first<ImportBatch>();

  return result || null;
}

/** Record the archived object's key once the upload to R2 has actually succeeded. */
export async function attachObjectKey(
  db: D1Database,
  id: number,
  objectKey: string
): Promise<void> {
  await db
    .prepare('UPDATE import_batches SET r2_object_key = ? WHERE id = ?')
    .bind(objectKey, id)
    .run();
}

/**
 * Move a batch from one status to another, ASSERTING the current status.
 *
 * Returns false when the row was not in `from` - which is exactly how a
 * double-commit, a stale retry or an out-of-order transition is refused. This
 * is a compare-and-swap: the check and the write are one statement, so two
 * concurrent requests cannot both observe `preview` and both proceed.
 */
export async function transitionStatus(
  db: D1Database,
  id: number,
  from: ImportStatus | ImportStatus[],
  to: ImportStatus,
  extra: { failureReason?: string | null; committedBy?: number } = {}
): Promise<boolean> {
  const fromStates = Array.isArray(from) ? from : [from];
  const placeholders = fromStates.map(() => '?').join(', ');

  const sets = ['status = ?'];
  const binds: Array<string | number | null> = [to];

  if (extra.failureReason !== undefined) {
    sets.push('failure_reason = ?');
    binds.push(extra.failureReason);
  }
  if (to === 'committed') {
    sets.push("committed_at = datetime('now')");
    if (extra.committedBy !== undefined) {
      sets.push('committed_by = ?');
      binds.push(extra.committedBy);
    }
  }
  if (to === 'preview' || to === 'validation_failed') {
    sets.push("validated_at = datetime('now')");
  }

  const result = await db
    .prepare(
      `UPDATE import_batches SET ${sets.join(', ')}
       WHERE id = ? AND status IN (${placeholders})`
    )
    .bind(...binds, id, ...fromStates)
    .run();

  return ((result.meta?.changes as number | undefined) ?? 0) > 0;
}

/** Persist validation results: counts on the batch, plus the staged rows. */
export async function saveValidationResults(
  db: D1Database,
  id: number,
  rows: StagedRowInput[],
  summary: unknown
): Promise<void> {
  const counts = rows.reduce(
    (acc, row) => {
      if (row.status === 'valid') acc.valid += 1;
      else if (row.status === 'warning') acc.warning += 1;
      else acc.invalid += 1;
      return acc;
    },
    { valid: 0, warning: 0, invalid: 0 }
  );

  const statements = [
    db
      .prepare(
        `UPDATE import_batches
         SET total_rows = ?, valid_rows = ?, invalid_rows = ?, warning_rows = ?,
             validation_summary = ?
         WHERE id = ?`
      )
      .bind(rows.length, counts.valid, counts.invalid, counts.warning, JSON.stringify(summary), id),
  ];

  // Re-validating replaces the previous staging rows rather than appending, so
  // a preview never mixes results from two different runs.
  statements.push(db.prepare('DELETE FROM import_batch_rows WHERE import_batch_id = ?').bind(id));

  // Multi-row INSERTs rather than one statement per row: D1 allows only 50
  // queries per invocation on the free plan, so a 500-row workbook must not
  // become 500 statements.
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const binds: Array<string | number | null> = [];

    for (const row of chunk) {
      binds.push(
        id,
        row.rowNumber,
        row.status,
        row.messages && row.messages.length > 0 ? JSON.stringify(row.messages) : null,
        row.preview === undefined ? null : JSON.stringify(row.preview)
      );
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO import_batch_rows
             (import_batch_id, row_number, status, messages, preview_json)
           VALUES ${values}`
        )
        .bind(...binds)
    );
  }

  // One atomic batch: either the counts and every staged row land, or none do.
  await db.batch(statements);
}

/** Staged rows for the preview, ordered as the administrator sees them. */
export async function getStagedRows(
  db: D1Database,
  id: number,
  limit: number
): Promise<ImportBatchRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM import_batch_rows
       WHERE import_batch_id = ?
       ORDER BY row_number ASC
       LIMIT ?`
    )
    .bind(id, limit)
    .all<ImportBatchRow>();

  return result.results || [];
}

export interface ImportBatchListItem extends ImportBatch {
  uploaded_by_name: string | null;
  uploaded_by_amco_id: string | null;
}

/**
 * Paginated import history.
 *
 * Deliberately returns batch metadata only - never staged rows. The list screen
 * should not drag every row of every past import across the wire.
 */
export async function listImportBatches(
  db: D1Database,
  options: { importType?: ImportType; status?: ImportStatus; limit: number; offset: number }
): Promise<{ batches: ImportBatchListItem[]; total: number }> {
  const where: string[] = [];
  const binds: Array<string | number> = [];

  if (options.importType) {
    where.push('b.import_type = ?');
    binds.push(options.importType);
  }
  if (options.status) {
    where.push('b.status = ?');
    binds.push(options.status);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const countRow = await db
    .prepare(`SELECT COUNT(*) as total FROM import_batches b ${whereClause}`)
    .bind(...binds)
    .first<{ total: number }>();

  const result = await db
    .prepare(
      `SELECT b.*, e.full_name AS uploaded_by_name, e.amco_id AS uploaded_by_amco_id
       FROM import_batches b
       LEFT JOIN employees e ON e.id = b.uploaded_by
       ${whereClause}
       ORDER BY b.created_at DESC, b.id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(...binds, options.limit, options.offset)
    .all<ImportBatchListItem>();

  return { batches: result.results || [], total: Number(countRow?.total ?? 0) };
}
