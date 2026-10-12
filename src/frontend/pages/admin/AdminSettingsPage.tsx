/**
 * Settings: lunch cutoff, the day-shift override, and company holidays.
 *
 * Neither the cutoff nor holiday eligibility is evaluated here. The cutoff is a
 * value stored and interpreted by the server in the configured business
 * timezone; holidays feed the server's eligibility service. This page reads and
 * writes those values and nothing more.
 */

import { useEffect, useState, type FormEvent } from 'react';
import {
  useAddHoliday,
  useDayShiftOverride,
  useDeleteHoliday,
  useHolidays,
  useSettings,
  useUpdateCutoff,
  useUpdateDayShiftOverride,
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
      <DayShiftOverrideSection />
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
            Employees order a day ahead: for each meal date, choices open at 12:00 AM the day before
            and close at this time that day. The time is interpreted in the company timezone by the
            server.
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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "Everyone on day shift" for a period. While it is on, shift employees who
 * are rostered Off (or have no roster yet) can order a meal for dates inside
 * the period, exactly as if they were on a day shift. The server applies it
 * when it decides eligibility and stops applying it after the end date, so
 * nothing here needs to run on a timer.
 */
function DayShiftOverrideSection() {
  const { data, isLoading, error } = useDayShiftOverride();
  const update = useUpdateDayShiftOverride();

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Seed the period from the server once it arrives; an expired period is
  // shown too, so it is easy to reuse or adjust.
  useEffect(() => {
    if (data) {
      setStartDate(data.start_date ?? '');
      setEndDate(data.end_date ?? '');
    }
  }, [data]);

  const isOn = data?.state === 'active' || data?.state === 'scheduled';

  const save = (enabled: boolean) => {
    setClientError(null);
    setNotice(null);

    if (enabled) {
      if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
        setClientError('Choose both a start date and an end date.');
        return;
      }
      if (startDate > endDate) {
        setClientError('The end date must be on or after the start date.');
        return;
      }
    }

    update.mutate(
      enabled ? { enabled, start_date: startDate, end_date: endDate } : { enabled },
      {
        onSuccess: (result) =>
          setNotice(
            result.state === 'off'
              ? 'Turned off. Everyone is back on their rostered shift.'
              : `On from ${formatBusinessDate(result.start_date!)} to ${formatBusinessDate(result.end_date!)}.`
          ),
      }
    );
  };

  const serverError =
    update.error instanceof ApiError
      ? update.error.message
      : update.error
        ? 'The setting could not be saved.'
        : null;

  return (
    <section className="card">
      <h2 className="card__title">Everyone on day shift</h2>
      <p className="panel__note">
        While this is on, shift employees who are rostered off (or have no roster yet) are treated
        as on a day shift for meal dates in the period, so they can order a meal. The usual ordering
        window still applies. After the end date it turns off by itself and everyone goes back to
        their rostered shift.
      </p>

      {isLoading && <LoadingState label="Loading setting…" />}
      {error && (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'We could not load this setting.'}
        />
      )}

      {data && (
        <>
          <p className="setting__current">
            {data.state === 'active' && (
              <>
                <strong>On</strong> until {formatBusinessDate(data.end_date!)}
              </>
            )}
            {data.state === 'scheduled' && (
              <>
                <strong>Scheduled</strong> from {formatBusinessDate(data.start_date!)} to{' '}
                {formatBusinessDate(data.end_date!)}
              </>
            )}
            {data.state === 'expired' && (
              <>
                <strong>Off</strong>: the period ended on {formatBusinessDate(data.end_date!)}
              </>
            )}
            {data.state === 'off' && <strong>Off</strong>}
          </p>

          <form
            noValidate
            className="setting__form"
            onSubmit={(event: FormEvent) => {
              event.preventDefault();
              save(true);
            }}
          >
            <label className="field field--inline field--narrow">
              <span className="field__label">From</span>
              <input
                className="field__input"
                name="override_start_date"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  setNotice(null);
                }}
              />
            </label>

            <label className="field field--inline field--narrow">
              <span className="field__label">To</span>
              <input
                className="field__input"
                name="override_end_date"
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setNotice(null);
                }}
              />
            </label>

            <label className="switch">
              <input
                className="switch__input"
                type="checkbox"
                role="switch"
                aria-label="Treat everyone as day shift"
                checked={isOn}
                disabled={update.isPending}
                onChange={(e) => save(e.target.checked)}
              />
              <span className="switch__track" aria-hidden="true" />
              {isOn ? 'On' : 'Off'}
            </label>

            {isOn && (
              <button
                type="submit"
                className="button button--ghost button--inline"
                disabled={update.isPending}
              >
                {update.isPending ? 'Saving…' : 'Update period'}
              </button>
            )}
          </form>

          {(clientError || serverError) && (
            <p className="feedback feedback--error" role="alert">
              {clientError ?? serverError}
            </p>
          )}
          {notice && !serverError && (
            <p className="feedback feedback--ok" role="status">
              {notice}
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
