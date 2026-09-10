/**
 * Minimal XLSX reader.
 *
 * WHY NOT A LIBRARY: an .xlsx is a ZIP of XML, and the Workers runtime already
 * provides DEFLATE via DecompressionStream. Pulling in SheetJS (~400 kB) to read
 * five string columns would put a large parser inside a Worker whose free-tier
 * CPU budget is 10 ms per request. This reads the specific SpreadsheetML subset
 * the importers need, with no dependency at all.
 *
 * SECURITY: workbook contents are untrusted data, never code.
 *   - Only cell VALUES are read (<v> and inline <is>). Formula elements (<f>)
 *     are never read and never evaluated - a cell containing a formula yields
 *     its cached value or nothing.
 *   - Macros (vbaProject.bin) are never opened; .xlsm is accepted as a container
 *     but its macro payload is simply not read.
 *   - Entry sizes are bounded so a zip bomb cannot exhaust memory.
 *
 * SCOPE: this reads worksheets of string/number/boolean cells. It does not
 * implement styles, date formatting, merged cells, or streaming for very large
 * sheets - none of which the employee workbook needs.
 */

/** Refuse absurd expansion: 64 MB inflated across all entries we read. */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export class XlsxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XlsxError';
  }
}

interface ZipEntry {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function readU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}
function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * Parse the ZIP central directory.
 *
 * Reading the central directory rather than scanning local headers means we get
 * authoritative sizes and never have to guess at data-descriptor layouts.
 */
function readCentralDirectory(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // End-of-central-directory signature, searched from the end (the comment
  // field is variable length, so its position is not fixed).
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const searchFrom = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= searchFrom; i--) {
    if (readU32(view, i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new XlsxError('This file is not a readable Excel workbook.');
  }

  const entryCount = readU16(view, eocd + 10);
  let offset = readU32(view, eocd + 16);

  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();

  for (let i = 0; i < entryCount; i++) {
    if (readU32(view, offset) !== 0x02014b50) break; // central file header sig

    const compressionMethod = readU16(view, offset + 10);
    const compressedSize = readU32(view, offset + 20);
    const uncompressedSize = readU32(view, offset + 24);
    const nameLength = readU16(view, offset + 28);
    const extraLength = readU16(view, offset + 30);
    const commentLength = readU16(view, offset + 32);
    const localHeaderOffset = readU32(view, offset + 42);

    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    entries.set(name, {
      name,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Inflate one ZIP entry to text. */
async function readEntry(bytes: Uint8Array, entry: ZipEntry): Promise<string> {
  if (entry.uncompressedSize > MAX_INFLATED_BYTES) {
    throw new XlsxError('The workbook contains an unexpectedly large part and was not read.');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const local = entry.localHeaderOffset;

  if (readU32(view, local) !== 0x04034b50) {
    throw new XlsxError('This file is not a readable Excel workbook.');
  }

  const nameLength = readU16(view, local + 26);
  const extraLength = readU16(view, local + 28);
  const dataStart = local + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  // Method 0 = stored, 8 = deflate. Anything else is not something Excel writes.
  if (entry.compressionMethod === 0) {
    return new TextDecoder().decode(compressed);
  }
  if (entry.compressionMethod !== 8) {
    throw new XlsxError('The workbook uses an unsupported compression method.');
  }

  const stream = new Blob([compressed as unknown as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));

  const inflated = await new Response(stream).arrayBuffer();
  if (inflated.byteLength > MAX_INFLATED_BYTES) {
    throw new XlsxError('The workbook contains an unexpectedly large part and was not read.');
  }

  return new TextDecoder().decode(inflated);
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeXmlText(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

/** Concatenate every <t> run inside a shared-string or inline-string element. */
function textRuns(xml: string): string {
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    out += match[1] === undefined ? '' : decodeXmlText(match[1]);
  }
  return out;
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    strings.push(match[1] === undefined ? '' : textRuns(match[1]));
  }
  return strings;
}

/** Convert a cell reference like "AB12" to a zero-based column index. */
export function columnIndex(cellRef: string): number {
  const letters = /^([A-Z]+)/.exec(cellRef.toUpperCase())?.[1] ?? '';
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

export interface SheetRow {
  /** 1-based row number, exactly as the administrator sees it in Excel. */
  rowNumber: number;
  /** Cell values by zero-based column index. Absent columns are simply missing. */
  cells: Map<number, string>;
}

export interface Worksheet {
  name: string;
  rows: SheetRow[];
}

function parseSheet(xml: string, sharedStrings: string[], name: string): Worksheet {
  const rows: SheetRow[] = [];

  const rowRe = /<row(?:\s([^>]*))?>([\s\S]*?)<\/row>|<row\s([^>]*)\/>/g;
  let rowMatch: RegExpExecArray | null;
  let fallbackRowNumber = 0;

  while ((rowMatch = rowRe.exec(xml)) !== null) {
    const attrs = rowMatch[1] ?? rowMatch[3] ?? '';
    const body = rowMatch[2] ?? '';
    fallbackRowNumber += 1;

    const declared = /\br="(\d+)"/.exec(attrs)?.[1];
    const rowNumber = declared ? Number(declared) : fallbackRowNumber;

    const cells = new Map<number, string>();
    const cellRe = /<c(?:\s([^>]*))?>([\s\S]*?)<\/c>|<c\s([^>]*)\/>/g;
    let cellMatch: RegExpExecArray | null;
    let fallbackCol = 0;

    while ((cellMatch = cellRe.exec(body)) !== null) {
      const cellAttrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const cellBody = cellMatch[2] ?? '';

      const ref = /\br="([A-Z]+\d+)"/i.exec(cellAttrs)?.[1];
      const col = ref ? columnIndex(ref) : fallbackCol;
      fallbackCol = col + 1;

      const type = /\bt="([^"]+)"/.exec(cellAttrs)?.[1] ?? 'n';

      let value = '';
      if (type === 'inlineStr') {
        value = textRuns(cellBody);
      } else {
        // Only the cached VALUE is read. A <f> formula element is ignored
        // entirely and never evaluated.
        const raw = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cellBody)?.[1];
        if (raw !== undefined) {
          const decoded = decodeXmlText(raw);
          if (type === 's') {
            const index = Number(decoded);
            value = Number.isInteger(index) ? (sharedStrings[index] ?? '') : '';
          } else if (type === 'b') {
            value = decoded === '1' ? 'TRUE' : 'FALSE';
          } else {
            value = decoded;
          }
        }
      }

      if (value !== '') cells.set(col, value);
    }

    rows.push({ rowNumber, cells });
  }

  return { name, rows };
}

/**
 * Read one worksheet by name.
 *
 * Sheet names are matched case-insensitively and whitespace-trimmed, because a
 * workbook saved by a person may well have a stray space.
 */
/**
 * List the worksheet names a workbook declares, in workbook order.
 *
 * Exists so a caller can CHOOSE a sheet rather than guess at its name. A menu
 * workbook may hold both a lunch and a dinner sheet, and silently falling back
 * to "the first sheet" is how a dinner menu gets imported as lunch.
 */
export async function listWorksheets(file: ArrayBuffer): Promise<string[]> {
  const bytes = new Uint8Array(file);
  const entries = readCentralDirectory(bytes);

  const workbookEntry = entries.get('xl/workbook.xml');
  if (!workbookEntry) {
    throw new XlsxError('This file is not a readable Excel workbook.');
  }

  const workbookXml = await readEntry(bytes, workbookEntry);
  const names: string[] = [];
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = sheetRe.exec(workbookXml)) !== null) {
    names.push(decodeXmlText(/\bname="([^"]*)"/.exec(match[1])?.[1] ?? ''));
  }
  return names;
}

export async function readWorksheet(file: ArrayBuffer, sheetName: string): Promise<Worksheet> {
  const bytes = new Uint8Array(file);
  const entries = readCentralDirectory(bytes);

  const workbookEntry = entries.get('xl/workbook.xml');
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relsEntry) {
    throw new XlsxError('This file is not a readable Excel workbook.');
  }

  const workbookXml = await readEntry(bytes, workbookEntry);
  const relsXml = await readEntry(bytes, relsEntry);

  const relTargets = new Map<string, string>();
  const relRe = /<Relationship\b([^>]*)\/?>/g;
  let relMatch: RegExpExecArray | null;
  while ((relMatch = relRe.exec(relsXml)) !== null) {
    const attrs = relMatch[1];
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1];
    if (id && target) relTargets.set(id, target);
  }

  const wanted = sheetName.trim().toLowerCase();
  const sheetRe = /<sheet\b([^>]*)\/?>/g;
  let sheetMatch: RegExpExecArray | null;
  let target: string | null = null;
  let matchedName = sheetName;
  const available: string[] = [];

  while ((sheetMatch = sheetRe.exec(workbookXml)) !== null) {
    const attrs = sheetMatch[1];
    const name = decodeXmlText(/\bname="([^"]*)"/.exec(attrs)?.[1] ?? '');
    available.push(name);
    if (name.trim().toLowerCase() !== wanted) continue;

    const relId = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    const relTarget = relId ? relTargets.get(relId) : undefined;
    if (relTarget) {
      target = relTarget.startsWith('/') ? relTarget.slice(1) : relTarget;
      if (!target.startsWith('xl/')) target = `xl/${target}`;
      matchedName = name;
    }
    break;
  }

  if (!target) {
    throw new XlsxError(
      `Required worksheet "${sheetName}" not found. This workbook contains: ${available.join(', ') || 'no sheets'}.`
    );
  }

  const sheetEntry = entries.get(target);
  if (!sheetEntry) {
    throw new XlsxError(`Required worksheet "${sheetName}" could not be read.`);
  }

  const sharedEntry = entries.get('xl/sharedStrings.xml');
  const sharedStrings = sharedEntry ? parseSharedStrings(await readEntry(bytes, sharedEntry)) : [];

  return parseSheet(await readEntry(bytes, sheetEntry), sharedStrings, matchedName);
}

/**
 * Normalize a header cell for matching: trim, strip a BOM and zero-width
 * characters, collapse internal whitespace, and lowercase.
 *
 * Real workbooks contain headers with trailing spaces and the occasional
 * invisible character; matching on the raw string would reject a perfectly
 * good file for a reason nobody can see.
 */
export function normalizeHeader(value: string): string {
  return value
    .replace(/^﻿/, '')
    .replace(/[​-‍⁠]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Trim a cell value and collapse internal whitespace runs. */
export function normalizeCell(value: string | undefined): string {
  if (value === undefined) return '';
  return value.replace(/[​-‍⁠]/g, '').replace(/\s+/g, ' ').trim();
}
