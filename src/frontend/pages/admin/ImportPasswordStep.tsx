/**
 * Apply the passwords from an employee workbook, after the import has committed.
 *
 * WHY THIS IS A SEPARATE STEP, AND WHY IT RUNS IN THE BROWSER:
 *
 * Hashing is deliberately expensive - PBKDF2-SHA-256 at 100k iterations, about
 * 57 ms each. A 253-row workbook is roughly 14 SECONDS of CPU, which no single
 * Worker invocation can do. And the workbook itself cannot be hashed later on
 * the server, because CanteenHub keeps no object store: the bytes exist only
 * for the request that uploaded them.
 *
 * So the file stays here, in the browser, where it already is. This component
 * re-reads it and sets one password per request through the EXISTING
 * administrator endpoint - the same one used from the employee screen, already
 * audited, already revoking that employee's sessions. Nothing new is trusted and
 * no plaintext is ever persisted server-side.
 *
 * AVAILABLE AT ANY TIME, not only in the moments after a commit. It used to
 * render only while the just-uploaded File was still in the import page's
 * state, so an administrator who committed an import and then looked away had
 * no way to apply the passwords in their workbook at all - and re-importing did
 * not help, because the import has never set a password. That is why it also
 * takes a file of its own.
 *
 * HANDLING OF THE PLAINTEXT: passwords live in this component's memory only for
 * as long as the run takes, are sent over HTTPS one at a time, and are dropped
 * when it finishes. They are never put in a URL, written to storage, logged, or
 * included in the import preview - which IS stored in the database, and which is
 * why the importer stages only a `password_supplied` flag.
 */

import { useState } from 'react';
import { readWorksheet, normalizeHeader, normalizeCell } from '../../../worker/lib/xlsx.js';
import { setEmployeePassword } from '../../api/adminEndpoints.js';
import { listEmployees } from '../../api/adminEndpoints.js';
import { ApiError } from '../../api/client.js';

/** Header spellings the importer accepts for the password column. */
const PASSWORD_ALIASES = ['password', 'initial password', 'temporary password'];
const AMCO_ALIASES = ['id', 'id#', 'amco id#', 'amco id', 'amco_id', 'amcoid', 'employee id', 'code'];

interface Props {
  /** The workbook just imported, when there is one. Otherwise the administrator picks one. */
  file?: File;
  sheetName?: string;
  onDone?: () => void;
}

interface Progress {
  total: number;
  done: number;
  failed: Array<{ amcoId: string; reason: string }>;
  finished: boolean;
}

/** Read (amco id -> password) straight from the workbook the admin uploaded. */
async function readPasswords(file: File, sheetName?: string): Promise<Map<string, string>> {
  const buffer = await file.arrayBuffer();
  const sheet = await readWorksheet(buffer, sheetName ?? 'All Employees');
  const out = new Map<string, string>();
  if (sheet.rows.length === 0) return out;

  const header = sheet.rows[0];
  let amcoCol: number | undefined;
  let passwordCol: number | undefined;
  for (const [index, raw] of header.cells) {
    const key = normalizeHeader(raw);
    if (AMCO_ALIASES.includes(key)) amcoCol = index;
    if (PASSWORD_ALIASES.includes(key)) passwordCol = index;
  }
  if (amcoCol === undefined || passwordCol === undefined) return out;

  for (const row of sheet.rows.slice(1)) {
    const amcoId = normalizeCell(row.cells.get(amcoCol));
    // NOT normalized: a password is used exactly as typed.
    const password = row.cells.get(passwordCol) ?? '';
    if (amcoId && password) out.set(amcoId.toUpperCase(), password);
  }
  return out;
}

export function ImportPasswordStep({ file, sheetName, onDone }: Props) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [chosen, setChosen] = useState<File | null>(null);

  // The workbook just imported, or one the administrator picks here.
  const source = file ?? chosen;

  const run = async () => {
    setError(null);
    if (!source) {
      setError('Choose the workbook that carries the passwords.');
      return;
    }
    setRunning(true);
    try {
      const passwords = await readPasswords(source, sheetName);
      if (passwords.size === 0) {
        setError('No password column was found in this workbook, or no row carries a password.');
        setRunning(false);
        return;
      }

      // The committed employees, so an AMCO ID can be turned into the row id the
      // password endpoint takes.
      //
      // PAGED, not fetched in one go: the server caps page_size at 100 however
      // large a number is asked for. A single request therefore returns the
      // first 100 employees, and every password past that would have failed
      // with "no employee with this AMCO ID" - silently, for exactly the large
      // imports this step exists to serve.
      const PAGE_SIZE = 100;
      const idByAmco = new Map<string, number>();
      for (let page = 1; ; page++) {
        const list = await listEmployees({ pageSize: PAGE_SIZE, page });
        for (const e of list.employees) idByAmco.set(e.amco_id.toUpperCase(), e.id);
        // Stop on a short page, and guard against a server that ignores paging.
        if (list.employees.length < PAGE_SIZE) break;
        if (idByAmco.size >= list.total) break;
        if (page > 200) break;
      }

      const entries = [...passwords.entries()];
      const failed: Progress['failed'] = [];
      let done = 0;
      setProgress({ total: entries.length, done, failed, finished: false });

      // One request per employee, a few at a time. Each is a single hash on the
      // server, which is what the CPU budget allows; the small pool keeps a
      // large workbook from taking minutes without flooding the Worker.
      const POOL = 3;
      let cursor = 0;
      const worker = async () => {
        while (cursor < entries.length) {
          const index = cursor++;
          const [amcoId, password] = entries[index];
          const id = idByAmco.get(amcoId);
          if (id === undefined) {
            failed.push({ amcoId, reason: 'No employee with this ID exists.' });
          } else {
            try {
              await setEmployeePassword(id, password);
            } catch (err) {
              failed.push({
                amcoId,
                reason: err instanceof ApiError ? err.message : 'The password could not be set.',
              });
            }
          }
          done += 1;
          setProgress({ total: entries.length, done, failed: [...failed], finished: false });
        }
      };

      await Promise.all(Array.from({ length: Math.min(POOL, entries.length) }, worker));
      setProgress({ total: entries.length, done, failed: [...failed], finished: true });
      onDone?.();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'The workbook could not be read for passwords.'
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="card">
      <h2 className="card__title">Set passwords from a workbook</h2>
      <p className="panel__note">
        <strong>Importing a workbook never sets a password</strong>, however many the file
        carries — this step does, and it is the only thing that does. Run it whenever you like,
        on the workbook you just imported or on any other: passwords are read from the file in
        your browser and sent one at a time, and are never stored in the import record. An
        employee whose password is set here can sign in immediately.
      </p>

      {!file && (
        <div className="field">
          <label className="field__label" htmlFor="password-workbook">
            Workbook with a Password column
          </label>
          <input
            id="password-workbook"
            className="field__input"
            type="file"
            accept=".xlsx"
            disabled={running}
            onChange={(e) => {
              setChosen(e.target.files?.[0] ?? null);
              setProgress(null);
              setError(null);
            }}
          />
          {chosen && <p className="panel__note">Selected: {chosen.name}</p>}
        </div>
      )}

      {progress && (
        <>
          <p className="feedback feedback--muted" role="status">
            {progress.finished
              ? `Finished: ${progress.done - progress.failed.length} of ${progress.total} password(s) set.`
              : `Setting passwords… ${progress.done} of ${progress.total}`}
          </p>
          {progress.failed.length > 0 && (
            <ul className="messages messages--error">
              {progress.failed.slice(0, 20).map((f) => (
                <li key={f.amcoId}>
                  {f.amcoId}: {f.reason}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {error && (
        <p className="feedback feedback--error" role="alert">
          {error}
        </p>
      )}

      {!progress?.finished && (
        <div className="panel__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={run}
            disabled={running || !source}
          >
            {running ? 'Setting passwords…' : 'Set passwords from workbook'}
          </button>
        </div>
      )}
    </section>
  );
}
