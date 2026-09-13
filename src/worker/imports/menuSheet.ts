/**
 * Finding the lunch worksheet, and finding its header row.
 *
 * Split out of `menu.ts` because a real workbook made these two questions the
 * same question. The September 2026 file names its only sheet "Page 1" and puts
 * the column headers on rows 2-3 under a title cell reading "Lunch". Deciding
 * whether that sheet IS a lunch menu therefore requires locating its header
 * band, and parsing it requires the same answer - so one module resolves both
 * and `menu.ts` consumes the result.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a worksheet is never treated as lunch
 * because of where it sits in the workbook, or because it happens to be the only
 * sheet. Position is not evidence. A sheet qualifies only by its NAME, or by
 * carrying both the STRUCTURE of a lunch menu and the WORD lunch - and even then
 * it is offered as a candidate an administrator must confirm, never imported on
 * its own authority.
 *
 * A sheet that says "dinner" is excluded outright and can never become a
 * candidate, however menu-shaped it is. Importing dinner as lunch would feed the
 * wrong numbers to the caterer, which is the failure this whole module is
 * arranged to prevent.
 */

import { normalizeHeader, type SheetRow } from '../lib/xlsx.js';

/**
 * Component types this importer writes.
 *
 * The Phase 0 findings proposed `side` for the "Option Meal 2" column, but the
 * shipped schema's CHECK constraint allows only
 * condiment/beverage/dessert/salad/soup/bread/other. `other` is used rather than
 * widening a constraint from an importer; the component's NAME still carries the
 * real text.
 */
export type ComponentType = 'salad' | 'other' | 'condiment' | 'beverage' | 'dessert';

/**
 * The component columns, in display order. `sort_order` follows this order so
 * the rendered menu is deterministic rather than insertion-dependent.
 */
export const COMPONENT_COLUMNS: Array<{
  field: string;
  type: ComponentType;
  aliases: string[];
}> = [
  { field: 'salad', type: 'salad', aliases: ['option meal 1', 'salad'] },
  { field: 'side', type: 'other', aliases: ['option meal 2', 'side'] },
  { field: 'condiment', type: 'condiment', aliases: ['condiment', 'condiments'] },
  { field: 'beverage', type: 'beverage', aliases: ['beverage', 'beverages', 'drinks'] },
  {
    field: 'dessert',
    type: 'dessert',
    aliases: ['dessert / fruits', 'dessert/fruits', 'dessert', 'dessert / fruit', 'fruits'],
  },
];

export const COLUMN_ALIASES: Record<string, string[]> = {
  meal_date: ['date', 'meal date', 'menu date'],
  option_1: ['option 1', 'option1', 'option 1 ', 'main 1'],
  option_2: ['option 2', 'option2', 'main 2'],
};

/** Only the date and the two selectable options are structurally required. */
export const REQUIRED_COLUMNS = ['meal_date', 'option_1', 'option_2'] as const;

/**
 * A column headed "Option 3" (or higher) is refused outright.
 *
 * The schema permits option_number 1 and 2 only, and "exactly two selectable
 * options" is a business rule, not a formatting preference.
 */
export const EXTRA_OPTION_PATTERN = /^option\s*(\d+)$/;

/**
 * How far down a sheet the header may sit.
 *
 * The real file wastes one row on a title; ten is generous without turning a
 * data row that happens to read "Date" into a header. Rows are searched top
 * down, so the genuine header always wins over anything below it.
 */
const MAX_HEADER_SCAN_ROWS = 10;

/**
 * How many rows a header may span.
 *
 * Two, because the real workbook merges "Lunch Menu" across the Option 1 and
 * Option 2 columns and "Option per Person" across the two accompaniment
 * columns, putting the usable labels on the second row of the band.
 */
const MAX_HEADER_BAND_DEPTH = 2;

/**
 * How many worksheets are opened while looking for a candidate.
 *
 * Only reached when NO sheet is named for lunch, so the ordinary workbook costs
 * nothing extra. Bounded because each sheet is parsed in full inside a Worker
 * with a 10 ms CPU budget.
 */
const MAX_SHEETS_EXAMINED = 8;

/** A candidate must carry at least this many rows that parse as a date. */
const MIN_DATED_ROWS = 3;

/** How far below the header band dated rows are looked for. */
const DATE_PROBE_ROWS = 40;

const LUNCH_PATTERN = /\blunch(es)?\b/;
const DINNER_PATTERN = /\bdinner(s)?\b|\bsupper\b/;

/** The resolved header of a worksheet. */
export interface HeaderBand {
  /** Zero-based index into `rows` where the header starts. */
  startIndex: number;
  /** How many rows the header spans (1 or 2). */
  depth: number;
  /** Zero-based index of the first row below the header. */
  dataIndex: number;
  /** Normalized header text by zero-based column index. */
  headers: Map<number, string>;
  /** The same headers as written, for error messages the administrator reads. */
  raw: Map<number, string>;
}

export interface ResolvedColumns {
  /** Required/optional named columns by field name. */
  columns: Map<string, number>;
  /** Component columns by `COMPONENT_COLUMNS.field`. */
  componentColumns: Map<string, number>;
  /** Headers that appeared more than once, normalized. */
  duplicates: string[];
  /** Required fields with no column, in `REQUIRED_COLUMNS` order. */
  missing: string[];
  /** The raw text of a third-or-higher "Option N" column, if one exists. */
  extraOption: string | null;
}

/**
 * Merge a band of header rows into one header per column.
 *
 * The LOWER row wins wherever it has text: in a merged two-row header the upper
 * cell is the group ("Lunch Menu") and the lower cell is the column
 * ("Option 1"). Where the lower row is blank - a cell merged vertically, like
 * "Date" - the upper row's text carries down.
 */
function mergeBand(rows: SheetRow[], startIndex: number, depth: number): Map<number, string> {
  const merged = new Map<number, string>();
  for (let offset = 0; offset < depth; offset++) {
    const row = rows[startIndex + offset];
    if (!row) continue;
    for (const [column, value] of row.cells) {
      if (value.trim() === '') continue;
      merged.set(column, value);
    }
  }
  return merged;
}

/** Match a band's headers against the columns this importer understands. */
export function resolveColumns(raw: Map<number, string>): ResolvedColumns {
  const columns = new Map<string, number>();
  const componentColumns = new Map<string, number>();
  const duplicates: string[] = [];
  let extraOption: string | null = null;

  for (const [index, text] of raw) {
    const header = normalizeHeader(text);
    if (!header) continue;

    const extra = EXTRA_OPTION_PATTERN.exec(header);
    if (extra && Number(extra[1]) > 2) {
      extraOption ??= text.trim();
      continue;
    }

    let matched = false;
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (!aliases.includes(header)) continue;
      if (columns.has(field)) duplicates.push(header);
      else columns.set(field, index);
      matched = true;
      break;
    }
    if (matched) continue;

    for (const column of COMPONENT_COLUMNS) {
      if (!column.aliases.includes(header)) continue;
      if (componentColumns.has(column.field)) duplicates.push(header);
      else componentColumns.set(column.field, index);
      break;
    }
  }

  return {
    columns,
    componentColumns,
    duplicates: [...new Set(duplicates)],
    missing: REQUIRED_COLUMNS.filter((field) => !columns.has(field)),
    extraOption,
  };
}

/**
 * Locate the header.
 *
 * Scans top down and returns the FIRST band that resolves every required
 * column, trying a single row before a two-row band at each position so an
 * ordinary one-row header behaves exactly as it always has. When nothing
 * resolves, the best-scoring band is returned anyway, so the error message can
 * name the columns a real header row is missing rather than describing row 1 of
 * a file whose header is on row 3.
 */
export function findHeaderBand(rows: SheetRow[]): HeaderBand | null {
  if (rows.length === 0) return null;

  const limit = Math.min(rows.length, MAX_HEADER_SCAN_ROWS);
  let best: { band: HeaderBand; score: number } | null = null;

  for (let start = 0; start < limit; start++) {
    for (let depth = 1; depth <= MAX_HEADER_BAND_DEPTH; depth++) {
      if (start + depth > rows.length) break;

      const raw = mergeBand(rows, start, depth);
      if (raw.size === 0) continue;

      const resolved = resolveColumns(raw);
      const headers = new Map<number, string>();
      for (const [index, text] of raw) headers.set(index, normalizeHeader(text));

      const band: HeaderBand = {
        startIndex: start,
        depth,
        dataIndex: start + depth,
        headers,
        raw,
      };

      if (resolved.missing.length === 0) return band;

      const score = REQUIRED_COLUMNS.length - resolved.missing.length;
      if (!best || score > best.score) best = { band, score };
    }
  }

  return best?.band ?? null;
}

/** Every cell of the header band and of the rows above it, lowercased. */
function headerRegionText(rows: SheetRow[], band: HeaderBand): string {
  const parts: string[] = [];
  for (let index = 0; index < band.startIndex + band.depth && index < rows.length; index++) {
    for (const value of rows[index].cells.values()) parts.push(value);
  }
  return normalizeHeader(parts.join(' '));
}

export type SheetVerdict =
  /** The name says lunch. Used exactly as before, with no confirmation. */
  | { kind: 'named' }
  /** Menu-shaped AND says lunch, but not named for it. Needs confirmation. */
  | { kind: 'candidate'; signals: string[] }
  /** Says dinner somewhere that matters. Never a candidate. */
  | { kind: 'dinner' }
  /** Not identifiable as a lunch menu. */
  | { kind: 'unidentified' };

/**
 * Decide what a worksheet is, from its name and its own content.
 *
 * `parseDate` is injected rather than imported so this module stays free of the
 * menu importer's date rules while still being able to ask "do these rows carry
 * dates?" - the check that separates a real menu from a blank template.
 */
export function classifyWorksheet(
  name: string,
  rows: SheetRow[],
  parseDate: (raw: string) => string | null
): SheetVerdict {
  const sheetName = normalizeHeader(name);
  if (DINNER_PATTERN.test(sheetName)) return { kind: 'dinner' };
  if (LUNCH_PATTERN.test(sheetName)) return { kind: 'named' };

  const band = findHeaderBand(rows);
  if (!band) return { kind: 'unidentified' };

  const resolved = resolveColumns(band.raw);
  if (resolved.missing.length > 0) return { kind: 'unidentified' };

  // Content, not just the tab name: a sheet called "Page 1" whose title cell
  // reads "Dinner" is a dinner sheet.
  const region = headerRegionText(rows, band);
  if (DINNER_PATTERN.test(region)) return { kind: 'dinner' };

  const signals: string[] = [];
  if (LUNCH_PATTERN.test(region)) {
    signals.push('the worksheet says "lunch" above or in its column headers');
  }

  // Structure alone is never enough. Requirement: no worksheet is treated as
  // lunch merely because it looks like a table of two options per day.
  if (signals.length === 0) return { kind: 'unidentified' };

  const dateColumn = resolved.columns.get('meal_date')!;
  let dated = 0;
  const probeEnd = Math.min(rows.length, band.dataIndex + DATE_PROBE_ROWS);
  for (let index = band.dataIndex; index < probeEnd; index++) {
    const cell = rows[index].cells.get(dateColumn);
    if (cell && parseDate(cell.trim())) dated += 1;
  }
  if (dated < MIN_DATED_ROWS) return { kind: 'unidentified' };

  signals.push(
    `its header row names Date, Option 1 and Option 2, and ${dated} row(s) below carry real dates`
  );
  return { kind: 'candidate', signals };
}

/** Which worksheet the import will read, and on whose authority. */
export type LunchSheetSelection =
  | { name: string; source: 'named'; signals?: undefined }
  | { name: string; source: 'candidate'; signals: string[] }
  | { error: string };

/**
 * Choose the lunch worksheet by NAME alone.
 *
 * Unchanged in behaviour from the original: the single sheet whose name
 * mentions lunch wins; two of them is an error; a lone sheet named plainly
 * "menu" is accepted only when nothing mentions dinner. `undecided` means the
 * names settle nothing and the sheets themselves must be looked at.
 */
export function chooseLunchSheet(
  names: string[]
): { name: string } | { error: string } | { undecided: true } {
  const normalized = names.map((name) => ({ name, key: normalizeHeader(name) }));
  const lunch = normalized.filter((s) => LUNCH_PATTERN.test(s.key));

  if (lunch.length === 1) return { name: lunch[0].name };
  if (lunch.length > 1) {
    return {
      error:
        `This workbook has more than one lunch sheet (${lunch.map((s) => s.name).join(', ')}). ` +
        'Leave a single lunch sheet in the file and upload it again.',
    };
  }

  const mentionsDinner = normalized.some((s) => DINNER_PATTERN.test(s.key));
  const plainMenu = normalized.filter((s) => s.key === 'menu' || s.key.includes('menu'));
  if (!mentionsDinner && plainMenu.length === 1) return { name: plainMenu[0].name };

  return { undecided: true };
}

/** The message shown when nothing in the workbook is a lunch menu. */
export function noLunchSheetError(names: string[]): string {
  return (
    'No lunch worksheet was found. Name the lunch sheet "Lunch" (this import never ' +
    `guesses, so a dinner sheet is not read as lunch). This workbook contains: ${
      names.join(', ') || 'no sheets'
    }.`
  );
}

/**
 * Inspect the sheets the names could not settle, and return at most one
 * candidate.
 *
 * `load` is injected so this stays a pure decision over already-parsed rows:
 * `menu.ts` supplies the real reader, and a test can supply rows directly.
 */
export async function findCandidateSheet(
  names: string[],
  load: (name: string) => Promise<SheetRow[]>,
  parseDate: (raw: string) => string | null
): Promise<LunchSheetSelection> {
  const candidates: Array<{ name: string; signals: string[] }> = [];

  for (const name of names.slice(0, MAX_SHEETS_EXAMINED)) {
    // Cheap exclusion first: a dinner sheet is never opened looking for lunch.
    if (DINNER_PATTERN.test(normalizeHeader(name))) continue;

    let rows: SheetRow[];
    try {
      rows = await load(name);
    } catch {
      // A sheet that will not parse is simply not a candidate. The workbook's
      // real error, if there is one, is reported by the reader downstream.
      continue;
    }

    const verdict = classifyWorksheet(name, rows, parseDate);
    if (verdict.kind === 'candidate') candidates.push({ name, signals: verdict.signals });
  }

  if (candidates.length === 1) {
    return { name: candidates[0].name, source: 'candidate', signals: candidates[0].signals };
  }

  if (candidates.length > 1) {
    return {
      error:
        `More than one worksheet in this workbook looks like a lunch menu (${candidates
          .map((c) => c.name)
          .join(', ')}). This import will not choose between them: rename the intended ` +
        'lunch sheet to "Lunch" and upload the workbook again.',
    };
  }

  return { error: noLunchSheetError(names) };
}
