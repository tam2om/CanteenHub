// @vitest-environment node
/**
 * Unit tests - the XLSX reader's element scanning.
 *
 * These exist because of a real defect. Excel writes an empty-but-styled cell
 * inside a merged region as a self-closing `<c r="D2" s="13"/>`, and the
 * reader's single alternating regular expression merged such a cell with the
 * one that FOLLOWED it: the empty cell inherited the next cell's `<v>` while
 * taking its own attributes, so with no `t="s"` to resolve it a shared-string
 * INDEX was emitted as the value and the real cell vanished.
 *
 * On the real September menu workbook that turned the header row into
 * `Day | Date | Lunch Menu | "4"` with "Option 1" missing entirely - and it
 * could equally have put the number 17 into a dish name. Every fixture here
 * writes blanks the way Excel does, because a fixture that omits them cannot
 * reproduce the fault.
 */

import { describe, it, expect } from 'vitest';
import { listWorksheets, readWorksheet } from '../../src/worker/lib/xlsx.js';
import { buildWorkbook } from '../helpers/xlsxFixture.js';

const asBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const read = async (rows: Array<Array<string | null>>, styledBlanks = true) => {
  const bytes = buildWorkbook([{ name: 'Sheet', rows, styledBlanks }]);
  return readWorksheet(asBuffer(bytes), 'Sheet');
};

describe('XLSX reader - self-closing elements', () => {
  it('does not let an empty cell swallow the cell after it', async () => {
    const sheet = await read([['A', null, 'C']]);
    const cells = sheet.rows[0].cells;

    expect(cells.get(0)).toBe('A');
    expect(cells.has(1)).toBe(false);
    // The bug put the FOLLOWING cell's raw value here and dropped column 2.
    expect(cells.get(2)).toBe('C');
  });

  it('keeps every column when blanks and values alternate', async () => {
    const sheet = await read([[null, 'B', null, 'D', null, 'F']]);
    expect([...sheet.rows[0].cells.entries()]).toEqual([
      [1, 'B'],
      [3, 'D'],
      [5, 'F'],
    ]);
  });

  it('reads a two-row merged header exactly as written', async () => {
    // The real workbook's shape: group labels above, column labels below.
    const sheet = await read([
      ['Lunch', null, null, null],
      ['Day', 'Date', 'Lunch Menu', null],
      [null, null, 'Option 1', 'Option 2'],
    ]);

    expect([...sheet.rows[1].cells.entries()]).toEqual([
      [0, 'Day'],
      [1, 'Date'],
      [2, 'Lunch Menu'],
    ]);
    expect([...sheet.rows[2].cells.entries()]).toEqual([
      [2, 'Option 1'],
      [3, 'Option 2'],
    ]);
  });

  it('never emits a shared-string index as a cell value', async () => {
    const sheet = await read([
      [null, 'Real Text One', null, 'Real Text Two'],
      ['Row Two', null, 'Row Two C', null],
    ]);

    const values = sheet.rows.flatMap((r) => [...r.cells.values()]);
    expect(values).toEqual(['Real Text One', 'Real Text Two', 'Row Two', 'Row Two C']);
    // A bare small integer is the signature of the fault.
    expect(values.some((v) => /^\d{1,3}$/.test(v))).toBe(false);
  });

  it('does not let an empty row swallow the row after it', async () => {
    const sheet = await read([['Header'], [], ['Data']]);

    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows[0].cells.get(0)).toBe('Header');
    expect(sheet.rows[1].cells.size).toBe(0);
    expect(sheet.rows[2].cells.get(0)).toBe('Data');
    expect(sheet.rows[2].rowNumber).toBe(3);
  });

  it('preserves declared row numbers across self-closing rows', async () => {
    const sheet = await read([['A'], [], [], ['D']]);
    expect(sheet.rows.map((r) => r.rowNumber)).toEqual([1, 2, 3, 4]);
  });

  it('still reads a sheet whose blanks are simply omitted', async () => {
    // The other spelling must keep working: both are valid SpreadsheetML.
    const sheet = await read([['A', null, 'C']], false);
    expect(sheet.rows[0].cells.get(0)).toBe('A');
    expect(sheet.rows[0].cells.get(2)).toBe('C');
  });

  it('lists worksheets unchanged', async () => {
    const bytes = buildWorkbook([
      { name: 'Lunch', rows: [['A', null]], styledBlanks: true },
      { name: 'Dinner', rows: [['B']] },
    ]);
    expect(await listWorksheets(asBuffer(bytes))).toEqual(['Lunch', 'Dinner']);
  });
});
