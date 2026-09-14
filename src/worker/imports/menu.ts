/**
 * Lunch menu Excel importer.
 *
 * Plugs into the Phase 4 Slice 1 foundation: it registers a validator and a
 * committer and does not bypass the import service or its state machine.
 *
 * WHAT THIS IMPORT OWNS: menu_days rows for the dates the workbook represents,
 * their two menu_options, and the menu_components the workbook carries.
 *
 * WHAT IT MUST NEVER TOUCH: employees, lunch_selections, lunch_selection_history
 * or roster_entries. Selections are deliberately NOT foreign-keyed to menu
 * records precisely so a menu correction cannot destroy what people chose; this
 * importer must not reintroduce that coupling by deleting menu rows.
 *
 * IT PUBLISHES WHAT IT COMMITS. A menu day this import creates is created
 * `published`, and a day it UPDATES is promoted from `draft` to `published`.
 *
 * That reverses the original rule, deliberately and on request. The reasoning
 * behind the old behaviour was that nothing should go live without a person
 * looking at it - but a person HAS looked at it: the import cannot commit
 * without an administrator reading the preview and confirming it. Making them
 * then visit the menu screen and publish thirty days one at a time was asking
 * for the same decision twice.
 *
 * Two limits remain, and they are the ones that actually protect anybody:
 *
 *   - NOTHING IS EVER UNPUBLISHED. Status only ever moves towards published.
 *   - AN ARCHIVED DAY IS LEFT ALONE. Archiving is a deliberate act; an import
 *     that resurrected it would be overruling a decision it cannot see the
 *     reason for. Its dishes are still updated - only its status is untouched.
 *
 * An UNCHANGED row writes no DISHES - they already match - but it is still
 * published if it is sitting in draft. Otherwise "the workbook is the menu"
 * would be false in the one case people hit hardest: re-uploading a file after
 * an earlier import left its days unpublished. A day already published produces
 * no statement at all, so re-importing a settled workbook remains a true
 * no-op.
 *
 * SHEET SHAPE - one row per calendar day:
 *
 *   Day | Date | Option 1 | Option 2 | Option Meal 1 | Option Meal 2 |
 *   Condiment | Beverage | Dessert / Fruits
 *
 * THE TRAP IN THAT HEADER: "Option Meal 1" and "Option Meal 2" are NOT a third
 * and fourth thing an employee may choose. In the real file "Option Meal 1" is
 * always a salad and "Option Meal 2" is almost always yoghurt - accompaniments
 * served with whichever main was picked. They map to COMPONENTS, not options.
 * The employee's choice is Option 1 vs Option 2 vs No Preference, and nothing
 * else. The header text actively argues for the wrong reading, which is why
 * this comment exists.
 */

import type { D1Database } from '@cloudflare/workers-types';
import {
  listWorksheets,
  normalizeCell,
  readWorksheet,
  XlsxError,
} from '../lib/xlsx.js';
import {
  chooseLunchSheet,
  findCandidateSheet,
  findHeaderBand,
  resolveColumns,
  COMPONENT_COLUMNS,
  type ComponentType,
  type LunchSheetSelection,
} from './menuSheet.js';
import { isValidBusinessDate } from '../lib/datetime.js';
import type { ImportBatch, StagedRowInput } from '../repositories/imports.repo.js';
import type { ValidationOutcome } from '../services/imports.service.js';

/** How a worksheet row will change production data. */
export type MenuRowAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';

const MAX_FIELD_LENGTH = 500;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

const MONTH_ABBREVIATIONS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

export interface MenuComponentPreview {
  component_type: ComponentType;
  /** The workbook's column label, so the preview reads like the source file. */
  label: string;
  name: string;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED';
  from: string | null;
  sort_order: number;
}

export interface MenuPreview {
  action: MenuRowAction;
  meal_date: string;
  option_1: string;
  option_2: string;
  /** Only the components the workbook actually carries. Blanks never appear. */
  components: MenuComponentPreview[];
  /** For an UPDATE, the option-level fields that differ. */
  changes: Array<{ field: string; from: string | null; to: string | null }>;
  /** Present for an existing day, so the preview can say it is not republished. */
  current_status: string | null;
}

interface ParsedRow {
  rowNumber: number;
  dateRaw: string;
  option1: string;
  option2: string;
  components: Array<{ field: string; type: ComponentType; label: string; value: string }>;
}

/**
 * Normalize menu TEXT: strip zero-width characters and trim the ends, and
 * nothing else.
 *
 * Deliberately not `normalizeCell`, which also collapses internal whitespace
 * runs. Dish names are read by humans deciding what to eat, and the source
 * carries doubled internal spaces and typos that are preserved verbatim - an
 * importer that "helpfully" tidies them is an importer inventing data. An
 * administrator fixes them on the menu screen instead.
 */
function normalizeMenuText(value: string | undefined): string {
  if (value === undefined) return '';
  return value.replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim();
}

/** Compose a YYYY-MM-DD date without touching a clock or a timezone. */
function composeDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Read a date cell.
 *
 * Three shapes reach us in practice: an ISO string, the `d-MMM-yy` the printed
 * menu uses, and an Excel date serial when the real workbook is supplied. All
 * three are converted arithmetically; none consults a clock or a timezone, so
 * no date can shift by a day.
 */
export function parseMenuDate(raw: string): string | null {
  if (!raw) return null;

  // 1. ISO, already the storage format.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return isValidBusinessDate(raw) ? raw : null;
  }

  // 2. d-MMM-yy / d-MMM-yyyy, e.g. "1-Sep-26" or "1 Sep 2026".
  const named = /^(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/](\d{2}|\d{4})$/.exec(raw);
  if (named) {
    const day = Number(named[1]);
    const month = MONTH_ABBREVIATIONS[named[2].toLowerCase()];
    if (!month) return null;
    // A two-digit year in a canteen menu is this century; "26" is 2026.
    const rawYear = Number(named[3]);
    const year = named[3].length === 2 ? 2000 + rawYear : rawYear;
    if (year < MIN_YEAR || year > MAX_YEAR) return null;
    const composed = composeDate(year, month, day);
    return isValidBusinessDate(composed) ? composed : null;
  }

  // 3. An Excel date serial. Serial 25569 is 1970-01-01, and serials at or
  //    below 60 fall inside Excel's fictional 1900 leap day, so they are
  //    refused rather than guessed at.
  if (/^\d{1,6}(\.0+)?$/.test(raw)) {
    const serial = Math.trunc(Number(raw));
    if (serial <= 60) return null;
    const utcMillis = (serial - 25569) * 86400000;
    const probe = new Date(utcMillis);
    if (Number.isNaN(probe.getTime())) return null;
    const composed = composeDate(
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      probe.getUTCDate()
    );
    if (!isValidBusinessDate(composed)) return null;
    const year = probe.getUTCFullYear();
    return year >= MIN_YEAR && year <= MAX_YEAR ? composed : null;
  }

  return null;
}

interface ExistingMenuDay {
  id: number;
  meal_date: string;
  status: string;
}

interface ExistingOption {
  menu_day_id: number;
  option_number: number;
  name: string;
}

interface ExistingComponent {
  id: number;
  menu_day_id: number;
  component_type: string;
  name: string;
}

/**
 * Load the menu days, options and components the workbook refers to, with a
 * small number of batched queries.
 *
 * One query per row would be hundreds of round trips against a database that
 * allows 50 per invocation on the free plan. D1 also caps bound parameters at
 * 100, hence the chunking.
 */
async function loadExisting(
  db: D1Database,
  dates: string[]
): Promise<{
  days: Map<string, ExistingMenuDay>;
  options: Map<string, ExistingOption>;
  components: Map<number, ExistingComponent[]>;
}> {
  const days = new Map<string, ExistingMenuDay>();
  const options = new Map<string, ExistingOption>();
  const components = new Map<number, ExistingComponent[]>();
  const CHUNK = 90;

  for (let i = 0; i < dates.length; i += CHUNK) {
    const chunk = dates.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');

    const dayRows = await db
      .prepare(
        `SELECT id, meal_date, status FROM menu_days WHERE meal_date IN (${placeholders})`
      )
      .bind(...chunk)
      .all<ExistingMenuDay>();

    for (const row of dayRows.results || []) days.set(row.meal_date, row);
  }

  const dayIds = [...days.values()].map((d) => d.id);
  for (let i = 0; i < dayIds.length; i += CHUNK) {
    const chunk = dayIds.slice(i, i + CHUNK);
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => '?').join(', ');

    const optionRows = await db
      .prepare(
        `SELECT menu_day_id, option_number, name FROM menu_options
          WHERE menu_day_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<ExistingOption>();
    for (const row of optionRows.results || []) {
      options.set(`${row.menu_day_id}|${row.option_number}`, row);
    }

    const componentRows = await db
      .prepare(
        `SELECT id, menu_day_id, component_type, name FROM menu_components
          WHERE menu_day_id IN (${placeholders})`
      )
      .bind(...chunk)
      .all<ExistingComponent>();
    for (const row of componentRows.results || []) {
      const list = components.get(row.menu_day_id) ?? [];
      list.push(row);
      components.set(row.menu_day_id, list);
    }
  }

  return { days, options, components };
}

/**
 * Choose the lunch worksheet for a workbook.
 *
 * Two stages, in this order and never the other way round:
 *
 *   1. BY NAME. A sheet whose name mentions lunch is used exactly as it always
 *      has been, with no confirmation step. This is the ordinary path and it is
 *      deliberately untouched.
 *   2. BY CONTENT, only when the names settle nothing. Each remaining sheet is
 *      opened and judged on its own structure and wording. A single qualifying
 *      sheet is returned as a CANDIDATE, which the administrator must confirm
 *      before anything can be committed; two or more is an ambiguity the import
 *      refuses to resolve on its own.
 *
 * A dinner sheet is never a candidate at either stage.
 */
export async function selectLunchWorksheet(file: ArrayBuffer): Promise<LunchSheetSelection> {
  const names = await listWorksheets(file);

  const byName = chooseLunchSheet(names);
  if ('error' in byName) return byName;
  if ('name' in byName) return { name: byName.name, source: 'named' };

  return findCandidateSheet(
    names,
    async (name) => (await readWorksheet(file, name)).rows,
    parseMenuDate
  );
}

/**
 * Validate a lunch menu workbook.
 *
 * Reads, normalizes and classifies every row against what is currently stored.
 * Writes nothing to menu_days, menu_options or menu_components.
 */
export async function validateMenuWorkbook(
  db: D1Database,
  file: ArrayBuffer
): Promise<ValidationOutcome> {
  let sheet;
  let selection: LunchSheetSelection;
  try {
    selection = await selectLunchWorksheet(file);
    if ('error' in selection) {
      return { rows: [], fileMessages: [selection.error], passed: false };
    }
    sheet = await readWorksheet(file, selection.name);
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

  // Carried through every later message so the administrator is never in doubt
  // about WHICH worksheet produced the preview they are approving.
  const sheetInfo: NonNullable<ValidationOutcome['sheet']> =
    selection.source === 'candidate'
      ? { name: selection.name, source: 'candidate', signals: selection.signals }
      : { name: selection.name, source: 'named' };

  const fail = (messages: string[]): ValidationOutcome => ({
    rows: [],
    fileMessages: messages,
    passed: false,
    sheet: sheetInfo,
  });

  if (sheet.rows.length === 0) {
    return fail(['The worksheet is empty.']);
  }

  // ---- headers -------------------------------------------------------------
  // The header is LOCATED rather than assumed to be row 1: a real workbook puts
  // a title above it and splits it across two merged rows.
  const band = findHeaderBand(sheet.rows);
  if (!band) {
    return fail(['The worksheet is empty.']);
  }

  const resolved = resolveColumns(band.raw);
  const { columns, componentColumns } = resolved;
  const fileMessages: string[] = [];

  // A third selectable option is refused before anything else is considered.
  if (resolved.extraOption) {
    return fail([
      `This worksheet has a column headed "${resolved.extraOption}". A lunch menu day has exactly ` +
        'two selectable options; a third cannot be imported. If this column is an ' +
        'accompaniment rather than a choice, rename it to the component it is.',
    ]);
  }

  if (resolved.duplicates.length > 0) {
    return fail([
      `The worksheet has more than one column headed: ${resolved.duplicates.join(', ')}.`,
    ]);
  }

  if (resolved.missing.length > 0) {
    return fail([`The worksheet is missing required column(s): ${resolved.missing.join(', ')}.`]);
  }

  // ---- rows ----------------------------------------------------------------
  // The date is normalized for matching; every other cell is menu TEXT and is
  // preserved as written apart from trimming.
  const dateCell = (row: { cells: Map<number, string> }, index: number | undefined): string =>
    index === undefined ? '' : normalizeCell(row.cells.get(index));
  const textCell = (row: { cells: Map<number, string> }, index: number | undefined): string =>
    index === undefined ? '' : normalizeMenuText(row.cells.get(index));

  const parsed: ParsedRow[] = [];
  for (const row of sheet.rows.slice(band.dataIndex)) {
    const dateRaw = dateCell(row, columns.get('meal_date'));
    const option1 = textCell(row, columns.get('option_1'));
    const option2 = textCell(row, columns.get('option_2'));

    const components: ParsedRow['components'] = [];
    for (const column of COMPONENT_COLUMNS) {
      const value = textCell(row, componentColumns.get(column.field));
      // A blank component cell says nothing about that component; it is not an
      // instruction to remove one.
      if (!value) continue;
      components.push({
        field: column.field,
        type: column.type,
        label: column.field,
        value,
      });
    }

    // A wholly blank line is spreadsheet padding, not an error.
    if (!dateRaw && !option1 && !option2 && components.length === 0) continue;

    parsed.push({ rowNumber: row.rowNumber, dateRaw, option1, option2, components });
  }

  if (parsed.length === 0) {
    return fail(['The worksheet contains no data rows.']);
  }

  // ---- first pass: parse and validate each row -----------------------------
  interface Candidate {
    row: ParsedRow;
    errors: string[];
    mealDate: string | null;
  }

  const candidates: Candidate[] = [];
  const dateOwners = new Map<string, number[]>();

  for (const row of parsed) {
    const errors: string[] = [];

    const mealDate = parseMenuDate(row.dateRaw);
    if (!row.dateRaw) {
      errors.push('Date is missing.');
    } else if (mealDate === null) {
      errors.push(`Date "${row.dateRaw}" is not a valid calendar date.`);
    }

    // Exactly two selectable options. A day with one main is not a choice.
    if (!row.option1) errors.push('Option 1 is missing. A menu day needs both options.');
    if (!row.option2) errors.push('Option 2 is missing. A menu day needs both options.');
    if (row.option1 && row.option1.length > MAX_FIELD_LENGTH) errors.push('Option 1 is too long.');
    if (row.option2 && row.option2.length > MAX_FIELD_LENGTH) errors.push('Option 2 is too long.');
    if (row.option1 && row.option2 && row.option1 === row.option2) {
      errors.push('Option 1 and Option 2 are identical, so there is nothing to choose between.');
    }

    for (const component of row.components) {
      if (component.value.length > MAX_FIELD_LENGTH) {
        errors.push(`The ${component.label} column is too long.`);
      }
    }

    if (mealDate) {
      const owners = dateOwners.get(mealDate);
      if (owners) owners.push(row.rowNumber);
      else dateOwners.set(mealDate, [row.rowNumber]);
    }

    candidates.push({ row, errors, mealDate });
  }

  // ---- duplicate dates across the workbook ---------------------------------
  const conflicted = new Set<number>();
  for (const owners of dateOwners.values()) {
    if (owners.length < 2) continue;
    for (const rowNumber of owners) conflicted.add(rowNumber);
  }
  for (const candidate of candidates) {
    if (!conflicted.has(candidate.row.rowNumber)) continue;
    // Never resolved silently: which row is the real menu is a business
    // decision, so the administrator fixes the workbook rather than the
    // importer guessing.
    candidate.errors.push(
      `The date ${candidate.mealDate} appears more than once in this workbook.`
    );
  }

  // ---- existing menu data, batched -----------------------------------------
  const dates = [...new Set(candidates.map((c) => c.mealDate).filter((d): d is string => !!d))];
  const existing = await loadExisting(db, dates);

  // ---- classify ------------------------------------------------------------
  const staged: StagedRowInput[] = [];
  let invalidCount = 0;
  let createCount = 0;
  let updateCount = 0;
  let unchangedCount = 0;

  for (const candidate of candidates) {
    const { row, errors, mealDate } = candidate;

    if (errors.length === 0 && mealDate) {
      // An ambiguous component set cannot be reconciled honestly.
      const day = existing.days.get(mealDate);
      if (day) {
        const currentComponents = existing.components.get(day.id) ?? [];
        for (const component of row.components) {
          const matches = currentComponents.filter((c) => c.component_type === component.type);
          if (matches.length > 1) {
            errors.push(
              `This date already has ${matches.length} ${component.type} components, so the ` +
                `${component.label} column cannot be matched to one of them. Tidy them up in ` +
                'the menu screen first.'
            );
          }
        }
      }
    }

    if (errors.length > 0 || !mealDate) {
      invalidCount += 1;
      const preview: MenuPreview = {
        action: 'INVALID',
        meal_date: mealDate ?? row.dateRaw,
        option_1: row.option1,
        option_2: row.option2,
        components: [],
        changes: [],
        current_status: null,
      };
      staged.push({ rowNumber: row.rowNumber, status: 'invalid', messages: errors, preview });
      continue;
    }

    const day = existing.days.get(mealDate);
    const currentComponents = day ? (existing.components.get(day.id) ?? []) : [];
    const changes: MenuPreview['changes'] = [];

    const currentOption1 = day ? (existing.options.get(`${day.id}|1`)?.name ?? null) : null;
    const currentOption2 = day ? (existing.options.get(`${day.id}|2`)?.name ?? null) : null;

    if (currentOption1 !== row.option1) {
      changes.push({ field: 'option_1', from: currentOption1, to: row.option1 });
    }
    if (currentOption2 !== row.option2) {
      changes.push({ field: 'option_2', from: currentOption2, to: row.option2 });
    }

    const componentPreviews: MenuComponentPreview[] = [];
    for (const [index, component] of row.components.entries()) {
      const match = currentComponents.find((c) => c.component_type === component.type) ?? null;
      const action: MenuComponentPreview['action'] =
        match === null ? 'CREATE' : match.name === component.value ? 'UNCHANGED' : 'UPDATE';
      componentPreviews.push({
        component_type: component.type,
        label: component.label,
        name: component.value,
        action,
        from: match?.name ?? null,
        sort_order: index,
      });
    }

    const componentChanges = componentPreviews.filter((c) => c.action !== 'UNCHANGED').length;

    let action: MenuRowAction;
    if (!day) {
      action = 'CREATE';
      createCount += 1;
    } else if (changes.length === 0 && componentChanges === 0) {
      // Nothing differs, so no statement is issued at commit: re-running the
      // same workbook writes nothing.
      action = 'UNCHANGED';
      unchangedCount += 1;
    } else {
      action = 'UPDATE';
      updateCount += 1;
    }

    const preview: MenuPreview = {
      action,
      meal_date: mealDate,
      option_1: row.option1,
      option_2: row.option2,
      components: componentPreviews,
      changes,
      current_status: day?.status ?? null,
    };

    staged.push({ rowNumber: row.rowNumber, status: 'valid', messages: [], preview });
  }

  // The worksheet is named FIRST, above the counts: when it was identified by
  // content rather than by its name, the administrator is approving a decision
  // this importer made, and must be able to see it without hunting for it.
  if (sheetInfo.source === 'candidate') {
    fileMessages.push(
      `No worksheet in this workbook is named "Lunch". "${sheetInfo.name}" was identified as ` +
        `the lunch menu because ${(sheetInfo.signals ?? []).join(', and ')}. Confirm that this is the ` +
        'right worksheet before committing - nothing is imported until you do.'
    );
  } else {
    fileMessages.push(`Read from the "${sheetInfo.name}" worksheet.`);
  }

  fileMessages.push(
    `${createCount} new menu day(s), ${updateCount} changed, ${unchangedCount} already correct.`
  );
  fileMessages.push(
    'Dates this workbook does not mention are left exactly as they are - no menu is removed.'
  );
  fileMessages.push(
    'Committing PUBLISHES every date in this workbook, including days whose dishes are ' +
      'already correct but are still in draft. Employees can select from them as soon as you ' +
      'confirm. A day that was archived keeps that status, and nothing is ever unpublished.'
  );

  if (invalidCount > 0) {
    fileMessages.push(
      `${invalidCount} row(s) cannot be imported. Correct the workbook and upload it again - ` +
        'no menu has been changed.'
    );
  }

  // Any invalid row blocks the whole workbook: there are no partial imports.
  return { rows: staged, fileMessages, passed: invalidCount === 0, sheet: sheetInfo };
}

/**
 * Apply a validated lunch menu workbook.
 *
 * Every statement runs inside a single `db.batch()`, so a workbook is never
 * half-applied. UNCHANGED rows produce no statement at all.
 *
 * Statements are written here rather than through the menu repository because
 * each repository helper performs read-write-read round trips that cannot
 * compose into one atomic batch. No audit behaviour is bypassed by doing so:
 * `repositories/menu.repo.ts` contains no audit calls - it returns
 * before/after JSON for its caller, and the route layer is what writes to
 * `audit_log`. The import's own audit trail is written by the import route.
 *
 * Nothing is ever deleted. menu_days rows survive, so lunch_selections - which
 * are deliberately not foreign-keyed to them - are untouched either way.
 */
export async function commitMenuWorkbook(db: D1Database, batch: ImportBatch): Promise<void> {
  const staged = await db
    .prepare(
      `SELECT preview_json FROM import_batch_rows
       WHERE import_batch_id = ? AND status IN ('valid', 'warning')
       ORDER BY row_number ASC`
    )
    .bind(batch.id)
    .all<{ preview_json: string | null }>();

  // Rows whose DISHES change: these drive the option and component statements.
  const previews: MenuPreview[] = [];
  // EVERY date the workbook covers, UNCHANGED included. A day whose dishes
  // already match still has to end up published - "the workbook is the menu"
  // would not be true if a date in the file stayed invisible because its
  // dishes happened to be correct already.
  const coveredDates: string[] = [];

  for (const row of staged.results || []) {
    if (!row.preview_json) continue;
    const preview = JSON.parse(row.preview_json) as MenuPreview;
    if (preview.action === 'INVALID') continue;
    coveredDates.push(preview.meal_date);
    if (preview.action === 'UNCHANGED') continue;
    previews.push(preview);
  }

  if (coveredDates.length === 0) return;

  // Current state, read once. Ids are NOT needed for inserts: those resolve the
  // menu day by date inside the statement, which is what lets a day and its
  // options land in the SAME batch rather than two.
  const existing = await loadExisting(db, coveredDates);

  const statements = [];

  // Ordered deliberately: a menu day is inserted before the options and
  // components that resolve it by date. D1 runs a batch in order inside one
  // transaction, so the subquery below always finds the row.
  for (const preview of previews) {
    if (existing.days.has(preview.meal_date)) continue;
    statements.push(
      db
        .prepare(`INSERT INTO menu_days (meal_date, status) VALUES (?, 'published')`)
        .bind(preview.meal_date)
    );
  }

  // Every existing day the workbook covers goes live, whether or not its dishes
  // changed. Guarded on 'draft' so the statement can only ever move a day
  // towards published: a published day stays published, an archived one is left
  // exactly as it is - and a day that is ALREADY published produces no
  // statement at all, which is what keeps re-importing a settled workbook a
  // true no-op.
  for (const mealDate of coveredDates) {
    const day = existing.days.get(mealDate);
    if (!day || day.status !== 'draft') continue;
    statements.push(
      db
        .prepare(
          `UPDATE menu_days SET status = 'published'
           WHERE meal_date = ? AND status = 'draft'`
        )
        .bind(mealDate)
    );
  }

  for (const preview of previews) {
    const day = existing.days.get(preview.meal_date) ?? null;

    // Options: keyed on (menu_day_id, option_number), exactly as the menu
    // repository does. `status` is absent from these statements; publishing is
    // handled once, above, so a dish update cannot change a day's visibility as
    // a side effect.
    for (const [optionNumber, name] of [
      [1, preview.option_1],
      [2, preview.option_2],
    ] as Array<[1 | 2, string]>) {
      const current = day ? existing.options.get(`${day.id}|${optionNumber}`) : undefined;
      if (current && current.name === name) continue;
      statements.push(
        db
          .prepare(
            `INSERT INTO menu_options (menu_day_id, option_number, name)
             VALUES ((SELECT id FROM menu_days WHERE meal_date = ?), ?, ?)
             ON CONFLICT(menu_day_id, option_number) DO UPDATE SET name = excluded.name`
          )
          .bind(preview.meal_date, optionNumber, name)
      );
    }

    // Components have no unique constraint, so they are reconciled by
    // (menu_day_id, component_type) and updated by row id. Validation already
    // refused any date where that match would be ambiguous.
    const currentComponents = day ? (existing.components.get(day.id) ?? []) : [];
    for (const component of preview.components) {
      const match = currentComponents.find((c) => c.component_type === component.component_type);
      if (match && match.name === component.name) continue;

      if (match) {
        statements.push(
          db
            .prepare('UPDATE menu_components SET name = ?, sort_order = ? WHERE id = ?')
            .bind(component.name, component.sort_order, match.id)
        );
      } else {
        statements.push(
          db
            .prepare(
              `INSERT INTO menu_components (menu_day_id, component_type, name, sort_order)
               VALUES ((SELECT id FROM menu_days WHERE meal_date = ?), ?, ?, ?)`
            )
            .bind(preview.meal_date, component.component_type, component.name, component.sort_order)
        );
      }
    }
  }

  if (statements.length === 0) return;

  // D1 batches are transactional: either every menu change lands or none does.
  await db.batch(statements);
}
