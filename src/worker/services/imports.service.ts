/**
 * Import Service - the reusable upload → validate → preview → commit lifecycle.
 *
 * This slice builds the FOUNDATION only. No employee, roster or menu parser
 * exists yet, and this module deliberately does not pretend otherwise: an import
 * type with no registered validator reports `not_implemented` and can never
 * reach a committed state.
 *
 * The invariant the whole design serves: uploading, validating and previewing
 * never touch production data. Only an explicit, authenticated administrator
 * commit may write, and only through a committer that actually exists.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type { ImportType } from '../lib/importFile.js';
import {
  commitEmployeeWorkbook,
  validateEmployeeWorkbook,
} from '../imports/employees.js';
import {
  getImportBatch,
  saveValidationResults,
  transitionStatus,
  type ImportBatch,
  type StagedRowInput,
} from '../repositories/imports.repo.js';

export interface ValidationOutcome {
  /** Rows staged for the preview. Empty when the type has no validator yet. */
  rows: StagedRowInput[];
  /** File-level messages, shown above the row list. */
  fileMessages: string[];
  /** False when the file cannot proceed to preview. */
  passed: boolean;
}

/**
 * A per-type validator. Later slices register employees/roster/menu here.
 *
 * Receives the database READ-ONLY by contract: classifying a row as CREATE,
 * UPDATE or UNCHANGED requires comparing the workbook against what is already
 * stored, and the preview is only honest if it reflects real current values.
 * A validator NEVER writes production data - it only inspects and stages.
 */
export type ImportValidator = (
  db: D1Database,
  file: ArrayBuffer
) => Promise<ValidationOutcome>;

/**
 * A per-type committer, applying staged rows to production tables.
 * Later slices register these; today the registry is intentionally empty.
 */
export type ImportCommitter = (db: D1Database, batch: ImportBatch) => Promise<void>;

/**
 * Registries for the per-domain importers.
 *
 * `employees` is registered as of Phase 4 Slice 2. `roster` and `menu` remain
 * unregistered on purpose: an import type with no entry here reports
 * not_implemented and can never reach a committed state, which is what keeps
 * "the foundation cannot fake a business import" structurally true rather than
 * a matter of convention.
 */
export const VALIDATORS: Partial<Record<ImportType, ImportValidator>> = {
  employees: validateEmployeeWorkbook,
};
export const COMMITTERS: Partial<Record<ImportType, ImportCommitter>> = {
  employees: commitEmployeeWorkbook,
};

export function hasValidator(importType: ImportType): boolean {
  return typeof VALIDATORS[importType] === 'function';
}

export function hasCommitter(importType: ImportType): boolean {
  return typeof COMMITTERS[importType] === 'function';
}

export const NOT_IMPLEMENTED_REASON =
  'No importer is available for this import type yet. The file has been archived and can be validated once support is added.';

export type ValidateResult =
  | { kind: 'not_implemented'; batch: ImportBatch }
  | { kind: 'failed'; batch: ImportBatch; fileMessages: string[] }
  | { kind: 'ready'; batch: ImportBatch; fileMessages: string[] }
  | { kind: 'conflict'; reason: string };

/**
 * Run validation for a batch and record the outcome.
 *
 * Claims the batch by moving it to `validating` first, so two concurrent
 * validate calls cannot both run. Every terminal path leaves the batch in a
 * state an administrator can act on; the archived file is never deleted.
 */
export async function validateImport(
  db: D1Database,
  batchId: number,
  loadFile: () => Promise<ArrayBuffer | null>
): Promise<ValidateResult> {
  const batch = await getImportBatch(db, batchId);
  if (!batch) {
    return { kind: 'conflict', reason: 'Import not found' };
  }

  if (batch.status === 'committed' || batch.status === 'committing') {
    return { kind: 'conflict', reason: 'This import has already been committed.' };
  }

  // Re-validation is allowed from any non-committed resting state.
  const claimed = await transitionStatus(
    db,
    batchId,
    ['pending', 'preview', 'validation_failed', 'commit_failed'],
    'validating'
  );

  if (!claimed) {
    return { kind: 'conflict', reason: 'This import is not in a state that can be validated.' };
  }

  const validator = VALIDATORS[batch.import_type];

  if (!validator) {
    // Honest dead end: the infrastructure worked, the business importer does
    // not exist. Recorded as a validation failure with a clear reason rather
    // than a fabricated success.
    await transitionStatus(db, batchId, 'validating', 'validation_failed', {
      failureReason: NOT_IMPLEMENTED_REASON,
    });
    await saveValidationResults(db, batchId, [], {
      fileMessages: [NOT_IMPLEMENTED_REASON],
      implemented: false,
    });

    const updated = await getImportBatch(db, batchId);
    return { kind: 'not_implemented', batch: updated! };
  }

  const file = await loadFile();
  if (!file) {
    const reason = 'The archived file for this import could not be read.';
    await transitionStatus(db, batchId, 'validating', 'validation_failed', {
      failureReason: reason,
    });
    const updated = await getImportBatch(db, batchId);
    return { kind: 'failed', batch: updated!, fileMessages: [reason] };
  }

  let outcome: ValidationOutcome;
  try {
    outcome = await validator(db, file);
  } catch (error) {
    // The message is operator-facing and must not carry file contents.
    console.error('Import validation threw for batch', batchId, error instanceof Error ? error.name : 'unknown');
    const reason = 'Validation could not complete for this file.';
    await transitionStatus(db, batchId, 'validating', 'validation_failed', {
      failureReason: reason,
    });
    const updated = await getImportBatch(db, batchId);
    return { kind: 'failed', batch: updated!, fileMessages: [reason] };
  }

  await saveValidationResults(db, batchId, outcome.rows, {
    fileMessages: outcome.fileMessages,
    implemented: true,
  });

  const passed = outcome.passed && outcome.rows.every((r) => r.status !== 'invalid');

  await transitionStatus(
    db,
    batchId,
    'validating',
    passed ? 'preview' : 'validation_failed',
    { failureReason: passed ? null : 'The file contains rows that cannot be imported.' }
  );

  const updated = await getImportBatch(db, batchId);
  return {
    kind: passed ? 'ready' : 'failed',
    batch: updated!,
    fileMessages: outcome.fileMessages,
  };
}

export type CommitResult =
  | { kind: 'committed'; batch: ImportBatch }
  | { kind: 'not_implemented'; reason: string }
  | { kind: 'conflict'; reason: string }
  | { kind: 'failed'; reason: string };

/**
 * Commit a validated import.
 *
 * Double-commit protection is a compare-and-swap: the batch is claimed by an
 * atomic `preview -> committing` transition. Whoever loses that race is told
 * the import is already being committed. A disabled button is not, and never
 * was, the protection.
 *
 * The batch is marked `committed` only AFTER the production write succeeds. If
 * the committer throws, the batch lands in `commit_failed` with its file and
 * staged rows intact, so the evidence survives and the attempt can be retried.
 */
export async function commitImport(
  db: D1Database,
  batchId: number,
  actorId: number
): Promise<CommitResult> {
  const batch = await getImportBatch(db, batchId);
  if (!batch) {
    return { kind: 'conflict', reason: 'Import not found' };
  }

  if (batch.status === 'committed') {
    return { kind: 'conflict', reason: 'This import has already been committed.' };
  }
  if (batch.status === 'committing') {
    return { kind: 'conflict', reason: 'This import is already being committed.' };
  }
  if (batch.status !== 'preview') {
    return {
      kind: 'conflict',
      reason: 'This import must pass validation before it can be committed.',
    };
  }

  const committer = COMMITTERS[batch.import_type];
  if (!committer) {
    // Refused rather than faked. The batch stays in `preview` so it remains
    // committable once the real committer exists.
    return { kind: 'not_implemented', reason: NOT_IMPLEMENTED_REASON };
  }

  // Atomic claim. A concurrent request finds the row no longer in `preview`
  // and changes nothing.
  const claimed = await transitionStatus(db, batchId, 'preview', 'committing');
  if (!claimed) {
    return { kind: 'conflict', reason: 'This import is already being committed.' };
  }

  try {
    await committer(db, batch);
  } catch (error) {
    console.error('Import commit failed for batch', batchId, error instanceof Error ? error.name : 'unknown');
    await transitionStatus(db, batchId, 'committing', 'commit_failed', {
      failureReason: 'The import could not be applied. No partial data was kept.',
    });
    return { kind: 'failed', reason: 'The import could not be applied.' };
  }

  const finished = await transitionStatus(db, batchId, 'committing', 'committed', {
    committedBy: actorId,
    failureReason: null,
  });

  if (!finished) {
    return { kind: 'failed', reason: 'The import completed but its status could not be recorded.' };
  }

  const updated = await getImportBatch(db, batchId);
  return { kind: 'committed', batch: updated! };
}
