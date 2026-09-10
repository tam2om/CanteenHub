/**
 * Upload validation and R2 object-key derivation for imports.
 *
 * Uploaded workbooks are untrusted input. Nothing here parses spreadsheet
 * content - it establishes only that the bytes are plausibly the file type the
 * future parsers will consume, and that they are small enough to handle. No
 * macro is executed, no formula is evaluated, and the workbook is never treated
 * as code.
 */

export const IMPORT_TYPES = ['employees', 'roster', 'menu'] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

/**
 * 10 MB. A realistic employee/roster/menu workbook is well under 1 MB; this is
 * a generous ceiling that still bounds what a single request can push into R2.
 */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const ALLOWED_EXTENSIONS = ['.xlsx', '.xlsm'] as const;

/**
 * .xlsx and .xlsm are ZIP containers, so every valid workbook starts with the
 * ZIP local-file-header magic "PK\x03\x04". Checking it means a renamed .exe or
 * a text file with a spreadsheet extension is rejected on content rather than
 * on the attacker-controlled filename.
 *
 * This is a cheap sanity gate, not a full format validation - the per-type
 * parsers in later slices do the real structural work.
 */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** The legacy .xls (OLE2) magic, recognised only so we can refuse it clearly. */
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];

export function isImportType(value: unknown): value is ImportType {
  return typeof value === 'string' && (IMPORT_TYPES as readonly string[]).includes(value);
}

export interface FileValidationResult {
  valid: boolean;
  error?: string;
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((byte, index) => bytes[index] === byte);
}

/**
 * Validate an uploaded file's name, size and leading bytes.
 * Returns a message written for the administrator, never a stack trace.
 */
export function validateUploadedFile(
  filename: string,
  bytes: Uint8Array
): FileValidationResult {
  if (!filename || typeof filename !== 'string') {
    return { valid: false, error: 'A file is required.' };
  }

  const lower = filename.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return {
      valid: false,
      error: `Unsupported file type. Upload one of: ${ALLOWED_EXTENSIONS.join(', ')}`,
    };
  }

  if (bytes.length === 0) {
    return { valid: false, error: 'The uploaded file is empty.' };
  }

  if (bytes.length > MAX_UPLOAD_BYTES) {
    const limitMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
    return { valid: false, error: `The file is larger than the ${limitMb} MB limit.` };
  }

  if (startsWith(bytes, OLE2_MAGIC)) {
    return {
      valid: false,
      error: 'This looks like a legacy .xls workbook. Save it as .xlsx and upload again.',
    };
  }

  if (!startsWith(bytes, ZIP_MAGIC)) {
    return {
      valid: false,
      error: 'This file is not a valid Excel workbook, whatever its name suggests.',
    };
  }

  return { valid: true };
}

/**
 * SHA-256 of the uploaded bytes, via WebCrypto (available in Workers).
 *
 * Stored as metadata to help an administrator notice an accidental duplicate
 * upload. It is deliberately NOT the import's identity and does NOT reject
 * duplicates: re-uploading the same corrected workbook is a legitimate retry.
 */
export async function hashFileContents(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Deterministic R2 object key for a batch.
 *
 * Derived from the import type and the batch id ONLY. The uploaded filename
 * never reaches the key, so a name like `../../etc/passwd` or one containing a
 * slash cannot steer where the object is written. Being deterministic also
 * means an interrupted upload can be located and reconciled from the batch row
 * alone, rather than being an orphan nobody can find.
 */
export function importObjectKey(importType: ImportType, batchId: number): string {
  return `imports/${importType}/${batchId}/source.xlsx`;
}
