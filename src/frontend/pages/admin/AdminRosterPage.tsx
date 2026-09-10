/**
 * Admin roster management.
 *
 * Shows every employee's roster standing for one date — including the ones with
 * no entry at all, which are exactly the people an administrator opens this
 * screen to find — and lets them correct it by hand. The Excel importer remains
 * the bulk mechanism; this is for the corrections between imports.
 *
 * NO ELIGIBILITY RULE LIVES HERE. This screen records Day, Night or Off. What
 * that earns an employee is the server's eligibility service's business, and
 * duplicating it here is how a screen starts disagreeing with the meal counts.
 *
 * "Missing" is NOT "Off". Off is a decision someone made; missing is the
 * absence of one, and the two produce different eligibility reasons. The screen
 * keeps them visibly distinct.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useRemoveRosterEntry,
  useRosterDay,
  useSetRosterEntry,
} from '../../hooks/useAdminRoster.js';
import { ApiError } from '../../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../../components/States.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import type { RosterDayRow, ShiftValue } from '../../types/index.js';

const SHIFTS: ShiftValue[] = ['day', 'night', 'off'];

const SHIFT_LABELS: Record<ShiftValue, string> = {
  day: 'Day',
  night: 'Night',
  off: 'Off',
};

const ROSTER_TYPE_LABELS: Record<string, string> = {
  regular: 'Regular',
  shift: 'Shift',
  amman_hq: 'Amman HQ',
};

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : error ? fallback : null;

export function AdminRosterPage() {
  // undefined means "ask the server which date it is"; it fills in on load.
  const [date, setDate] = useState<string | undefined>(undefined);
  const [pendingDate, setPendingDate] = useState('');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [rosterType, setRosterType] = useState('');

  const query = useRosterDay({ date, search: appliedSearch, rosterType });
  const data = query.data;

  const applyFilters = () => {
    setAppliedSearch(search.trim());
    if (pendingDate) setDate(pendingDate);
  };

  return (
    <main className="page">
      <div className="page__head">
        <h1 className="page__title">Roster</h1>
        <Link to="/admin/imports/roster" className="button button--ghost button--inline button--small">
          Import roster
        </Link>
      </div>

      {/* ---------------- filters ---------------- */}
      <section className="card">
        <div className="setting__form">
          <label className="field field--inline">
            <span className="field__label">Date</span>
            <input
              className="field__input"
              type="date"
              value={pendingDate || data?.date || ''}
              onChange={(e) => setPendingDate(e.target.value)}
            />
          </label>
          <label className="field field--inline">
            <span className="field__label">Search</span>
            <input
              className="field__input"
              type="search"
              placeholder="Name or AMCO ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="field field--inline">
            <span className="field__label">Roster type</span>
            <select
              className="field__input"
              value={rosterType}
              onChange={(e) => setRosterType(e.target.value)}
            >
              <option value="">All</option>
              <option value="regular">Regular</option>
              <option value="shift">Shift</option>
              <option value="amman_hq">Amman HQ</option>
            </select>
          </label>
          <button type="button" className="button button--primary button--inline" onClick={applyFilters}>
            Show roster
          </button>
        </div>
        {data && (
          <p className="panel__note">
            Showing <strong>{data.date}</strong>, as the server reckons the business date. Searching
            and filtering happen on the server.
          </p>
        )}
      </section>

      {query.isLoading && <LoadingState label="Loading the roster…" />}
      {query.error && (
        <ErrorState
          message={
            query.error instanceof ApiError ? query.error.message : 'The roster could not be loaded.'
          }
        />
      )}

      {data && data.employees.length === 0 && (
        <EmptyState message="No employees match these filters." />
      )}

      {data && data.employees.length > 0 && (
        <section className="card">
          <h2 className="card__title">{data.employees.length} employees</h2>
          <ul className="list list--tight">
            {data.employees.map((row) => (
              <RosterRow key={row.employee_id} row={row} date={data.date} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

// ---------------------------------------------------------------------------

function RosterRow({ row, date }: { row: RosterDayRow; date: string }) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const setEntry = useSetRosterEntry();
  const removeEntry = useRemoveRosterEntry();

  const missing = row.shift_value === null;
  const busy = setEntry.isPending || removeEntry.isPending;

  const failure =
    errorMessage(setEntry.error, 'The roster entry could not be saved.') ??
    errorMessage(removeEntry.error, 'The roster entry could not be removed.');

  return (
    <li className="list__item" data-testid={`roster-${row.amco_id}`}>
      <div className="list__main">
        <div>
          <p className="list__title">
            {row.full_name} — {row.amco_id}
          </p>
          <p className="list__meta">
            {ROSTER_TYPE_LABELS[row.roster_type] ?? row.roster_type}
            {row.department && ` · ${row.department}`}
            {row.section && ` · ${row.section}`}
            {row.source && ` · set by ${row.source}`}
          </p>
        </div>
        {/* Missing is shown as its own state, never as "Off". */}
        <span
          className={`tag ${missing ? 'tag--off' : 'tag--ok'}`}
          data-testid={`status-${row.amco_id}`}
        >
          {missing ? 'No roster' : SHIFT_LABELS[row.shift_value!]}
        </span>
      </div>

      {failure && (
        <p className="feedback feedback--error" role="alert">
          {failure}
        </p>
      )}

      {confirmingRemove ? (
        <ConfirmDialog
          title={`Remove the roster entry for ${row.full_name}?`}
          detail={
            `${row.amco_id} on ${date} will have NO roster entry — which is not the same as ` +
            'being rostered off. A shift employee with no entry is reported as roster missing. ' +
            'Their meal selections are not affected.'
          }
          confirmLabel="Remove entry"
          destructive
          busy={removeEntry.isPending}
          onCancel={() => setConfirmingRemove(false)}
          onConfirm={() =>
            removeEntry.mutate(
              { employeeId: row.employee_id, workDate: date },
              { onSettled: () => setConfirmingRemove(false) }
            )
          }
        />
      ) : (
        <div className="panel__actions">
          {SHIFTS.map((shift) => (
            <button
              key={shift}
              type="button"
              className={`button button--inline button--small ${
                row.shift_value === shift ? 'button--primary' : 'button--ghost'
              }`}
              aria-pressed={row.shift_value === shift}
              disabled={busy}
              onClick={() =>
                setEntry.mutate({
                  employeeId: row.employee_id,
                  workDate: date,
                  shiftValue: shift,
                })
              }
            >
              {SHIFT_LABELS[shift]}
            </button>
          ))}
          {!missing && (
            <button
              type="button"
              className="button button--ghost button--inline button--small"
              disabled={busy}
              onClick={() => setConfirmingRemove(true)}
            >
              Remove
            </button>
          )}
        </div>
      )}
    </li>
  );
}
