/**
 * Build a synthetic .xlsx in memory for tests.
 *
 * Writes a real ZIP with real SpreadsheetML, so the production reader parses a
 * genuine workbook rather than a convenient stub. Uses STORED (uncompressed)
 * entries, which is valid ZIP and keeps the builder small.
 *
 * Every value used by the tests is synthetic. No real employee name, AMCO ID,
 * department or roster value from the source workbook appears here or anywhere
 * in the repository.
 */

const encoder = new TextEncoder();

/** CRC-32, required by the ZIP format. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  data: Uint8Array;
}

function buildZip(entries: Entry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint32(14, crc, true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    chunks.push(local, entry.data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true); // method: stored
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const all = [...chunks, ...central, eocd];
  const total = all.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of all) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface SheetSpec {
  name: string;
  /** Rows of cell values. `null` leaves the cell absent entirely. */
  rows: Array<Array<string | null>>;
}

/**
 * Build a workbook. Cells are written as inline strings, which is valid
 * SpreadsheetML and exercises the reader's inlineStr path.
 */
export function buildWorkbook(sheets: SheetSpec[]): Uint8Array {
  const colName = (index: number): string => {
    let name = '';
    let n = index + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  };

  const sheetEntries: Entry[] = sheets.map((sheet, index) => {
    const rowsXml = sheet.rows
      .map((cells, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const cellsXml = cells
          .map((value, colIndex) => {
            if (value === null) return '';
            const ref = `${colName(colIndex)}${rowNumber}`;
            return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
          })
          .join('');
        return `<row r="${rowNumber}">${cellsXml}</row>`;
      })
      .join('');

    return {
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`
      ),
    };
  });

  const sheetTags = sheets
    .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');

  const relTags = sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join('');

  return buildZip([
    {
      name: '[Content_Types].xml',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relTags}</Relationships>`
      ),
    },
    ...sheetEntries,
  ]);
}

/** The header row the real workbook uses, for fixtures that need it. */
export const EMPLOYEE_HEADERS = ['AMCO ID#', 'Name', 'Department', 'Section', 'Roster'];

/**
 * A synthetic employee workbook. All values invented for tests.
 */
export function buildEmployeeWorkbook(
  rows: Array<Array<string | null>>,
  { sheetName = 'All Employees', headers = EMPLOYEE_HEADERS }: { sheetName?: string; headers?: string[] } = {}
): Uint8Array {
  return buildWorkbook([{ name: sheetName, rows: [headers, ...rows] }]);
}

/**
 * Header row for the wide-month shift roster sheet: the three identity columns
 * followed by one column per day of the month.
 */
export function rosterHeaders(days = 31): string[] {
  return ['code', 'month', 'year', ...Array.from({ length: days }, (_, i) => String(i + 1))];
}

/**
 * A synthetic shift roster workbook in the real wide-month shape.
 *
 * Each row is `[code, month, year, ...dayValues]`; a null or '' day cell is
 * written as a genuinely empty cell, which is how "this workbook says nothing
 * about that date" is expressed.
 */
export function buildRosterWorkbook(
  rows: Array<Array<string | null>>,
  {
    sheetName = 'Shifts roster',
    headers = rosterHeaders(),
  }: { sheetName?: string; headers?: string[] } = {}
): Uint8Array {
  return buildWorkbook([{ name: sheetName, rows: [headers, ...rows] }]);
}

/**
 * Build one roster row from a map of day number -> shift value, so a test can
 * say "day 3 is Night" without writing 31 cells.
 */
export function rosterRow(
  code: string,
  month: string | number,
  year: string | number,
  days: Record<number, string>,
  dayCount = 31
): Array<string | null> {
  const cells: Array<string | null> = [code, String(month), String(year)];
  for (let day = 1; day <= dayCount; day += 1) {
    cells.push(days[day] ?? null);
  }
  return cells;
}
