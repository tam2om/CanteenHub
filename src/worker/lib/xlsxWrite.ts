/**
 * Minimal XLSX writer.
 *
 * WHY NOT A LIBRARY: the same reasoning as the reader in `xlsx.ts`. An .xlsx is
 * a ZIP of XML, and writing the small subset a report needs - a few sheets of
 * strings and numbers with a bold header row - is far less code than the parser
 * already here, with no dependency inside a Worker whose CPU budget is small.
 *
 * WHAT IT PRODUCES: a workbook Excel, LibreOffice, Numbers and Google Sheets all
 * open. Sheets of inline strings and numbers, an optional bold first row, and
 * column widths. No formulas, no styles beyond bold, no charts, no images -
 * none of which a portion count needs.
 *
 * ENTRIES ARE STORED, NOT DEFLATED. Valid ZIP, and it keeps this file small. A
 * daily report is a few hundred rows; the size difference does not matter and
 * the CPU saved does.
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

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function buildZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // stored
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
    cv.setUint16(10, 0, true);
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

/**
 * Escape text for XML, and drop the control characters XML forbids.
 *
 * A dish name or a department typed by a person can contain anything; a
 * workbook Excel refuses to open is worse than one missing a stray byte.
 */
function escapeXml(value: string): string {
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** A cell: a string, a number, or nothing at all. */
export type CellValue = string | number | null | undefined;

export interface SheetInput {
  /**
   * The tab name. Excel forbids : \ / ? * [ ] and caps the length at 31, so the
   * name is sanitised rather than producing a file that will not open.
   */
  name: string;
  /** The first row is rendered bold when `headerRow` is true (the default). */
  rows: CellValue[][];
  headerRow?: boolean;
  /** Column widths in characters. Missing entries fall back to Excel's own. */
  columnWidths?: number[];
}

/** Excel's own restrictions on a sheet name, applied rather than discovered. */
function safeSheetName(name: string, index: number): string {
  const cleaned = name.replace(/[:\\/?*\[\]]/g, ' ').trim().slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

function sheetXml(sheet: SheetInput): string {
  const headerRow = sheet.headerRow !== false;

  const cols = sheet.columnWidths?.length
    ? `<cols>${sheet.columnWidths
        .map(
          (width, i) =>
            `<col min="${i + 1}" max="${i + 1}" width="${Math.max(4, width)}" customWidth="1"/>`
        )
        .join('')}</cols>`
    : '';

  const rowsXml = sheet.rows
    .map((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;
      // Style 1 is the bold format declared in styles.xml below.
      const style = headerRow && rowIndex === 0 ? ' s="1"' : '';

      const cellsXml = cells
        .map((value, colIndex) => {
          if (value === null || value === undefined || value === '') return '';
          const ref = `${columnName(colIndex)}${rowNumber}`;
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${ref}"${style}><v>${value}</v></c>`;
          }
          return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${escapeXml(
            String(value)
          )}</t></is></c>`;
        })
        .join('');

      return `<row r="${rowNumber}"${style}>${cellsXml}</row>`;
    })
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `${cols}<sheetData>${rowsXml}</sheetData></worksheet>`
  );
}

/**
 * Build a workbook.
 *
 * Returns the bytes; the caller decides what to do with them. Nothing is
 * written to any store - there is none.
 */
export function buildXlsx(sheets: SheetInput[]): Uint8Array {
  if (sheets.length === 0) {
    throw new Error('A workbook needs at least one sheet');
  }

  const named = sheets.map((sheet, index) => ({
    ...sheet,
    name: safeSheetName(sheet.name, index),
  }));

  const sheetEntries: ZipEntry[] = named.map((sheet, index) => ({
    name: `xl/worksheets/sheet${index + 1}.xml`,
    data: encoder.encode(sheetXml(sheet)),
  }));

  const sheetTags = named
    .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');

  const relTags = named
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join('');

  const overrides = named
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join('');

  return buildZip([
    {
      name: '[Content_Types].xml',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
          `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
          `${overrides}</Types>`
      ),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
          `</Relationships>`
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          `<sheets>${sheetTags}</sheets></workbook>`
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `${relTags}` +
          `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          `</Relationships>`
      ),
    },
    {
      // Two formats: 0 is the default, 1 is bold. That is the whole style sheet.
      name: 'xl/styles.xml',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
          `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
          `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
          `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
          `<borders count="1"><border/></borders>` +
          `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
          `<cellXfs count="2">` +
          `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
          `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
          `</cellXfs></styleSheet>`
      ),
    },
    ...sheetEntries,
  ]);
}

/** The media type Excel expects for an .xlsx download. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
