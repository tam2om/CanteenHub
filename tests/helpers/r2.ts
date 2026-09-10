/**
 * In-memory R2 test double.
 *
 * Implements the subset of the Workers R2Bucket interface the import foundation
 * actually uses (put / get / head / delete / list), storing objects in a Map.
 * Tests therefore exercise the real production code path - the same
 * `c.env.IMPORTS.put(...)` call - rather than skipping storage behaviour.
 *
 * LIMITATION, stated plainly: this is not workerd's R2 implementation. It does
 * not reproduce R2's consistency model, multipart uploads, conditional requests
 * or range reads. It verifies that the correct key is written, that the bytes
 * and metadata round-trip, and that failures are handled - which is the whole of
 * what this slice's code depends on.
 */

import type { R2Bucket } from '@cloudflare/workers-types';

interface StoredObject {
  key: string;
  body: ArrayBuffer;
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
  uploaded: Date;
}

export interface TestR2Bucket {
  /** Every object currently stored, keyed by object key. */
  readonly objects: Map<string, StoredObject>;
  /** Force the next put() to reject, to exercise the failure path. */
  failNextPut(message?: string): void;
  /** Force get() to behave as though the object vanished. */
  failNextGet(): void;
  put(key: string, value: ArrayBuffer | Uint8Array, options?: unknown): Promise<unknown>;
  get(key: string): Promise<unknown>;
  head(key: string): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<{ objects: Array<{ key: string }> }>;
}

export function createTestR2(): TestR2Bucket & R2Bucket {
  const objects = new Map<string, StoredObject>();
  let putFailure: string | null = null;
  let getShouldFail = false;

  const bucket: TestR2Bucket = {
    objects,

    failNextPut(message = 'Simulated R2 failure') {
      putFailure = message;
    },

    failNextGet() {
      getShouldFail = true;
    },

    async put(key, value, options) {
      if (putFailure) {
        const message = putFailure;
        putFailure = null;
        throw new Error(message);
      }

      const body =
        value instanceof Uint8Array
          ? (value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength
            ) as ArrayBuffer)
          : value;

      const opts = (options ?? {}) as {
        httpMetadata?: Record<string, unknown>;
        customMetadata?: Record<string, string>;
      };

      const stored: StoredObject = {
        key,
        body,
        httpMetadata: opts.httpMetadata,
        customMetadata: opts.customMetadata,
        uploaded: new Date(),
      };

      objects.set(key, stored);
      return { key, size: body.byteLength, uploaded: stored.uploaded };
    },

    async get(key) {
      if (getShouldFail) {
        getShouldFail = false;
        return null;
      }

      const stored = objects.get(key);
      if (!stored) return null;

      return {
        key: stored.key,
        size: stored.body.byteLength,
        uploaded: stored.uploaded,
        httpMetadata: stored.httpMetadata,
        customMetadata: stored.customMetadata,
        arrayBuffer: async () => stored.body,
        text: async () => new TextDecoder().decode(stored.body),
      };
    },

    async head(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        key: stored.key,
        size: stored.body.byteLength,
        uploaded: stored.uploaded,
        customMetadata: stored.customMetadata,
      };
    },

    async delete(key) {
      objects.delete(key);
    },

    async list(options) {
      const prefix = options?.prefix ?? '';
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
      };
    },
  };

  return bucket as unknown as TestR2Bucket & R2Bucket;
}

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
