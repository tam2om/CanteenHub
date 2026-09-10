/**
 * Employee Excel importer.
 *
 * Plugs into the Phase 4 Slice 1 foundation: it registers a validator and a
 * committer and does not bypass the import service or its state machine.
 *
 * WHAT THIS IMPORT OWNS: amco_id (as the identity key), full_name, department,
 * section, roster_type - the five columns the source workbook actually carries.
 *
 * WHAT IT MUST NEVER TOUCH: password_hash, role_id, is_active, or any row in
 * lunch_selections, lunch_selection_history, roster_entries, menu_days or
 * holidays. An employee absent from the workbook is left completely alone; this
 * is an upsert keyed on AMCO ID, never a directory synchronisation.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { normalizeCell, normalizeHeader, readWorksheet, XlsxError } from '../lib/xlsx.js';
import type { ImportBatch, StagedRowInput } from '../repositories/imports.repo.js';
import type { ValidationOutcome } from '../services/imports.service.js';

/** The worksheet the real employee workbook uses. */
export const EMPLOYEE_SHEET_NAME = 'All Employees';

/** How a row will change production data. */
export type EmployeeRowAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';

type RosterType = 'regular' | 'shift' | 'amman_hq';

/**
 * Column aliases. The real workbook uses "AMCO ID#"; a re-export or a
 * hand-edited copy may reasonably differ in punctuation or spacing, and header
 * matching is normalized (trimmed, whitespace-collapsed, lowercased) before
 * comparison. Anything outside this list is NOT guessed at.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  amco_id: ['amco id#', 'amco id', 'amco_id', 'amcoid', 'employee id', 'code'],
  full_name: ['name', 'full name', 'employee name', 'full_name'],
  department: ['department', 'dept'],
  section: ['section'],
  roster_type: ['roster', 'roster type', 'roster_type'],
};

/** Columns that must be present for the file to be readable at all. */
const REQUIRED_COLUMNS = ['amco_id', 'full_name', 'roster_type'] as const;

/**
 * Roster values as the workbook writes them, mapped to the database enum.
 * Matched case-insensitively after whitespace collapsing. Anything unrecognised
 * is REJECTED - never coerced to a default, because guessing here would decide
 * whether a real person is fed.
 */
const ROSTER_VALUES: Record<string, RosterType> = {
  regular: 'regular',
  shift: 'shift',
  'amman hq': 'amman_hq',
  amman_hq: 'amman_hq',
  ammanhq: 'amman_hq',
};

const MAX_FIELD_LENGTH = 200;
const AMCO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,49}$/;

export interface EmployeePreview {
  action: EmployeeRowAction;
  amco_id: string;
  full_name: string;
  department: string | null;
  section: string | null;
  roster_type: RosterType | null;
  /** For an UPDATE, the fields that differ, with current and incoming values. */
  changes?: Array<{ field: string; from: string | null; to: string | null }>;
}

interface ExistingEmployee {
  id: number;
  amco_id: string;
  full_name: string;
  department: string | null;
  section: string | null;
  roster_type: RosterType;
}

/**
 * Look up every AMCO ID in the workbook with a small number of batched queries.
 *
 * One query per row would be thousands of round trips against a database that
 * allows 50 per invocation on the free plan. D1 also caps bound parameters at
 * 100, hence the chunking.
 */
async function loadExistingByAmcoId(
  db: D1Database,
  amcoIds: string[]
): Promise<Map<string, ExistingEmployee>> {
  const found = new Map<string, ExistingEmployee>();
  const CHUNK = 90; // under D1's 100-parameter ceiling

  for (let i = 0; i < amcoIds.length; i += CHUNK) {
    const chunk = amcoIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;

    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db
      .prepare(
        `SELECT id, amco_id, full_name, department, section, roster_type
         FROM employees WHERE amco_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<ExistingEmployee>();

    for (const row of result.results || []) {
      found.set(row.amco_id, row);
    }
  }

  return found;
}

interface ParsedRow {
  rowNumber: number;
  amcoId: string;
  fullName: string;
  department: string;
  section: string;
  rosterRaw: string;
}

/**
 * Validate an employee workbook.
 *
 * Reads, normalizes and classifies every row against what is currently stored.
 * Writes NOTHING to production tables.
 */
export async function validateEmployeeWorkbook(
  db: D1Database,
  file: ArrayBuffer
): Promise<ValidationOutcome> {
  const fileMessages: string[] = [];

  let sheet;
  try {
    sheet = await readWorksheet(file, EMPLOYEE_SHEET_NAME);
  } catch (error) {
    return {
      rows: [],
      fileMessages: [
        error instanceof XlsxError
          ? error.message
          : 'This workbook could not be read. Check that it is a valid .xlsx file.',
      ],
      passed: false,
    };
  }

  if (sheet.rows.length === 0) {
    return { rows: [], fileMessages: ['The worksheet is empty.'], passed: false };
  }

  // ---- headers -------------------------------------------------------------
  const headerRow = sheet.rows[0];
  const columnOf = new Map<string, number>();
  const unrecognised: string[] = [];

  for (const [index, raw] of headerRow.cells) {
    const normalized = normalizeHeader(raw);
    if (!normalized) continue;

    const field = Object.keys(COLUMN_ALIASES).find((key) =>
      COLUMN_ALIASES[key].includes(normalized)
    );

    if (!field) {
      unrecognised.push(raw.trim());
      continue;
    }
    if (columnOf.has(field)) {
      return {
        rows: [],
        fileMessages: [`The column "${raw.trim()}" appears more than once.`],
        passed: false,
      };
    }
    columnOf.set(field, index);
  }

  const missing = REQUIRED_COLUMNS.filter((field) => !columnOf.has(field));
  if (missing.length > 0) {
    const names: Record<string, string> = {
      amco_id: 'AMCO ID',
      full_name: 'Name',
      roster_type: 'Roster',
    };
    return {
      rows: [],
      fileMessages: missing.map((f) => `Required column "${names[f] ?? f}" is missing.`),
      passed: false,
    };
  }

  // Extra columns are a warning, not an error: a workbook may legitimately
  // carry notes the importer does not own.
  if (unrecognised.length > 0) {
    fileMessages.push(
      `Ignored ${unrecognised.length} unrecognised column${unrecognised.length === 1 ? '' : 's'}: ${unrecognised.join(', ')}.`
    );
  }

  const cell = (row: { cells: Map<number, string> }, field: string): string => {
    const index = columnOf.get(field);
    return index === undefined ? '' : normalizeCell(row.cells.get(index));
  };

  // ---- read rows -----------------------------------------------------------
  const parsed: ParsedRow[] = [];
  let blankRows = 0;

  for (const row of sheet.rows.slice(1)) {
    const amcoId = cell(row, 'amco_id');
    const fullName = cell(row, 'full_name');
    const department = cell(row, 'department');
    const section = cell(row, 'section');
    const rosterRaw = cell(row, 'roster_type');

    // A completely blank row is skipped silently: trailing blanks are normal in
    // a hand-maintained workbook and are not an error.
    if (!amcoId && !fullName && !department && !section && !rosterRaw) {
      blankRows += 1;
      continue;
    }

    parsed.push({ rowNumber: row.rowNumber, amcoId, fullName, department, section, rosterRaw });
  }

  if (blankRows > 0) {
    fileMessages.push(`Skipped ${blankRows} blank row${blankRows === 1 ? '' : 's'}.`);
  }

  if (parsed.length === 0) {
    return {
      rows: [],
      fileMessages: [...fileMessages, 'The worksheet contains no data rows.'],
      passed: false,
    };
  }

  // ---- duplicates within the workbook --------------------------------------
  const seenCounts = new Map<string, number>();
  for (const row of parsed) {
    const key = row.amcoId.toUpperCase();
    if (key) seenCounts.set(key, (seenCounts.get(key) ?? 0) + 1);
  }

  // ---- existing employees, batched ----------------------------------------
  const lookupIds = [...new Set(parsed.map((r) => r.amcoId).filter(Boolean))];
  const existing = await loadExistingByAmcoId(db, lookupIds);

  // ---- classify ------------------------------------------------------------
  const staged: StagedRowInput[] = [];

  for (const row of parsed) {
    const errors: string[] = [];

    if (!row.amcoId) {
      errors.push('AMCO ID is missing.');
    } else if (!AMCO_ID_PATTERN.test(row.amcoId)) {
      errors.push('AMCO ID contains unsupported characters.');
    } else if ((seenCounts.get(row.amcoId.toUpperCase()) ?? 0) > 1) {
      // Never resolved silently: which row is correct is a business decision,
      // so the administrator fixes the workbook rather than the importer
      // guessing.
      errors.push('AMCO ID appears more than once in the workbook.');
    }

    if (!row.fullName) {
      errors.push('Name is missing.');
    } else if (row.fullName.length > MAX_FIELD_LENGTH) {
      errors.push(`Name is longer than ${MAX_FIELD_LENGTH} characters.`);
    }

    if (row.department.length > MAX_FIELD_LENGTH) errors.push('Department is too long.');
    if (row.section.length > MAX_FIELD_LENGTH) errors.push('Section is too long.');

    let rosterType: RosterType | null = null;
    if (!row.rosterRaw) {
      errors.push('Roster is missing.');
    } else {
      const mapped = ROSTER_VALUES[row.rosterRaw.toLowerCase()];
      if (!mapped) {
        errors.push(`Unsupported roster value "${row.rosterRaw}".`);
      } else {
        rosterType = mapped;
      }
    }

    if (errors.length > 0) {
      const invalid: EmployeePreview = {
        action: 'INVALID',
        amco_id: row.amcoId,
        full_name: row.fullName,
        department: row.department || null,
        section: row.section || null,
        roster_type: rosterType,
      };
      staged.push({
        rowNumber: row.rowNumber,
        status: 'invalid',
        messages: errors,
        preview: invalid,
      });
      continue;
    }

    const current = existing.get(row.amcoId);
    const incoming = {
      full_name: row.fullName,
      department: row.department || null,
      section: row.section || null,
      roster_type: rosterType as RosterType,
    };

    if (!current) {
      const created: EmployeePreview = { action: 'CREATE', amco_id: row.amcoId, ...incoming };
      staged.push({ rowNumber: row.rowNumber, status: 'valid', preview: created });
      continue;
    }

    const changes: NonNullable<EmployeePreview['changes']> = [];
    for (const field of ['full_name', 'department', 'section', 'roster_type'] as const) {
      const from = current[field] ?? null;
      const to = incoming[field] ?? null;
      if (from !== to) changes.push({ field, from, to });
    }

    // No differences means no UPDATE is issued at commit: re-running the same
    // workbook must not churn rows or burn D1 writes.
    const updated: EmployeePreview = {
      action: changes.length === 0 ? 'UNCHANGED' : 'UPDATE',
      amco_id: row.amcoId,
      ...incoming,
      ...(changes.length > 0 ? { changes } : {}),
    };
    staged.push({ rowNumber: row.rowNumber, status: 'valid', preview: updated });
  }

  const invalidCount = staged.filter((r) => r.status === 'invalid').length;
  if (invalidCount > 0) {
    fileMessages.push(
      `${invalidCount} row${invalidCount === 1 ? '' : 's'} cannot be imported. Fix the workbook and upload it again - nothing will be committed until every row is valid.`
    );
  }

  // `passed: false` when any row is invalid. This importer does NOT partially
  // commit: the foundation defines no partial-commit policy, and half-applying
  // a staff list is worse than applying none of it.
  return { rows: staged, fileMessages, passed: invalidCount === 0 };
}

/**
 * Apply a validated employee workbook.
 *
 * Reads the staged rows the validator wrote and issues one statement per CREATE
 * or UPDATE inside a single atomic batch. UNCHANGED rows produce no statement at
 * all. Nothing outside the five workbook-owned columns is written - notably
 * password_hash, role_id and is_active appear in no statement, so an existing
 * employee keeps their credential, their role and their active status.
 */
export async function commitEmployeeWorkbook(db: D1Database, batch: ImportBatch): Promise<void> {
  const staged = await db
    .prepare(
      `SELECT preview_json FROM import_batch_rows
       WHERE import_batch_id = ? AND status IN ('valid', 'warning')
       ORDER BY row_number ASC`
    )
    .bind(batch.id)
    .all<{ preview_json: string | null }>();

  const statements = [];

  for (const row of staged.results || []) {
    if (!row.preview_json) continue;
    const preview = JSON.parse(row.preview_json) as EmployeePreview;

    if (preview.action === 'UNCHANGED' || preview.action === 'INVALID') continue;
    if (!preview.roster_type) continue;

    if (preview.action === 'CREATE') {
      // No password_hash, no role_id, no is_active: a created employee takes the
      // schema defaults and cannot sign in until an administrator sets a
      // password.
      statements.push(
        db
          .prepare(
            `INSERT INTO employees (amco_id, full_name, department, section, roster_type)
             VALUES (?, ?, ?, ?, ?)`
          )
          .bind(
            preview.amco_id,
            preview.full_name,
            preview.department,
            preview.section,
            preview.roster_type
          )
      );
    } else {
      // Targeted UPDATE of workbook-owned columns only, keyed on the stable
      // AMCO ID. The employee's row id, credential, role, active status and
      // every related history row are untouched.
      statements.push(
        db
          .prepare(
            `UPDATE employees
             SET full_name = ?, department = ?, section = ?, roster_type = ?,
                 updated_at = datetime('now')
             WHERE amco_id = ?`
          )
          .bind(
            preview.full_name,
            preview.department,
            preview.section,
            preview.roster_type,
            preview.amco_id
          )
      );
    }
  }

  if (statements.length === 0) return;

  // D1 batches are transactional: either every employee change lands or none
  // does. A workbook is never half-applied because row 87 failed.
  await db.batch(statements);
}
