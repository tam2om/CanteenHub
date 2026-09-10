/**
 * Employee Excel import.
 *
 * Walks the administrator through the foundation's own lifecycle - upload,
 * validate, preview, explicit confirm, commit - without inventing a parallel
 * one. Every decision (what is valid, what will change, whether commit is
 * permitted) comes from the server; this screen renders it.
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

interface EmployeeRowPreview {
  action: Action;
  amco_id: string;
  full_name: string;
  department: string | null;
  section: string | null;
  roster_type: string | null;
  changes?: Array<{ field: string; from: string | null; to: string | null }>;
}

const ACTION_LABELS: Record<Action, string> = {
  CREATE: 'New',
  UPDATE: 'Update',
  UNCHANGED: 'Unchanged',
  INVALID: 'Cannot import',
};

const FIELD_LABELS: Record<string, string> = {
  full_name: 'Name',
  department: 'Department',
  section: 'Section',
  roster_type: 'Roster',
};

function countByAction(rows: ImportPreviewRow[]): Record<Action, number> {
  const counts: Record<Action, number> = { CREATE: 0, UPDATE: 0, UNCHANGED: 0, INVALID: 0 };
  for (const row of rows) {
    const action = (row.preview as EmployeeRowPreview | null)?.action;
    if (action && action in counts) counts[action] += 1;
  }
  return counts;
}

export function AdminEmployeeImportPage() {
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
      { importType: 'employees', file },
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
        <h1 className="page__title">Import employees</h1>
        <Link to="/admin/employees" className="button button--ghost button--inline button--small">
          Back to employees
        </Link>
      </div>

      {/* ---------------- step 1: choose and upload ---------------- */}
      {!batchId && (
        <section className="card">
          <h2 className="card__title">1. Choose a workbook</h2>
          <p className="panel__note">
            Upload the employee workbook (.xlsx). It must contain an{' '}
            <strong>All Employees</strong> sheet with AMCO ID, Name, Department, Section and Roster
            columns. Uploading does not change anything on its own.
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
                This workbook cannot be committed. Correct it and upload it again — no employee
                record has been changed.
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
                  const p = row.preview as EmployeeRowPreview | null;
                  const action = p?.action ?? 'INVALID';

                  return (
                    <li className="list__item" key={row.row_number}>
                      <div className="list__main">
                        <div>
                          <p className="list__title">
                            {p?.amco_id || '(no AMCO ID)'} — {p?.full_name || '(no name)'}
                          </p>
                          <p className="list__meta">
                            Row {row.row_number}
                            {p?.department && ` · ${p.department}`}
                            {p?.section && ` · ${p.section}`}
                            {p?.roster_type && ` · ${p.roster_type}`}
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

                      {p?.changes && p.changes.length > 0 && (
                        <ul className="changes">
                          {p.changes.map((change) => (
                            <li key={change.field}>
                              <span className="changes__field">
                                {FIELD_LABELS[change.field] ?? change.field}
                              </span>
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
                title="Commit this employee import?"
                detail={
                  `${current.original_filename}: ${current.total_rows} rows — ` +
                  `${counts.CREATE} new, ${counts.UPDATE} updates, ${counts.UNCHANGED} unchanged, ` +
                  `${counts.INVALID} invalid. Invalid rows are never committed. ` +
                  `Employees absent from this workbook will NOT be deactivated, and existing ` +
                  `passwords and meal history are preserved.`
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
            {counts.CREATE} employee{counts.CREATE === 1 ? '' : 's'} created and {counts.UPDATE}{' '}
            updated from {committed.original_filename}.
          </p>
          <p className="panel__note">
            Newly created employees cannot sign in until you set a password for them.
          </p>
          <div className="panel__actions">
            <button type="button" className="button button--primary" onClick={reset}>
              Import another workbook
            </button>
          </div>
        </section>
      )}

      <ImportHistory />
    </main>
  );
}

/** Recent imports, from the existing history API. No second history store. */
function ImportHistory() {
  const { data, isLoading, error } = useImports(10, 0, 'employees');

  return (
    <section className="card">
      <h2 className="card__title">Recent employee imports</h2>

      {isLoading && <LoadingState label="Loading history…" />}
      {error && (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'The history could not be loaded.'}
        />
      )}
      {data && data.imports.length === 0 && <EmptyState message="No employee imports yet." />}

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
