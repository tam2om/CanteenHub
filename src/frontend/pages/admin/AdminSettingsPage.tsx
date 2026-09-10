/**
 * Settings: lunch cutoff and company holidays.
 *
 * Neither the cutoff nor holiday eligibility is evaluated here. The cutoff is a
 * value stored and interpreted by the server in the configured business
 * timezone; holidays feed the server's eligibility service. This page reads and
 * writes those values and nothing more.
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  useAddHoliday,
  useDeleteHoliday,
  useHolidays,
  useSettings,
  useUpdateCutoff,
} from '../../hooks/useAdmin.js';
import { ApiError } from '../../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { formatBusinessDate } from '../../lib/format.js';
import type { Holiday } from '../../types/index.js';

/** Matches the HH:MM 24-hour format the server validates. */
const CUTOFF_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Settings values are JSON-encoded server-side, so the time arrives quoted. */
function unquote(value: string): string {
  return value.replace(/^"|"$/g, '');
}

export function AdminSettingsPage() {
  return (
    <main className="page">
      <h1 className="page__title">Settings</h1>
      <CutoffSection />
      <HolidaysSection />
    </main>
  );
}

function CutoffSection() {
  const { data, isLoading, error } = useSettings();
  const updateCutoff = useUpdateCutoff();

  const [value, setValue] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const currentSetting = data?.find((s) => s.key === 'lunch_cutoff_time');
  const timezoneSetting = data?.find((s) => s.key === 'timezone');
  const current = currentSetting ? unquote(currentSetting.value) : null;

  // Seed the input from the server value once it arrives. There is no default
  // baked into this component - an unconfigured cutoff shows as empty.
  useEffect(() => {
    if (current !== null) setValue(current);
  }, [current]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setClientError(null);
    setSaved(false);

    if (!CUTOFF_PATTERN.test(value)) {
      setClientError('Enter a time in 24-hour HH:MM format.');
      return;
    }

    updateCutoff.mutate(value, { onSuccess: () => setSaved(true) });
  };

  const serverError =
    updateCutoff.error instanceof ApiError
      ? updateCutoff.error.message
      : updateCutoff.error
        ? 'The cutoff could not be saved.'
        : null;

  return (
    <section className="card">
      <h2 className="card__title">Lunch cutoff</h2>

      {isLoading && <LoadingState label="Loading settings…" />}
      {error && (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'We could not load the settings.'}
        />
      )}

      {data && (
        <>
          <p className="setting__current">
            Current cutoff: <strong>{current ?? 'not configured'}</strong>
            {timezoneSetting && ` (${unquote(timezoneSetting.value)})`}
          </p>
          <p className="panel__note">
            Employees can create or change a selection until this time on the meal date. The time is
            interpreted in the company timezone by the server.
          </p>

          <form onSubmit={handleSubmit} noValidate className="setting__form">
            <label className="field field--inline field--narrow">
              <span className="field__label">New cutoff</span>
              <input
                className="field__input"
                name="cutoff_time"
                type="time"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setSaved(false);
                }}
              />
            </label>

            <button
              type="submit"
              className="button button--primary button--inline"
              disabled={updateCutoff.isPending}
            >
              {updateCutoff.isPending ? 'Saving…' : 'Save cutoff'}
            </button>
          </form>

          {(clientError || serverError) && (
            <p className="feedback feedback--error" role="alert">
              {clientError ?? serverError}
            </p>
          )}
          {saved && !serverError && (
            <p className="feedback feedback--ok" role="status">
              Cutoff updated. It applies immediately.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function HolidaysSection() {
  const { data, isLoading, error } = useHolidays();
  const addHoliday = useAddHoliday();
  const deleteHoliday = useDeleteHoliday();

  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Holiday | null>(null);

  const existingDates = new Set((data ?? []).map((h) => h.holiday_date));

  const handleAdd = (event: FormEvent) => {
    event.preventDefault();
    setClientError(null);
    setNotice(null);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setClientError('Choose a date.');
      return;
    }
    if (!name.trim()) {
      setClientError('Enter a name for the holiday.');
      return;
    }

    // The server upserts by date, so re-adding an existing date renames it
    // rather than failing. Say which happened instead of implying a new row.
    const isExisting = existingDates.has(date);

    addHoliday.mutate(
      { date, name: name.trim() },
      {
        onSuccess: () => {
          setNotice(
            isExisting
              ? `${formatBusinessDate(date)} already existed — its name was updated.`
              : `${formatBusinessDate(date)} added.`
          );
          setDate('');
          setName('');
        },
      }
    );
  };

  const addError =
    addHoliday.error instanceof ApiError
      ? addHoliday.error.message
      : addHoliday.error
        ? 'The holiday could not be saved.'
        : null;

  return (
    <section className="card">
      <h2 className="card__title">Company holidays</h2>
      <p className="panel__note">
        Nobody is eligible for a meal on these dates. Eligibility itself is decided by the server.
      </p>

      <form onSubmit={handleAdd} noValidate className="setting__form">
        <label className="field field--inline field--narrow">
          <span className="field__label">Date</span>
          <input
            className="field__input"
            name="holiday_date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>

        <label className="field field--inline">
          <span className="field__label">Name</span>
          <input
            className="field__input"
            name="holiday_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Independence Day"
          />
        </label>

        <button
          type="submit"
          className="button button--primary button--inline"
          disabled={addHoliday.isPending}
        >
          {addHoliday.isPending ? 'Adding…' : 'Add holiday'}
        </button>
      </form>

      {(clientError || addError) && (
        <p className="feedback feedback--error" role="alert">
          {clientError ?? addError}
        </p>
      )}
      {notice && !addError && (
        <p className="feedback feedback--ok" role="status">
          {notice}
        </p>
      )}

      {isLoading && <LoadingState label="Loading holidays…" />}
      {error && (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'We could not load the holidays.'}
        />
      )}

      {data && data.length === 0 && <EmptyState message="No company holidays are configured." />}

      {data && data.length > 0 && (
        <ul className="list list--tight">
          {data.map((holiday) => (
            <li className="list__item" key={holiday.holiday_date}>
              <div className="list__main">
                <div>
                  <p className="list__title">{holiday.name}</p>
                  <p className="list__meta">{formatBusinessDate(holiday.holiday_date)}</p>
                </div>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => setPendingDelete(holiday)}
                >
                  Remove
                </button>
              </div>

              {pendingDelete?.holiday_date === holiday.holiday_date && (
                <ConfirmDialog
                  title="Remove this holiday?"
                  detail={`${holiday.name} on ${formatBusinessDate(holiday.holiday_date)} will become a normal day, and eligibility will follow the usual rules again.`}
                  confirmLabel="Remove holiday"
                  destructive
                  busy={deleteHoliday.isPending}
                  onCancel={() => setPendingDelete(null)}
                  onConfirm={() =>
                    deleteHoliday.mutate(holiday.holiday_date, {
                      onSuccess: () => setPendingDelete(null),
                    })
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {deleteHoliday.isError && (
        <p className="feedback feedback--error" role="alert">
          {deleteHoliday.error instanceof ApiError
            ? deleteHoliday.error.message
            : 'The holiday could not be removed.'}
        </p>
      )}
    </section>
  );
}
