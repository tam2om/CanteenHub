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
 * PACED AND RETRIED, because hashing is expensive on a Worker that is allowed
 * very little CPU per request. Three requests in flight at once got 143 of 253
 * employees set and then Cloudflare shed the rest with 503s - a run that looks
 * like a failure but is really the platform saying "slower". Requests now go
 * one at a time, and a 503, 429 or dropped connection is retried with a
 * widening gap rather than counted as a refusal. A genuine refusal - a password
 * the policy rejects, an employee who does not exist - is NOT retried.
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

/**
 * Gaps before each retry. Widening, and long enough to matter: a Worker shedding
 * load under sustained hashing needs breathing room, not an immediate second
 * attempt that adds to the pile.
 */
const RETRY_DELAYS_MS = [1000, 3000, 8000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Worth trying again, or a real answer?
 *
 * 429 and 5xx are the platform saying "not now" - including the 503 that ended
 * 110 of 253 employees mid-run. A network error (no ApiError at all) is the
 * same kind of event. Anything the server actually decided - 400 for a password
 * the policy rejects, 404 for an employee who is not there, 401 for an expired
 * session - is an answer, and retrying it just repeats a refusal.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof ApiError) return error.status === 429 || error.status >= 500;
  return true;
}

/** Set one password, riding out a temporarily overloaded Worker. */
async function setPasswordWithRetry(id: number, password: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await setEmployeePassword(id, password);
      return;
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransient(error)) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

export function ImportPasswordStep({ file, sheetName, onDone }: Props) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [chosen, setChosen] = useState<File | null>(null);

  // The workbook just imported, or one the administrator picks here.
  const source = file ?? chosen;

  /**
   * Apply the workbook's passwords.
   *
   * `only` restricts the run to a set of AMCO IDs, which is how "retry the ones
   * that failed" works: the workbook is read again and just those rows are
   * sent, so a transient failure never means starting the whole file over.
   */
  const run = async (only?: Set<string>) => {
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

      const entries = [...passwords.entries()].filter(([amcoId]) => !only || only.has(amcoId));
      const failed: Progress['failed'] = [];
      let done = 0;
      setProgress({ total: entries.length, done, failed, finished: false });

      // ONE REQUEST AT A TIME. Each one costs the server a deliberate ~57 ms of
      // hashing, and three in flight was enough for Cloudflare to start
      // refusing them outright. Sequential is slower to watch and is the only
      // version that finishes.
      for (const [amcoId, password] of entries) {
        const id = idByAmco.get(amcoId);
        if (id === undefined) {
          failed.push({ amcoId, reason: 'No employee with this ID exists.' });
        } else {
          try {
            await setPasswordWithRetry(id, password);
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
      <p className="panel__note">
        They are sent one at a time, so a large workbook takes a few minutes —
        about a second per employee. Leave this screen open until it finishes.
        Running it again is safe: a password that is set again is simply set to
        the same value.
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

      <div className="panel__actions">
        {!progress?.finished && (
          <button
            type="button"
            className="button button--primary"
            onClick={() => void run()}
            disabled={running || !source}
          >
            {running ? 'Setting passwords…' : 'Set passwords from workbook'}
          </button>
        )}

        {/* A finished run with failures is not the end of the road: re-reading
            the workbook for just those employees is cheaper and safer than
            starting the whole file again. */}
        {progress?.finished && progress.failed.length > 0 && (
          <button
            type="button"
            className="button button--primary"
            onClick={() => void run(new Set(progress.failed.map((f) => f.amcoId)))}
            disabled={running}
          >
            {running
              ? 'Setting passwords…'
              : `Retry the ${progress.failed.length} that failed`}
          </button>
        )}
      </div>
    </section>
  );
}
