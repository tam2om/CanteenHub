/**
 * Synthetic upload bytes.
 *
 * CanteenHub has no object store: an uploaded workbook is validated in the
 * request that carries it and is never persisted. These helpers therefore build
 * the bytes a test POSTs, and nothing more - there is no storage double to
 * stand in for, because there is no storage.
 *
 * Every value here is invented. No real workbook appears in this repository.
 */

/**
 * Minimal bytes that pass the upload check: the ZIP local-file-header magic
 * that every .xlsx begins with, plus padding. Synthetic - no real workbook.
 */
export function fakeXlsxBytes(padding = 64): Uint8Array {
  const bytes = new Uint8Array(4 + padding);
  bytes.set([0x50, 0x4b, 0x03, 0x04], 0); // "PK\x03\x04"
  for (let i = 4; i < bytes.length; i++) bytes[i] = i % 251;
  return bytes;
}

/** Bytes that are NOT a ZIP container, for rejection tests. */
export function notAZipFile(): Uint8Array {
  return new TextEncoder().encode('This is plain text pretending to be a spreadsheet.');
}

/** The legacy .xls OLE2 magic, for the "save as .xlsx" rejection test. */
export function legacyXlsBytes(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0], 0);
  return bytes;
}
