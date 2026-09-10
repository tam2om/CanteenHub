/**
 * Shift roster Excel importer.
 *
 * Plugs into the Phase 4 Slice 1 foundation: it registers a validator and a
 * committer and does not bypass the import service or its state machine.
 *
 * WHAT THIS IMPORT OWNS: roster_entries rows for the (employee, date) pairs the
 * workbook actually represents.
 *
 * WHAT IT MUST NEVER TOUCH: any column of `employees` (identity, credential,
 * role, active status), lunch_selections, lunch_selection_history, menu_days or
 * holidays. It also never creates an employee - a roster row for an unknown
 * AMCO ID is an error to be corrected, not a licence to invent a person.
 *
 * ELIGIBILITY IS NOT DECIDED HERE. This importer only records Day/Night/Off.
 * `services/eligibility.service.ts` remains the single authority on whether a
 * roster value earns a meal.
 *
 * SHEET SHAPE - the real workbook is wide, one row per employee-month:
 *
 *     code | month | year | 1 | 2 | 3 | ... | 31
 *
 * with each day column holding Off, Day or Night. A blank day cell means the
 * workbook says nothing about that date, which is different from saying "Off".
 */

import type { D1Database } from '@cloudflare/workers-types';
import { normalizeCell, normalizeHeader, readWorksheet, XlsxError } from '../lib/xlsx.js';
import { isValidBusinessDate } from '../lib/datetime.js';
import { bulkInsertRosterEntries } from '../repositories/roster.repo.js';
import type { ImportBatch, StagedRowInput } from '../repositories/imports.repo.js';
import type { ValidationOutcome } from '../services/imports.service.js';
import type { ShiftValue } from '../../shared/types/index.js';

/** The worksheet the real roster workbook uses. */
export const ROSTER_SHEET_NAME = 'Shifts roster';

/** How a worksheet row will change production data. */
export type RosterRowAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';

/**
 * Header aliases for the three identity columns. The day columns are matched
 * separately, by their numeric label. Anything outside this list is NOT guessed
 * at.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  amco_id: ['code', 'amco id#', 'amco id', 'amco_id', 'amcoid', 'employee id'],
  month: ['month'],
  year: ['year'],
};

const REQUIRED_COLUMNS = ['amco_id', 'month', 'year'] as const;

/**
 * Shift values as the workbook writes them, mapped to the database enum.
 * Matched case-insensitively after whitespace collapsing. Anything unrecognised
 * is REJECTED - never coerced to a default, because guessing here would decide
 * whether a real person is fed.
 *
 * Deliberately only the three words the real workbook uses. Single-letter
 * abbreviations are NOT accepted: a stray "O" or "N" left in a cell would
 * otherwise become a real shift silently, and a loud validation error the
 * administrator can fix is strictly better than a quiet guess.
 */
const SHIFT_VALUES: Record<string, ShiftValue> = {
  off: 'off',
  day: 'day',
  night: 'night',
};

/** Month names, so a workbook written as "March" is read rather than rejected. */
const MONTH_NAMES: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

/**
 * Accepted year window.
 *
 * Not a business horizon - eligibility never scans a calendar - but a typo
 * guard: "2206" should be rejected at validation rather than quietly creating
 * roster rows nobody will ever see.
 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const AMCO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,49}$/;

/** One day cell, as the preview reports it. */
export interface RosterDayPreview {
  work_date: string;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED';
  /** The value currently stored, or null when there is no active entry. */
  from: ShiftValue | null;
  /** The value the workbook carries. */
  to: ShiftValue;
}

/**
 * One worksheet row, as the preview reports it.
 *
 * Deliberately one staged row per WORKSHEET row rather than per roster entry:
 * `import_batch_rows` carries UNIQUE(import_batch_id, row_number), a wide month
 * produces up to 31 entries behind a single row number, and an administrator
 * reads this file one employee-month at a time.
 */
export interface RosterPreview {
  action: RosterRowAction;
  amco_id: string;
  month: number | null;
  year: number | null;
  /** Represented day cells, ascending. Blank cells never appear here. */
  days: RosterDayPreview[];
  counts: { create: number; update: number; unchanged: number };
}

interface ParsedRow {
  rowNumber: number;
  amcoId: string;
  monthRaw: string;
  yearRaw: string;
  /** Day number -> raw cell text, for the day columns that carry anything. */
  dayCells: Map<number, string>;
}

/** An entry the commit will write. */
interface PendingEntry {
  employee_id: number;
  work_date: string;
  shift_value: ShiftValue;
}

/**
 * Read a month cell that may be a number, a numeric string or a month name.
 * Anything else yields null, which the caller reports as an error.
 */
function parseMonth(raw: string): number | null {
  if (!raw) return null;
  const named = MONTH_NAMES[raw.toLowerCase()];
  if (named) return named;
  // Excel readily hands back "3.0" where a person typed 3.
  if (!/^\d{1,2}(\.0+)?$/.test(raw)) return null;
  const n = Math.trunc(Number(raw));
  return n >= 1 && n <= 12 ? n : null;
}

/** Read a year cell. Excel may hand back "2027" or "2027.0"; nothing else passes. */
function parseYear(raw: string): number | null {
  if (!/^\d{4}(\.0+)?$/.test(raw)) return null;
  const n = Math.trunc(Number(raw));
  return n >= MIN_YEAR && n <= MAX_YEAR ? n : null;
}

/** Compose a YYYY-MM-DD date without touching a clock or a timezone. */
function composeDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Look up existing roster entries for the workbook's employees and month span,
 * with a small number of batched queries.
 *
 * One query per cell would be thousands of round trips against a database that
 * allows 50 per invocation on the free plan. D1 also caps bound parameters at
 * 100, hence the chunking.
 */
async function loadExistingEntries(
  db: D1Database,
  employeeIds: number[],
  minDate: string,
  maxDate: string
): Promise<Map<string, ShiftValue>> {
  const found = new Map<string, ShiftValue>();
  const CHUNK = 88; // under D1's 100-parameter ceiling, leaving room for the dates

  for (let i = 0; i < employeeIds.length; i += CHUNK) {
    const chunk = employeeIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;

    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db
      .prepare(
        `SELECT employee_id, work_date, shift_value
           FROM roster_entries
          WHERE employee_id IN (${placeholders})
            AND work_date BETWEEN ? AND ?
            AND deleted_at IS NULL`
      )
      .bind(...chunk, minDate, maxDate)
      .all<{ employee_id: number; work_date: string; shift_value: ShiftValue }>();

    for (const row of result.results || []) {
      found.set(`${row.employee_id}|${row.work_date}`, row.shift_value);
    }
  }

  return found;
}

/** Resolve AMCO IDs to employee rows, batched for the same reason. */
async function loadEmployeesByAmcoId(
  db: D1Database,
  amcoIds: string[]
): Promise<Map<string, { id: number; amco_id: string }>> {
  const found = new Map<string, { id: number; amco_id: string }>();
  const CHUNK = 90;

  for (let i = 0; i < amcoIds.length; i += CHUNK) {
    const chunk = amcoIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;

    const placeholders = chunk.map(() => '?').join(', ');
    const result = await db
      .prepare(`SELECT id, amco_id FROM employees WHERE amco_id IN (${placeholders})`)
      .bind(...chunk)
      .all<{ id: number; amco_id: string }>();

    for (const row of result.results || []) {
      found.set(row.amco_id, row);
    }
  }

  return found;
}

/**
 * Validate a shift roster workbook.
 *
 * Reads, normalizes and classifies every represented day cell against what is
 * currently stored. Writes nothing to roster_entries or employees.
 */
export async function validateRosterWorkbook(
  db: D1Database,
  file: ArrayBuffer
): Promise<ValidationOutcome> {
  let sheet;
  try {
    sheet = await readWorksheet(file, ROSTER_SHEET_NAME);
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
  const columns = new Map<string, number>();
  const dayColumns = new Map<number, number>(); // day number -> column index
  const duplicateHeaders: string[] = [];
  const fileMessages: string[] = [];

  for (const [index, raw] of headerRow.cells) {
    const header = normalizeHeader(raw);
    if (!header) continue;

    // A day column is labelled by its number: 1..31, possibly as "1.0".
    const dayMatch = /^(\d{1,2})(?:\.0+)?$/.exec(header);
    if (dayMatch) {
      const day = Number(dayMatch[1]);
      if (day >= 1 && day <= 31) {
        if (dayColumns.has(day)) duplicateHeaders.push(String(day));
        else dayColumns.set(day, index);
        continue;
      }
    }

    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (!aliases.includes(header)) continue;
      if (columns.has(field)) duplicateHeaders.push(header);
      else columns.set(field, index);
      break;
    }
  }

  if (duplicateHeaders.length > 0) {
    return {
      rows: [],
      fileMessages: [
        `The worksheet has more than one column headed: ${[...new Set(duplicateHeaders)].join(', ')}.`,
      ],
      passed: false,
    };
  }

  const missing = REQUIRED_COLUMNS.filter((field) => !columns.has(field));
  if (missing.length > 0) {
    return {
      rows: [],
      fileMessages: [`The worksheet is missing required column(s): ${missing.join(', ')}.`],
      passed: false,
    };
  }

  if (dayColumns.size === 0) {
    return {
      rows: [],
      fileMessages: ['The worksheet has no day columns. Expected columns numbered 1 to 31.'],
      passed: false,
    };
  }

  // ---- rows ----------------------------------------------------------------
  const cell = (row: { cells: Map<number, string> }, field: string): string => {
    const index = columns.get(field);
    return index === undefined ? '' : normalizeCell(row.cells.get(index));
  };

  const parsed: ParsedRow[] = [];
  for (const row of sheet.rows.slice(1)) {
    const dayCells = new Map<number, string>();
    for (const [day, index] of dayColumns) {
      const value = normalizeCell(row.cells.get(index));
      if (value) dayCells.set(day, value);
    }

    const amcoId = cell(row, 'amco_id');
    const monthRaw = cell(row, 'month');
    const yearRaw = cell(row, 'year');

    // A wholly blank line is spreadsheet padding, not an error.
    if (!amcoId && !monthRaw && !yearRaw && dayCells.size === 0) continue;

    parsed.push({ rowNumber: row.rowNumber, amcoId, monthRaw, yearRaw, dayCells });
  }

  if (parsed.length === 0) {
    return {
      rows: [],
      fileMessages: [...fileMessages, 'The worksheet contains no data rows.'],
      passed: false,
    };
  }

  // ---- resolve employees ---------------------------------------------------
  const lookupIds = [...new Set(parsed.map((r) => r.amcoId).filter(Boolean))];
  const employees = await loadEmployeesByAmcoId(db, lookupIds);

  // ---- first pass: parse each row into candidate entries -------------------
  interface Candidate {
    row: ParsedRow;
    errors: string[];
    month: number | null;
    year: number | null;
    employeeId: number | null;
    /** Represented, calendar-valid, value-valid cells. */
    days: Array<{ day: number; workDate: string; shift: ShiftValue }>;
  }

  const candidates: Candidate[] = [];
  const dateOwners = new Map<string, number[]>(); // "employeeId|date" -> row numbers

  for (const row of parsed) {
    const errors: string[] = [];

    if (!row.amcoId) {
      errors.push('AMCO ID is missing.');
    } else if (!AMCO_ID_PATTERN.test(row.amcoId)) {
      errors.push('AMCO ID contains unsupported characters.');
    }

    const month = parseMonth(row.monthRaw);
    if (!row.monthRaw) errors.push('Month is missing.');
    else if (month === null) errors.push(`Month "${row.monthRaw}" is not a valid month.`);

    const year = parseYear(row.yearRaw);
    if (!row.yearRaw) errors.push('Year is missing.');
    else if (year === null) {
      errors.push(`Year "${row.yearRaw}" is not a valid year between ${MIN_YEAR} and ${MAX_YEAR}.`);
    }

    // An unknown employee is never created from a roster file.
    let employeeId: number | null = null;
    if (row.amcoId && AMCO_ID_PATTERN.test(row.amcoId)) {
      const employee = employees.get(row.amcoId);
      if (!employee) {
        errors.push(
          `No employee with AMCO ID "${row.amcoId}" exists. Import the employee first; a roster file never creates one.`
        );
      } else {
        employeeId = employee.id;
      }
    }

    const days: Candidate['days'] = [];
    if (month !== null && year !== null) {
      for (const day of [...row.dayCells.keys()].sort((a, b) => a - b)) {
        const raw = row.dayCells.get(day)!;
        const workDate = composeDate(year, month, day);

        // Rejects September 31 and February 30, leap years included.
        if (!isValidBusinessDate(workDate)) {
          errors.push(
            `Day ${day} does not exist in ${String(month).padStart(2, '0')}/${year}.`
          );
          continue;
        }

        const shift = SHIFT_VALUES[raw.toLowerCase()];
        if (!shift) {
          errors.push(`Day ${day} has an unsupported shift value "${raw}".`);
          continue;
        }

        days.push({ day, workDate, shift });
      }
    }

    if (row.dayCells.size === 0 && errors.length === 0) {
      errors.push('This row has no shift values. Remove it or fill in the days it covers.');
    }

    if (employeeId !== null) {
      for (const entry of days) {
        const key = `${employeeId}|${entry.workDate}`;
        const owners = dateOwners.get(key);
        if (owners) owners.push(row.rowNumber);
        else dateOwners.set(key, [row.rowNumber]);
      }
    }

    candidates.push({ row, errors, month, year, employeeId, days });
  }

  // ---- duplicate (employee, date) across the workbook ----------------------
  const conflictedRows = new Set<number>();
  const conflictedDates = new Map<number, Set<string>>();
  for (const [key, owners] of dateOwners) {
    if (owners.length < 2) continue;
    const date = key.split('|')[1];
    for (const rowNumber of owners) {
      conflictedRows.add(rowNumber);
      const dates = conflictedDates.get(rowNumber) ?? new Set<string>();
      dates.add(date);
      conflictedDates.set(rowNumber, dates);
    }
  }

  for (const candidate of candidates) {
    if (!conflictedRows.has(candidate.row.rowNumber)) continue;
    const dates = [...(conflictedDates.get(candidate.row.rowNumber) ?? [])].sort();
    // Never resolved silently: which row is correct is a business decision, so
    // the administrator fixes the workbook rather than the importer guessing.
    candidate.errors.push(
      `The same employee and date appears more than once in this workbook: ${dates.join(', ')}.`
    );
  }

  // ---- existing roster entries, batched ------------------------------------
  const allDates: string[] = [];
  const employeeIds = new Set<number>();
  for (const candidate of candidates) {
    if (candidate.employeeId === null) continue;
    employeeIds.add(candidate.employeeId);
    for (const entry of candidate.days) allDates.push(entry.workDate);
  }

  const existing =
    allDates.length > 0
      ? await loadExistingEntries(
          db,
          [...employeeIds],
          allDates.reduce((min, d) => (d < min ? d : min)),
          allDates.reduce((max, d) => (d > max ? d : max))
        )
      : new Map<string, ShiftValue>();

  // ---- classify ------------------------------------------------------------
  const staged: StagedRowInput[] = [];
  let invalidCount = 0;
  let entryCreate = 0;
  let entryUpdate = 0;
  let entryUnchanged = 0;

  for (const candidate of candidates) {
    const { row, errors, month, year, employeeId } = candidate;

    if (errors.length > 0) {
      invalidCount += 1;
      const preview: RosterPreview = {
        action: 'INVALID',
        amco_id: row.amcoId,
        month,
        year,
        days: [],
        counts: { create: 0, update: 0, unchanged: 0 },
      };
      staged.push({ rowNumber: row.rowNumber, status: 'invalid', messages: errors, preview });
      continue;
    }

    const days: RosterDayPreview[] = [];
    let create = 0;
    let update = 0;
    let unchanged = 0;

    for (const entry of candidate.days) {
      const current = existing.get(`${employeeId}|${entry.workDate}`) ?? null;
      let action: RosterDayPreview['action'];
      if (current === null) {
        action = 'CREATE';
        create += 1;
      } else if (current === entry.shift) {
        // No difference means no statement is issued at commit: re-running the
        // same workbook writes nothing.
        action = 'UNCHANGED';
        unchanged += 1;
      } else {
        action = 'UPDATE';
        update += 1;
      }
      days.push({ work_date: entry.workDate, action, from: current, to: entry.shift });
    }

    entryCreate += create;
    entryUpdate += update;
    entryUnchanged += unchanged;

    const action: RosterRowAction =
      update > 0 ? 'UPDATE' : create > 0 ? 'CREATE' : 'UNCHANGED';

    const preview: RosterPreview = {
      action,
      amco_id: row.amcoId,
      month,
      year,
      days,
      counts: { create, update, unchanged },
    };

    staged.push({ rowNumber: row.rowNumber, status: 'valid', messages: [], preview });
  }

  const represented = entryCreate + entryUpdate + entryUnchanged;
  fileMessages.push(
    `${represented} roster day(s) represented across ${candidates.length} row(s): ` +
      `${entryCreate} new, ${entryUpdate} changed, ${entryUnchanged} already correct.`
  );
  fileMessages.push(
    'Dates this workbook does not mention are left exactly as they are - nothing is cleared.'
  );

  if (invalidCount > 0) {
    fileMessages.push(
      `${invalidCount} row(s) cannot be imported. Correct the workbook and upload it again - ` +
        'no roster entry has been changed.'
    );
  }

  // Any invalid row blocks the whole workbook: there are no partial imports.
  return { rows: staged, fileMessages, passed: invalidCount === 0 };
}

/**
 * Apply a validated shift roster workbook.
 *
 * Reads the staged rows the validator wrote and writes only the day cells that
 * actually change. UNCHANGED cells produce no statement at all, so re-running
 * the same workbook is a genuine no-op.
 *
 * Writing goes through `bulkInsertRosterEntries`, the repository's existing
 * import path, rather than hand-rolled SQL. That function performs an
 * ON CONFLICT(employee_id, work_date) DO UPDATE inside a single `db.batch()`:
 * no DELETE, no INSERT OR REPLACE, so employee rows and every row that
 * cascades from them are untouched.
 */
export async function commitRosterWorkbook(db: D1Database, batch: ImportBatch): Promise<void> {
  const staged = await db
    .prepare(
      `SELECT preview_json FROM import_batch_rows
       WHERE import_batch_id = ? AND status IN ('valid', 'warning')
       ORDER BY row_number ASC`
    )
    .bind(batch.id)
    .all<{ preview_json: string | null }>();

  // The preview stores AMCO IDs; resolve them once, in bulk, to row ids.
  const previews: RosterPreview[] = [];
  for (const row of staged.results || []) {
    if (!row.preview_json) continue;
    const preview = JSON.parse(row.preview_json) as RosterPreview;
    if (preview.action === 'INVALID') continue;
    previews.push(preview);
  }

  const employees = await loadEmployeesByAmcoId(
    db,
    [...new Set(previews.map((p) => p.amco_id).filter(Boolean))]
  );

  const entries: PendingEntry[] = [];
  for (const preview of previews) {
    const employee = employees.get(preview.amco_id);
    if (!employee) {
      // Validation proved this employee existed. If they are gone by commit
      // time, fail closed rather than silently dropping their roster.
      throw new Error('An employee referenced by this import no longer exists.');
    }

    for (const day of preview.days) {
      if (day.action === 'UNCHANGED') continue;
      entries.push({
        employee_id: employee.id,
        work_date: day.work_date,
        shift_value: day.to,
      });
    }
  }

  if (entries.length === 0) return;

  const result = await bulkInsertRosterEntries(
    db,
    entries.map((entry) => ({ ...entry, source: 'import' as const }))
  );

  if (result.errors.length > 0) {
    // The batch is transactional, so nothing landed. Surface the failure so the
    // service marks the import commit_failed rather than reporting success.
    throw new Error(`${result.errors.length} roster entr(ies) could not be written.`);
  }
}
