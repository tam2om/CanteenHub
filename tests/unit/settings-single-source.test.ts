// @vitest-environment node
/**
 * Guard - one settings implementation, not two.
 *
 * `src/worker/db/settings.ts` used to shadow `services/settings.service.ts`. It
 * was unreachable from the Worker entrypoint, so it never ran, but it carried
 * its own `isCutoffPassed` that hard-coded '10:00' and compared in UTC - exactly
 * the timezone defect Phase 2 fixed. A developer importing the wrong module
 * would have silently reintroduced it.
 *
 * These tests fail if a second settings implementation reappears, rather than
 * relying on a reviewer noticing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const AUTHORITATIVE = 'src/worker/services/settings.service.ts';

function allTypeScriptFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...allTypeScriptFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = allTypeScriptFiles(SRC_DIR).map((f) => ({
  rel: path.relative(REPO_ROOT, f).split(path.sep).join('/'),
  text: readFileSync(f, 'utf8'),
}));

describe('settings has a single source of truth', () => {
  it('the authoritative settings service exists', () => {
    expect(existsSync(path.join(REPO_ROOT, AUTHORITATIVE))).toBe(true);
  });

  it('the removed duplicate has not come back', () => {
    expect(existsSync(path.join(REPO_ROOT, 'src/worker/db/settings.ts'))).toBe(false);
  });

  it('exactly one module implements isCutoffPassed', () => {
    const implementers = sourceFiles
      .filter((f) => /export\s+(async\s+)?function\s+isCutoffPassed\b/.test(f.text))
      .map((f) => f.rel);

    expect(implementers).toEqual([AUTHORITATIVE]);
  });

  it('exactly one module implements the cutoff and timezone readers', () => {
    for (const symbol of ['getCutoffMinutes', 'getTimezone', 'getCurrentBusinessDate']) {
      const implementers = sourceFiles
        .filter((f) => new RegExp(`export\\s+(async\\s+)?function\\s+${symbol}\\b`).test(f.text))
        .map((f) => f.rel);

      expect(implementers, `${symbol} must be defined exactly once`).toEqual([AUTHORITATIVE]);
    }
  });

  it('no source module hard-codes a cutoff time', () => {
    // The cutoff is configuration read from the settings table. A time literal
    // in source is either a duplicate implementation or a bypass of the setting.
    const offenders = sourceFiles
      .filter((f) => f.rel !== AUTHORITATIVE)
      .filter((f) => /(['"`])([01]\d|2[0-3]):[0-5]\d\1/.test(f.text))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  it('only the settings service and its admin surface name the cutoff setting key', () => {
    // Allowed mentions:
    //   - the service itself, which reads the key;
    //   - routes/admin.ts, which writes it through the service and names it in
    //     the audit call;
    //   - shared/types, which only DECLARES the AppSettings shape - a type is
    //     not a second implementation.
    const allowed = [
      AUTHORITATIVE,
      'src/worker/routes/admin.ts',
      'src/shared/types/index.ts',
    ].sort();

    const readers = sourceFiles
      .filter((f) => f.text.includes('lunch_cutoff_time'))
      .map((f) => f.rel)
      .sort();

    expect(readers).toEqual(allowed);
  });

  it('no module outside the settings service builds a business date itself', () => {
    // The UTC-date shortcut that Phase 2 removed. Only lib/datetime.ts may
    // discuss it, and only in a comment explaining what it replaced.
    const offenders = sourceFiles
      .filter((f) => f.rel !== 'src/worker/lib/datetime.ts')
      .filter((f) => f.text.includes("toISOString().split('T')[0]"))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });
});
