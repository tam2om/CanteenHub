/**
 * Excel imports: employees, shift roster, lunch menus.
 *
 * One screen, one upload / validate / preview / confirm / commit lifecycle,
 * with a source switcher choosing which kind of workbook it is running
 * against. The three imports do not share upload state, so switching source
 * is a route change (`/admin/imports/:kind`) that remounts the flow rather
 * than a locally mutated "which kind" flag - there is never stale state left
 * over from the previous kind.
 *
 * Every decision (what is valid, what will change, whether commit is
 * permitted) comes from the server; this screen renders it. No eligibility
 * logic lives here.
 */

import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import {
  useCommitImport,
  useImport,
  useImports,
  useUploadImport,
  useValidateImport,
} from '../../hooks/useImports.js';
import { ApiError } from '../../api/client.js';
import { ImportPasswordStep } from './ImportPasswordStep.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import type {
  ImportActionCounts,
  ImportDetail,
  ImportPreviewRow,
  ImportSheet,
  ImportType,
} from '../../types/index.js';

/** Mirrors the server's per-row classification. */
type Action = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';

interface EmployeeRowPreview {
  action: Action;
  amco_id: string;
  full_name: string;
  department: string | null;
  section: string | null;
  roster_type: string | null;
  changes?: Array<{ field: string; from: string | null; to: string | null }>;
}

interface RosterDayPreview {
  work_date: string;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED';
  from: string | null;
  to: string;
}

interface RosterRowPreview {
  action: Action;
  amco_id: string;
  month: number | null;
  year: number | null;
  days: RosterDayPreview[];
  counts: { create: number; update: number; unchanged: number };
}

interface MenuComponentPreview {
  component_type: string;
  label: string;
  name: string;
  action: 'CREATE' | 'UPDATE' | 'UNCHANGED';
  from: string | null;
}

interface MenuRowPreview {
  action: Action;
  meal_date: string;
  option_1: string;
  option_2: string;
  components: MenuComponentPreview[];
  changes: Array<{ field: string; from: string | null; to: string | null }>;
  current_status: string | null;
}

type DayTotals = { create: number; update: number; unchanged: number };

const ACTION_LABELS: Record<ImportType, Record<Action, string>> = {
  employees: { CREATE: 'New', UPDATE: 'Update', UNCHANGED: 'Unchanged', INVALID: 'Cannot import' },
  roster: { CREATE: 'New', UPDATE: 'Changes', UNCHANGED: 'Already correct', INVALID: 'Cannot import' },
  menu: { CREATE: 'New', UPDATE: 'Changes', UNCHANGED: 'Already correct', INVALID: 'Cannot import' },
};

const EMPLOYEE_FIELD_LABELS: Record<string, string> = {
  full_name: 'Name',
  department: 'Department',
  section: 'Section',
  roster_type: 'Roster',
};

const MENU_FIELD_LABELS: Record<string, string> = {
  option_1: 'Option 1',
  option_2: 'Option 2',
};

const MENU_COMPONENT_LABELS: Record<string, string> = {
  salad: 'Salad',
  other: 'Side',
  condiment: 'Condiment',
  beverage: 'Beverage',
  dessert: 'Dessert / fruit',
};

const menuComponentLabel = (type: string) => MENU_COMPONENT_LABELS[type] ?? type;

const SHIFT_LABELS: Record<string, string> = { day: 'Day', night: 'Night', off: 'Off' };
const shiftLabel = (value: string | null) => (value ? (SHIFT_LABELS[value] ?? value) : '—');

const KIND_LABEL: Record<ImportType, string> = {
  employees: 'Employees',
  roster: 'Shift roster',
  menu: 'Lunch menus',
};

const KIND_TITLE: Record<ImportType, string> = {
  employees: 'Import employees',
  roster: 'Import shift roster',
  menu: 'Import lunch menu',
};

const CONFIRM_TITLE: Record<ImportType, string> = {
  employees: 'Commit this employee import?',
  roster: 'Commit this roster import?',
  menu: 'Commit this lunch menu import?',
};

const NOT_COMMITTABLE_NOTE: Record<ImportType, string> = {
  employees: 'This workbook cannot be committed. Correct it and upload it again — no employee record has been changed.',
  roster: 'This workbook cannot be committed. Correct it and upload it again — no roster entry has been changed.',
  menu: 'This workbook cannot be committed. Correct it and upload it again — no menu has been changed.',
};

const HISTORY_TITLE: Record<ImportType, string> = {
  employees: 'Recent employee imports',
  roster: 'Recent roster imports',
  menu: 'Recent menu imports',
};

const HISTORY_EMPTY: Record<ImportType, string> = {
  employees: 'No employee imports yet.',
  roster: 'No roster imports yet.',
  menu: 'No menu imports yet.',
};

const IMPORT_KINDS: ImportType[] = ['employees', 'roster', 'menu'];

function countByAction(rows: ImportPreviewRow[]): ImportActionCounts {
  const counts: ImportActionCounts = { CREATE: 0, UPDATE: 0, UNCHANGED: 0, INVALID: 0 };
  for (const row of rows) {
    const action = (row.preview as { action?: Action } | null)?.action;
    if (action && action in counts) counts[action] += 1;
  }
  return counts;
}

/** Roll the per-day counts up across every previewed roster row. */
function totalDays(rows: ImportPreviewRow[]): DayTotals {
  const totals: DayTotals = { create: 0, update: 0, unchanged: 0 };
  for (const row of rows) {
    const counts = (row.preview as RosterRowPreview | null)?.counts;
    if (!counts) continue;
    totals.create += counts.create;
    totals.update += counts.update;
    totals.unchanged += counts.unchanged;
  }
  return totals;
}

function confirmDetail(
  kind: ImportType,
  current: ImportDetail,
  counts: ImportActionCounts,
  days: DayTotals | null
): string {
  if (kind === 'roster' && days) {
    return (
      `${current.original_filename}: ${days.create} new and ${days.update} changed ` +
      `roster day(s) across ${current.total_rows} row(s); ${days.unchanged} are already ` +
      `correct and will not be rewritten. Dates this workbook does not mention are left ` +
      `exactly as they are — nothing is cleared or deleted. Employee records, passwords ` +
      `and meal selections are not touched.`
    );
  }
  if (kind === 'menu') {
    return (
      `${current.original_filename}: ${counts.CREATE} new and ${counts.UPDATE} changed ` +
      `menu day(s); ${counts.UNCHANGED} are already correct and will not be rewritten. ` +
      `Committing PUBLISHES every date in this workbook - including days already ` +
      `correct but still in draft - so employees can select from them straight ` +
      `away. A day that was archived stays archived, and nothing is ever ` +
      `unpublished. Dates not in this workbook are left exactly as they are, and ` +
      `employees' existing lunch selections are never changed.`
    );
  }
  return (
    `${current.original_filename}: ${current.total_rows} rows — ` +
    `${counts.CREATE} new, ${counts.UPDATE} updates, ${counts.UNCHANGED} unchanged, ` +
    `${counts.INVALID} invalid. Invalid rows are never committed. ` +
    `Employees absent from this workbook will NOT be deactivated, and existing ` +
    `passwords and meal history are preserved.`
  );
}

// ---------------------------------------------------------------------------
// route entry
// ---------------------------------------------------------------------------

/** Reads `:kind` from the URL and falls back to the employee import. */
export function AdminImportRoute() {
  const { kind } = useParams<{ kind: string }>();
  if (!kind || !IMPORT_KINDS.includes(kind as ImportType)) {
    return <Navigate to="/admin/imports/employees" replace />;
  }
  return <AdminImportPage kind={kind as ImportType} />;
}

export function AdminImportPage({ kind }: { kind: ImportType }) {
  return (
    <main className="page">
      <div className="page__head">
        <h1 className="page__title">{KIND_TITLE[kind]}</h1>
      </div>

      <ImportSwitcher active={kind} />

      {/* Keyed by kind: switching source is a fresh run, not a mutation of
          this one - a half-finished employee import must never leak into a
          roster import chosen straight after. */}
      <ImportFlow key={kind} kind={kind} />
    </main>
  );
}

function ImportSwitcher({ active }: { active: ImportType }) {
  return (
    <div className="import-switch" role="tablist" aria-label="Import source">
      {IMPORT_KINDS.map((kind) => (
        <Link
          key={kind}
          to={`/admin/imports/${kind}`}
          role="tab"
          aria-selected={kind === active}
          className={`import-switch__link ${kind === active ? 'import-switch__link--active' : ''}`}
        >
          {KIND_LABEL[kind]}
        </Link>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the upload / validate / preview / commit flow, for one kind
// ---------------------------------------------------------------------------

function ImportFlow({ kind }: { kind: ImportType }) {
  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sheetAcknowledged, setSheetAcknowledged] = useState(false);
  const [committed, setCommitted] = useState<ImportDetail | null>(null);

  const uploadMutation = useUploadImport();
  const validateMutation = useValidateImport();
  const commitMutation = useCommitImport();
  const detail = useImport(batchId);

  const reset = () => {
    setFile(null);
    setBatchId(null);
    setClientError(null);
    setConfirming(false);
    setSheetAcknowledged(false);
    setCommitted(null);
    uploadMutation.reset();
    validateMutation.reset();
    commitMutation.reset();
  };

  const handleUpload = () => {
    setClientError(null);
    if (!file) {
      setClientError('Choose a workbook first.');
      return;
    }

    uploadMutation.mutate(
      { importType: kind, file },
      {
        onSuccess: (created) => {
          setBatchId(created.id);
          // Validation is a separate server operation - upload never commits,
          // and never validates on the administrator's behalf silently.
          validateMutation.mutate(created.id);
        },
      }
    );
  };

  const current = detail.data;
  const rows = current?.preview_rows ?? [];
  // The SERVER's tallies cover every row. `countByAction(rows)` counts only the
  // rows this page received, and `preview_rows` is capped at
  // `preview_row_limit` - which is how a 253-row import once reported "86 new".
  // The fallback exists only for a batch validated before the server sent
  // counts at all.
  const counts = current?.action_counts ?? validateMutation.data?.action_counts ?? countByAction(rows);
  const days = kind === 'roster' ? totalDays(rows) : null;
  const summaryMessages = validateMutation.data?.messages ?? [];

  // Which worksheet the server read. `candidate` means no sheet was named
  // "Lunch" and the server identified one from its contents - a decision this
  // screen must put in front of the administrator rather than absorb. Only
  // the menu import has a worksheet ambiguity to resolve.
  const sheet: ImportSheet | null =
    kind === 'menu' ? (current?.sheet ?? validateMutation.data?.sheet ?? null) : null;
  const needsSheetConfirmation = sheet?.source === 'candidate';

  // The server is the authority on whether a commit is permitted; the button
  // simply reflects it. The worksheet acknowledgement is an ADDITIONAL local
  // gate for the menu import - the server refuses an unconfirmed candidate
  // regardless, so this only stops sending a request that would be refused.
  const canCommit = current?.status === 'preview' && (!needsSheetConfirmation || sheetAcknowledged);

  const mutationError = (error: unknown, fallback: string) =>
    error instanceof ApiError ? error.message : error ? fallback : null;

  const uploadError = mutationError(uploadMutation.error, 'The workbook could not be uploaded.');
  const validateError = mutationError(validateMutation.error, 'The workbook could not be validated.');
  const commitError = mutationError(commitMutation.error, 'The import could not be committed.');

  return (
    <>
      {/* ---------------- step 1: choose and upload ---------------- */}
      {!batchId && (
        <UploadStep
          kind={kind}
          clientError={clientError}
          uploadError={uploadError}
          uploadPending={uploadMutation.isPending}
          onChooseFile={(f) => {
            setFile(f);
            setClientError(null);
          }}
          onUpload={handleUpload}
        />
      )}

      {/* ---------------- step 2: validation ---------------- */}
      {batchId && (validateMutation.isPending || detail.isLoading) && (
        <LoadingState label="Validating the workbook…" />
      )}

      {batchId && validateError && <ErrorState message={validateError} />}

      {batchId && detail.error && (
        <ErrorState
          message={
            detail.error instanceof ApiError ? detail.error.message : 'The import could not be loaded.'
          }
        />
      )}

      {/* ---------------- step 3: summary and preview ---------------- */}
      {current && !validateMutation.isPending && !committed && (
        <>
          <SummaryStep
            kind={kind}
            current={current}
            counts={counts}
            days={days}
            messages={summaryMessages}
            sheet={sheet}
            needsSheetConfirmation={needsSheetConfirmation}
            sheetAcknowledged={sheetAcknowledged}
            setSheetAcknowledged={setSheetAcknowledged}
            canCommit={canCommit}
          />

          {rows.length > 0 && <PreviewStep kind={kind} current={current} rows={rows} />}

          {/* ---------------- step 4: explicit confirmation ---------------- */}
          <section className="card">
            <h2 className="card__title">4. Confirm and commit</h2>

            {commitError && (
              <p className="feedback feedback--error" role="alert">
                {commitError}
              </p>
            )}

            {!confirming ? (
              <div className="panel__actions">
                <button type="button" className="button button--ghost" onClick={reset}>
                  Start over
                </button>
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => setConfirming(true)}
                  disabled={!canCommit}
                >
                  Commit this import
                </button>
              </div>
            ) : (
              <ConfirmDialog
                title={CONFIRM_TITLE[kind]}
                detail={confirmDetail(kind, current, counts, days)}
                confirmLabel="Commit import"
                busy={commitMutation.isPending}
                onCancel={() => setConfirming(false)}
                onConfirm={() =>
                  commitMutation.mutate(
                    kind === 'menu'
                      ? {
                          id: current.id,
                          // Sent only for a candidate: the server requires the
                          // NAME back, so a screen that never showed it cannot
                          // commit.
                          confirmSheet: needsSheetConfirmation ? sheet?.name : undefined,
                        }
                      : current.id,
                    {
                      onSuccess: (result) => {
                        setCommitted(result);
                        setConfirming(false);
                      },
                      onError: () => setConfirming(false),
                    }
                  )
                }
              />
            )}
          </section>
        </>
      )}

      {/* ---------------- step 5: result ---------------- */}
      {committed && kind === 'employees' && file && <ImportPasswordStep file={file} />}

      {committed && <CompleteStep kind={kind} committed={committed} counts={counts} days={days} onReset={reset} />}

      <ImportHistoryList kind={kind} />
    </>
  );
}

// ---------------------------------------------------------------------------
// step 1
// ---------------------------------------------------------------------------

function UploadStep({
  kind,
  clientError,
  uploadError,
  uploadPending,
  onChooseFile,
  onUpload,
}: {
  kind: ImportType;
  clientError: string | null;
  uploadError: string | null;
  uploadPending: boolean;
  onChooseFile: (file: File | null) => void;
  onUpload: () => void;
}) {
  return (
    <section className="card">
      <h2 className="card__title">1. Choose a workbook</h2>

      {kind === 'employees' && (
        <>
          <p className="panel__note">
            Upload the employee workbook (.xlsx). It must contain an{' '}
            <strong>All Employees</strong> sheet with ID, Name, Department, Section and Roster
            columns. Uploading does not change anything on its own.
          </p>
          {/* A plain link: the browser fetches it with the session cookie and
              saves what it is given. */}
          <p className="panel__note">
            Not sure of the format?{' '}
            <a href="/api/admin/imports/templates/employees.xlsx">
              Download the employee import template
            </a>{' '}
            — it has the exact columns this screen expects, example rows to
            delete, and an Instructions sheet listing the accepted values.
          </p>
        </>
      )}

      {kind === 'roster' && (
        <>
          <p className="panel__note">
            Upload the shift roster workbook (.xlsx). It must contain a{' '}
            <strong>Shifts roster</strong> sheet laid out one row per employee-month —{' '}
            <strong>ID</strong>, <strong>Month</strong>, <strong>Year</strong>, then a column per
            day numbered 1 to 31, each holding Off, Day or Night. Uploading does not change anything
            on its own.
          </p>
          <p className="panel__note">
            Not sure of the format?{' '}
            <a href="/api/admin/imports/templates/roster.xlsx">
              Download the roster import template
            </a>{' '}
            — it has the exact columns and sheet name this screen expects, example rows to
            delete, and an Instructions sheet listing the accepted values.
          </p>
        </>
      )}

      {kind === 'menu' && (
        <>
          <p className="panel__note">
            Upload the <strong>lunch</strong> menu workbook (.xlsx), one row per date with{' '}
            <strong>Date</strong>, <strong>Option 1</strong> and <strong>Option 2</strong>, plus the
            accompaniment columns. Committing the import <strong>publishes</strong> every date
            it covers, so check the preview carefully. Name the lunch sheet <strong>Lunch</strong>
            if you can; if no
            sheet is named for lunch, one is identified from its contents and you are asked to
            confirm it before anything is imported — a dinner sheet is never read as lunch.
            Uploading does not change anything on its own.
          </p>
          <p className="panel__note">
            “Option Meal 1” and “Option Meal 2” are accompaniments served with whichever main is
            chosen, so they are imported as components. The employee’s choice stays Option 1,
            Option 2 or No Preference.
          </p>
        </>
      )}

      <div className="setting__form">
        <label className="field field--inline">
          <span className="field__label">Workbook</span>
          <input
            className="field__input"
            type="file"
            accept=".xlsx,.xlsm"
            onChange={(e) => onChooseFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button
          type="button"
          className="button button--primary button--inline"
          onClick={onUpload}
          disabled={uploadPending}
        >
          {uploadPending ? 'Uploading…' : 'Upload and validate'}
        </button>
      </div>

      {(clientError || uploadError) && (
        <p className="feedback feedback--error" role="alert">
          {clientError ?? uploadError}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// step 2 (summary)
// ---------------------------------------------------------------------------

function SummaryStep({
  kind,
  current,
  counts,
  days,
  messages,
  sheet,
  needsSheetConfirmation,
  sheetAcknowledged,
  setSheetAcknowledged,
  canCommit,
}: {
  kind: ImportType;
  current: ImportDetail;
  counts: ImportActionCounts;
  days: DayTotals | null;
  messages: string[];
  sheet: ImportSheet | null;
  needsSheetConfirmation: boolean;
  sheetAcknowledged: boolean;
  setSheetAcknowledged: (value: boolean) => void;
  canCommit: boolean;
}) {
  return (
    <section className="card">
      <h2 className="card__title">2. Validation summary</h2>
      <p className="setting__current">
        <strong>{current.original_filename}</strong>
      </p>

      <ul className="summary">
        <li className="summary__item">
          <span className="summary__value">{current.total_rows}</span> rows read
        </li>

        {kind === 'roster' && days ? (
          <>
            <li className="summary__item summary__item--ok">
              <span className="summary__value">{days.create}</span> new days
            </li>
            <li className="summary__item summary__item--ok">
              <span className="summary__value">{days.update}</span> changed days
            </li>
            <li className="summary__item">
              <span className="summary__value">{days.unchanged}</span> already correct
            </li>
            <li className={`summary__item ${counts.INVALID > 0 ? 'summary__item--bad' : ''}`}>
              <span className="summary__value">{counts.INVALID}</span> invalid rows
            </li>
          </>
        ) : kind === 'menu' ? (
          <>
            <li className="summary__item summary__item--ok">
              <span className="summary__value">{counts.CREATE}</span> new days
            </li>
            <li className="summary__item summary__item--ok">
              <span className="summary__value">{counts.UPDATE}</span> changed
            </li>
            <li className="summary__item">
              <span className="summary__value">{counts.UNCHANGED}</span> already correct
            </li>
            <li className={`summary__item ${counts.INVALID > 0 ? 'summary__item--bad' : ''}`}>
              <span className="summary__value">{counts.INVALID}</span> invalid
            </li>
          </>
        ) : (
          <>
            <li className="summary__item summary__item--ok">
              <span className="summary__value">{counts.CREATE}</span> new
            </li>
            <li className="summary__item summary__item--ok">
              <span className="summary__value">{counts.UPDATE}</span> updates
            </li>
            <li className="summary__item">
              <span className="summary__value">{counts.UNCHANGED}</span> unchanged
            </li>
            <li className={`summary__item ${counts.INVALID > 0 ? 'summary__item--bad' : ''}`}>
              <span className="summary__value">{counts.INVALID}</span> invalid
            </li>
          </>
        )}
      </ul>

      {kind === 'menu' && sheet && !needsSheetConfirmation && (
        <p className="panel__note">
          Read from the <strong>{sheet.name}</strong> worksheet.
        </p>
      )}

      {messages.length > 0 && (
        <ul className="messages">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}

      {kind === 'menu' && needsSheetConfirmation && sheet && (
        <div className="feedback feedback--warn" role="status">
          <p>
            No worksheet in this workbook is named <strong>Lunch</strong>. The worksheet{' '}
            <strong>{sheet.name}</strong> was identified as the lunch menu because{' '}
            {(sheet.signals ?? []).join(', and ')}.
          </p>
          <p>
            Check that this is the right worksheet. A dinner menu is never identified this
            way, but only you can confirm which sheet you meant to import.
          </p>
          <label className="field field--check">
            <input
              type="checkbox"
              checked={sheetAcknowledged}
              onChange={(e) => setSheetAcknowledged(e.target.checked)}
            />
            <span>
              Yes — import the <strong>{sheet.name}</strong> worksheet as the lunch menu.
            </span>
          </label>
        </div>
      )}

      {current.failure_reason && (
        <p className="feedback feedback--error" role="alert">
          {current.failure_reason}
        </p>
      )}

      {!canCommit && <p className="panel__note">{NOT_COMMITTABLE_NOTE[kind]}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// step 3 (row preview)
// ---------------------------------------------------------------------------

function PreviewStep({
  kind,
  current,
  rows,
}: {
  kind: ImportType;
  current: ImportDetail;
  rows: ImportPreviewRow[];
}) {
  return (
    <section className="card">
      <h2 className="card__title">3. Row preview</h2>
      {current.total_rows > rows.length && (
        <p className="panel__note">
          Showing the first {rows.length} of {current.total_rows} rows.
        </p>
      )}

      <ul className="list list--tight">
        {rows.map((row) =>
          kind === 'employees' ? (
            <EmployeeRowItem key={row.row_number} row={row} />
          ) : kind === 'roster' ? (
            <RosterRowItem key={row.row_number} row={row} />
          ) : (
            <MenuRowItem key={row.row_number} row={row} />
          )
        )}
      </ul>
    </section>
  );
}

function EmployeeRowItem({ row }: { row: ImportPreviewRow }) {
  const p = row.preview as EmployeeRowPreview | null;
  const action = p?.action ?? 'INVALID';

  return (
    <li className="list__item">
      <div className="list__main">
        <div>
          <p className="list__title">
            {p?.amco_id || '(no ID)'} — {p?.full_name || '(no name)'}
          </p>
          <p className="list__meta">
            Row {row.row_number}
            {p?.department && ` · ${p.department}`}
            {p?.section && ` · ${p.section}`}
            {p?.roster_type && ` · ${p.roster_type}`}
          </p>
        </div>
        <span className={`tag ${action === 'INVALID' ? 'tag--off' : action === 'UNCHANGED' ? '' : 'tag--ok'}`}>
          {ACTION_LABELS.employees[action]}
        </span>
      </div>

      {p?.changes && p.changes.length > 0 && (
        <ul className="changes">
          {p.changes.map((change) => (
            <li key={change.field}>
              <span className="changes__field">{EMPLOYEE_FIELD_LABELS[change.field] ?? change.field}</span>
              <span className="changes__from">{change.from ?? '—'}</span>
              {' → '}
              <span className="changes__to">{change.to ?? '—'}</span>
            </li>
          ))}
        </ul>
      )}

      {row.messages.length > 0 && (
        <ul className="messages messages--error">
          {row.messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function RosterRowItem({ row }: { row: ImportPreviewRow }) {
  const p = row.preview as RosterRowPreview | null;
  const action = p?.action ?? 'INVALID';
  const changed = (p?.days ?? []).filter((d) => d.action !== 'UNCHANGED');

  return (
    <li className="list__item">
      <div className="list__main">
        <div>
          <p className="list__title">
            {p?.amco_id || '(no ID)'}
            {p?.month && p?.year ? ` — ${String(p.month).padStart(2, '0')}/${p.year}` : ''}
          </p>
          <p className="list__meta">
            Row {row.row_number}
            {p?.counts &&
              ` · ${p.counts.create} new · ${p.counts.update} changed · ${p.counts.unchanged} already correct`}
          </p>
        </div>
        <span className={`tag ${action === 'INVALID' ? 'tag--off' : action === 'UNCHANGED' ? '' : 'tag--ok'}`}>
          {ACTION_LABELS.roster[action]}
        </span>
      </div>

      {changed.length > 0 && (
        <ul className="changes">
          {changed.map((day) => (
            <li key={day.work_date}>
              <span className="changes__field">{day.work_date}</span>
              <span className="changes__from">{shiftLabel(day.from)}</span>
              {' → '}
              <span className="changes__to">{shiftLabel(day.to)}</span>
            </li>
          ))}
        </ul>
      )}

      {row.messages.length > 0 && (
        <ul className="messages messages--error">
          {row.messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function MenuRowItem({ row }: { row: ImportPreviewRow }) {
  const p = row.preview as MenuRowPreview | null;
  const action = p?.action ?? 'INVALID';
  const changedComponents = (p?.components ?? []).filter((c) => c.action !== 'UNCHANGED');

  return (
    <li className="list__item">
      <div className="list__main">
        <div>
          <p className="list__title">{p?.meal_date || '(no date)'}</p>
          <p className="list__meta">
            Row {row.row_number}
            {p?.option_1 && ` · 1: ${p.option_1}`}
            {p?.option_2 && ` · 2: ${p.option_2}`}
            {p?.current_status && ` · currently ${p.current_status}`}
          </p>
        </div>
        <span className={`tag ${action === 'INVALID' ? 'tag--off' : action === 'UNCHANGED' ? '' : 'tag--ok'}`}>
          {ACTION_LABELS.menu[action]}
        </span>
      </div>

      {((p?.changes.length ?? 0) > 0 || changedComponents.length > 0) && (
        <ul className="changes">
          {p?.changes.map((change) => (
            <li key={change.field}>
              <span className="changes__field">{MENU_FIELD_LABELS[change.field] ?? change.field}</span>
              <span className="changes__from">{change.from ?? '—'}</span>
              {' → '}
              <span className="changes__to">{change.to ?? '—'}</span>
            </li>
          ))}
          {changedComponents.map((component) => (
            <li key={component.component_type}>
              <span className="changes__field">{menuComponentLabel(component.component_type)}</span>
              <span className="changes__from">{component.from ?? '—'}</span>
              {' → '}
              <span className="changes__to">{component.name}</span>
            </li>
          ))}
        </ul>
      )}

      {row.messages.length > 0 && (
        <ul className="messages messages--error">
          {row.messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// step 5 (result)
// ---------------------------------------------------------------------------

function CompleteStep({
  kind,
  committed,
  counts,
  days,
  onReset,
}: {
  kind: ImportType;
  committed: ImportDetail;
  counts: ImportActionCounts;
  days: DayTotals | null;
  onReset: () => void;
}) {
  return (
    <section className="card">
      <h2 className="card__title">Import complete</h2>

      {kind === 'employees' && (
        <>
          <p className="feedback feedback--ok" role="status">
            {counts.CREATE} employee{counts.CREATE === 1 ? '' : 's'} created and {counts.UPDATE}{' '}
            updated from {committed.original_filename}.
          </p>
          <p className="panel__note">
            Newly created employees cannot sign in until you set a password for them.
          </p>
        </>
      )}

      {kind === 'roster' && days && (
        <>
          <p className="feedback feedback--ok" role="status">
            {days.create} roster day{days.create === 1 ? '' : 's'} created and {days.update} updated
            from {committed.original_filename}.
          </p>
          <p className="panel__note">
            Meal eligibility is recalculated from this roster automatically — no further step is
            needed.
          </p>
        </>
      )}

      {kind === 'menu' && (
        <>
          <p className="feedback feedback--ok" role="status">
            {counts.CREATE} menu day{counts.CREATE === 1 ? '' : 's'} created and {counts.UPDATE}{' '}
            updated from {committed.original_filename}.
          </p>
          <p className="panel__note">
            These days are <strong>published</strong> — employees can select from them now. To
            take one down again, archive it on the menu screen.
          </p>
        </>
      )}

      <div className="panel__actions">
        <button type="button" className="button button--primary" onClick={onReset}>
          Import another workbook
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

/** Recent imports of this kind, from the existing history API. No second history store. */
function ImportHistoryList({ kind }: { kind: ImportType }) {
  const { data, isLoading, error } = useImports(10, 0, kind);

  return (
    <section className="card">
      <h2 className="card__title">{HISTORY_TITLE[kind]}</h2>

      {isLoading && <LoadingState label="Loading history…" />}
      {error && (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'The history could not be loaded.'}
        />
      )}
      {data && data.imports.length === 0 && <EmptyState message={HISTORY_EMPTY[kind]} />}

      {data && data.imports.length > 0 && (
        <ul className="list list--tight">
          {data.imports.map((entry) => (
            <li className="list__item" key={entry.id}>
              <div className="list__main">
                <div>
                  <p className="list__title">{entry.original_filename}</p>
                  {/* Server-supplied timestamp, rendered as given. */}
                  <p className="list__meta">
                    {entry.created_at} · {entry.total_rows} rows
                    {entry.uploaded_by_amco_id && ` · ${entry.uploaded_by_amco_id}`}
                  </p>
                </div>
                <span className={`tag ${entry.status === 'committed' ? 'tag--ok' : 'tag--off'}`}>
                  {entry.status.replace(/_/g, ' ')}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
