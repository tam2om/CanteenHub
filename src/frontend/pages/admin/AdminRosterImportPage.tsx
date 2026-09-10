/**
 * Shift roster Excel import.
 *
 * Walks the administrator through the foundation's own lifecycle - upload,
 * validate, preview, explicit confirm, commit - without inventing a parallel
 * one. Every decision (what is valid, what will change, whether commit is
 * permitted) comes from the server; this screen renders it.
 *
 * No eligibility logic lives here. The roster records Day/Night/Off; whether a
 * value earns a meal is the server's eligibility service's business alone.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useCommitImport,
  useImport,
  useImports,
  useUploadImport,
  useValidateImport,
} from '../../hooks/useImports.js';
import { ApiError } from '../../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import type { ImportDetail, ImportPreviewRow } from '../../types/index.js';

/** Mirrors the server's per-row classification. */
type Action = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'INVALID';

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

const ACTION_LABELS: Record<Action, string> = {
  CREATE: 'New',
  UPDATE: 'Changes',
  UNCHANGED: 'Already correct',
  INVALID: 'Cannot import',
};

const SHIFT_LABELS: Record<string, string> = {
  day: 'Day',
  night: 'Night',
  off: 'Off',
};

const shiftLabel = (value: string | null) => (value ? (SHIFT_LABELS[value] ?? value) : '—');

/** Roll the per-day counts up across every previewed row. */
function totalDays(rows: ImportPreviewRow[]) {
  const totals = { create: 0, update: 0, unchanged: 0 };
  for (const row of rows) {
    const counts = (row.preview as RosterRowPreview | null)?.counts;
    if (!counts) continue;
    totals.create += counts.create;
    totals.update += counts.update;
    totals.unchanged += counts.unchanged;
  }
  return totals;
}

function countByAction(rows: ImportPreviewRow[]): Record<Action, number> {
  const counts: Record<Action, number> = { CREATE: 0, UPDATE: 0, UNCHANGED: 0, INVALID: 0 };
  for (const row of rows) {
    const action = (row.preview as RosterRowPreview | null)?.action;
    if (action && action in counts) counts[action] += 1;
  }
  return counts;
}

export function AdminRosterImportPage() {
  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
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
      { importType: 'roster', file },
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
  const counts = countByAction(rows);
  const days = totalDays(rows);
  const summaryMessages =
    (validateMutation.data as ImportDetail & { messages?: string[] } | undefined)?.messages ?? [];

  // The server is the authority on whether a commit is permitted; the button
  // simply reflects it.
  const canCommit = current?.status === 'preview';

  const mutationError = (error: unknown, fallback: string) =>
    error instanceof ApiError ? error.message : error ? fallback : null;

  const uploadError = mutationError(uploadMutation.error, 'The workbook could not be uploaded.');
  const validateError = mutationError(validateMutation.error, 'The workbook could not be validated.');
  const commitError = mutationError(commitMutation.error, 'The import could not be committed.');

  return (
    <main className="page">
      <div className="page__head">
        <h1 className="page__title">Import shift roster</h1>
        <Link to="/admin/imports/employees" className="button button--ghost button--inline button--small">
          Employee import
        </Link>
      </div>

      {/* ---------------- step 1: choose and upload ---------------- */}
      {!batchId && (
        <section className="card">
          <h2 className="card__title">1. Choose a workbook</h2>
          <p className="panel__note">
            Upload the shift roster workbook (.xlsx). It must contain a{' '}
            <strong>Shifts roster</strong> sheet laid out one row per employee-month —{' '}
            <strong>code</strong>, <strong>month</strong>, <strong>year</strong>, then a column per
            day numbered 1 to 31, each holding Off, Day or Night. Uploading does not change anything
            on its own.
          </p>

          <div className="setting__form">
            <label className="field field--inline">
              <span className="field__label">Workbook</span>
              <input
                className="field__input"
                type="file"
                accept=".xlsx,.xlsm"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setClientError(null);
                }}
              />
            </label>
            <button
              type="button"
              className="button button--primary button--inline"
              onClick={handleUpload}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? 'Uploading…' : 'Upload and validate'}
            </button>
          </div>

          {(clientError || uploadError) && (
            <p className="feedback feedback--error" role="alert">
              {clientError ?? uploadError}
            </p>
          )}
        </section>
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
          <section className="card">
            <h2 className="card__title">2. Validation summary</h2>
            <p className="setting__current">
              <strong>{current.original_filename}</strong>
            </p>

            <ul className="summary">
              <li className="summary__item">
                <span className="summary__value">{current.total_rows}</span> rows read
              </li>
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
            </ul>

            {summaryMessages.length > 0 && (
              <ul className="messages">
                {summaryMessages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}

            {current.failure_reason && (
              <p className="feedback feedback--error" role="alert">
                {current.failure_reason}
              </p>
            )}

            {!canCommit && (
              <p className="panel__note">
                This workbook cannot be committed. Correct it and upload it again — no roster entry
                has been changed.
              </p>
            )}
          </section>

          {rows.length > 0 && (
            <section className="card">
              <h2 className="card__title">3. Row preview</h2>
              {current.total_rows > rows.length && (
                <p className="panel__note">
                  Showing the first {rows.length} of {current.total_rows} rows.
                </p>
              )}

              <ul className="list list--tight">
                {rows.map((row) => {
                  const p = row.preview as RosterRowPreview | null;
                  const action = p?.action ?? 'INVALID';
                  const changed = (p?.days ?? []).filter((d) => d.action !== 'UNCHANGED');

                  return (
                    <li className="list__item" key={row.row_number}>
                      <div className="list__main">
                        <div>
                          <p className="list__title">
                            {p?.amco_id || '(no AMCO ID)'}
                            {p?.month && p?.year
                              ? ` — ${String(p.month).padStart(2, '0')}/${p.year}`
                              : ''}
                          </p>
                          <p className="list__meta">
                            Row {row.row_number}
                            {p?.counts &&
                              ` · ${p.counts.create} new · ${p.counts.update} changed · ${p.counts.unchanged} already correct`}
                          </p>
                        </div>
                        <span
                          className={`tag ${
                            action === 'INVALID'
                              ? 'tag--off'
                              : action === 'UNCHANGED'
                                ? ''
                                : 'tag--ok'
                          }`}
                        >
                          {ACTION_LABELS[action]}
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
                })}
              </ul>
            </section>
          )}

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
                title="Commit this roster import?"
                detail={
                  `${current.original_filename}: ${days.create} new and ${days.update} changed ` +
                  `roster day(s) across ${current.total_rows} row(s); ${days.unchanged} are already ` +
                  `correct and will not be rewritten. Dates this workbook does not mention are left ` +
                  `exactly as they are — nothing is cleared or deleted. Employee records, passwords ` +
                  `and meal selections are not touched.`
                }
                confirmLabel="Commit import"
                busy={commitMutation.isPending}
                onCancel={() => setConfirming(false)}
                onConfirm={() =>
                  commitMutation.mutate(current.id, {
                    onSuccess: (result) => {
                      setCommitted(result);
                      setConfirming(false);
                    },
                    onError: () => setConfirming(false),
                  })
                }
              />
            )}
          </section>
        </>
      )}

      {/* ---------------- step 5: result ---------------- */}
      {committed && (
        <section className="card">
          <h2 className="card__title">Import complete</h2>
          <p className="feedback feedback--ok" role="status">
            {days.create} roster day{days.create === 1 ? '' : 's'} created and {days.update} updated
            from {committed.original_filename}.
          </p>
          <p className="panel__note">
            Meal eligibility is recalculated from this roster automatically — no further step is
            needed.
          </p>
          <div className="panel__actions">
            <button type="button" className="button button--primary" onClick={reset}>
              Import another workbook
            </button>
          </div>
        </section>
      )}

      <RosterImportHistory />
    </main>
  );
}

/** Recent roster imports, from the existing history API. No second history store. */
function RosterImportHistory() {
  const { data, isLoading, error } = useImports(10, 0, 'roster');

  return (
    <section className="card">
      <h2 className="card__title">Recent roster imports</h2>

      {isLoading && <LoadingState label="Loading history…" />}
      {error && (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'The history could not be loaded.'}
        />
      )}
      {data && data.imports.length === 0 && <EmptyState message="No roster imports yet." />}

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
