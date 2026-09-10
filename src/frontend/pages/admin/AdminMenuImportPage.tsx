/**
 * Lunch menu Excel import.
 *
 * Walks the administrator through the foundation's own lifecycle - upload,
 * validate, preview, explicit confirm, commit - without inventing a parallel
 * one. Every decision (what is valid, what will change, whether commit is
 * permitted) comes from the server; this screen renders it.
 *
 * This is the LUNCH menu. There is no dinner import.
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

const ACTION_LABELS: Record<Action, string> = {
  CREATE: 'New',
  UPDATE: 'Changes',
  UNCHANGED: 'Already correct',
  INVALID: 'Cannot import',
};

const FIELD_LABELS: Record<string, string> = {
  option_1: 'Option 1',
  option_2: 'Option 2',
};

const COMPONENT_LABELS: Record<string, string> = {
  salad: 'Salad',
  other: 'Side',
  condiment: 'Condiment',
  beverage: 'Beverage',
  dessert: 'Dessert / fruit',
};

const componentLabel = (type: string) => COMPONENT_LABELS[type] ?? type;

function countByAction(rows: ImportPreviewRow[]): Record<Action, number> {
  const counts: Record<Action, number> = { CREATE: 0, UPDATE: 0, UNCHANGED: 0, INVALID: 0 };
  for (const row of rows) {
    const action = (row.preview as MenuRowPreview | null)?.action;
    if (action && action in counts) counts[action] += 1;
  }
  return counts;
}

export function AdminMenuImportPage() {
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
      { importType: 'menu', file },
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
        <h1 className="page__title">Import lunch menu</h1>
        <Link to="/admin/imports/roster" className="button button--ghost button--inline button--small">
          Roster import
        </Link>
      </div>

      {/* ---------------- step 1: choose and upload ---------------- */}
      {!batchId && (
        <section className="card">
          <h2 className="card__title">1. Choose a workbook</h2>
          <p className="panel__note">
            Upload the <strong>lunch</strong> menu workbook (.xlsx), one row per date with{' '}
            <strong>Date</strong>, <strong>Option 1</strong> and <strong>Option 2</strong>, plus the
            accompaniment columns. The lunch sheet must be named so it can be identified — a dinner
            sheet is never read as lunch. Uploading does not change anything on its own.
          </p>
          <p className="panel__note">
            “Option Meal 1” and “Option Meal 2” are accompaniments served with whichever main is
            chosen, so they are imported as components. The employee’s choice stays Option 1,
            Option 2 or No Preference.
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
                This workbook cannot be committed. Correct it and upload it again — no menu has been
                changed.
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
                  const p = row.preview as MenuRowPreview | null;
                  const action = p?.action ?? 'INVALID';
                  const changedComponents = (p?.components ?? []).filter(
                    (c) => c.action !== 'UNCHANGED'
                  );

                  return (
                    <li className="list__item" key={row.row_number}>
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

                      {((p?.changes.length ?? 0) > 0 || changedComponents.length > 0) && (
                        <ul className="changes">
                          {p?.changes.map((change) => (
                            <li key={change.field}>
                              <span className="changes__field">
                                {FIELD_LABELS[change.field] ?? change.field}
                              </span>
                              <span className="changes__from">{change.from ?? '—'}</span>
                              {' → '}
                              <span className="changes__to">{change.to ?? '—'}</span>
                            </li>
                          ))}
                          {changedComponents.map((component) => (
                            <li key={component.component_type}>
                              <span className="changes__field">
                                {componentLabel(component.component_type)}
                              </span>
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
                title="Commit this lunch menu import?"
                detail={
                  `${current.original_filename}: ${counts.CREATE} new and ${counts.UPDATE} changed ` +
                  `menu day(s); ${counts.UNCHANGED} are already correct and will not be rewritten. ` +
                  `New days are created as drafts and an existing day keeps the status it has, so ` +
                  `nothing is published or unpublished by this import. Dates not in this workbook ` +
                  `are left exactly as they are, and employees' existing lunch selections are ` +
                  `never changed.`
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
            {counts.CREATE} menu day{counts.CREATE === 1 ? '' : 's'} created and {counts.UPDATE}{' '}
            updated from {committed.original_filename}.
          </p>
          <p className="panel__note">
            New menu days are created as drafts — employees cannot select from a day until it is
            published, and this import never publishes one.
          </p>
          <div className="panel__actions">
            <button type="button" className="button button--primary" onClick={reset}>
              Import another workbook
            </button>
          </div>
        </section>
      )}

      <MenuImportHistory />
    </main>
  );
}

/** Recent menu imports, from the existing history API. No second history store. */
function MenuImportHistory() {
  const { data, isLoading, error } = useImports(10, 0, 'menu');

  return (
    <section className="card">
      <h2 className="card__title">Recent menu imports</h2>

      {isLoading && <LoadingState label="Loading history…" />}
      {error && (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'The history could not be loaded.'}
        />
      )}
      {data && data.imports.length === 0 && <EmptyState message="No menu imports yet." />}

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
