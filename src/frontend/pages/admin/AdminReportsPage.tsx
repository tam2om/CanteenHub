/**
 * Admin lunch report.
 *
 * Answers the caterer's question for one business date: how many portions of
 * what, and who is not entitled to a meal and why.
 *
 * NO CALCULATION HAPPENS HERE. Every count, every eligibility verdict and the
 * business date itself come from the server. A browser that worked out its own
 * "today" would report the wrong day for anyone in another timezone, and a
 * browser that worked out its own eligibility would eventually disagree with
 * the screen the employee saw.
 */

import { useState } from 'react';
import { useLunchReport } from '../../hooks/useReports.js';
import { ApiError } from '../../api/client.js';
import { ErrorState, LoadingState } from '../../components/States.js';
import type { LunchReport, ReportReasonCount } from '../../types/index.js';

export function AdminReportsPage() {
  // undefined means "ask the server which date it is"; it fills in on load.
  const [date, setDate] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState('');

  const query = useLunchReport(date);
  const report = query.data;

  return (
    <main className="page">
      <div className="page__head">
        <h1 className="page__title">Lunch report</h1>
      </div>

      {/* ---------------- date selector ---------------- */}
      <section className="card">
        <div className="setting__form">
          <label className="field field--inline">
            <span className="field__label">Date</span>
            <input
              className="field__input"
              type="date"
              value={pending || report?.date || ''}
              onChange={(e) => setPending(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="button button--primary button--inline"
            onClick={() => pending && setDate(pending)}
            disabled={!pending}
          >
            Show report
          </button>
        </div>
        {report && (
          <p className="panel__note">
            Reporting <strong>{report.date}</strong>, as the server reckons the business date in{' '}
            {report.timezone}.
          </p>
        )}
      </section>

      {query.isLoading && <LoadingState label="Building the report…" />}
      {query.error && (
        <ErrorState
          message={
            query.error instanceof ApiError
              ? query.error.message
              : 'The report could not be loaded.'
          }
        />
      )}

      {report && <ReportBody report={report} />}
    </main>
  );
}

// ---------------------------------------------------------------------------

function ReportBody({ report }: { report: LunchReport }) {
  const { selections, totals, menu } = report;

  return (
    <>
      {/* ---------------- menu state ---------------- */}
      {!menu.published && (
        <section className="card">
          <h2 className="card__title">No published lunch menu</h2>
          <p className="feedback feedback--error" role="alert">
            {menu.exists
              ? `The menu for this date is ${menu.status}, so employees cannot select from it.`
              : 'There is no lunch menu for this date.'}
          </p>
          <p className="panel__note">
            Eligibility below is still real. Selection counts are zero because nobody could order —
            not because nobody wanted to.
          </p>
        </section>
      )}

      {/* ---------------- portions ---------------- */}
      <section className="card">
        <h2 className="card__title">Portions to prepare</h2>
        <ul className="summary">
          <li className="summary__item summary__item--ok">
            <span className="summary__value">{selections.option_1}</span> Option 1
          </li>
          <li className="summary__item summary__item--ok">
            <span className="summary__value">{selections.option_2}</span> Option 2
          </li>
          <li className="summary__item">
            <span className="summary__value">{selections.no_preference}</span> No preference
          </li>
          <li className="summary__item">
            <span className="summary__value">{selections.eligible_not_selected}</span> Eligible, not
            selected
          </li>
        </ul>
        <p className="panel__note">
          “No preference” is an employee’s choice, not a menu option. “Eligible, not selected”
          counts only employees who were entitled to a meal today.
        </p>
      </section>

      {/* ---------------- totals ---------------- */}
      <section className="card">
        <h2 className="card__title">Who was considered</h2>
        <ul className="summary">
          <li className="summary__item">
            <span className="summary__value">{totals.employees_considered}</span> employees
            considered
          </li>
          <li className="summary__item summary__item--ok">
            <span className="summary__value">{totals.eligible}</span> eligible
          </li>
          <li className="summary__item">
            <span className="summary__value">{totals.not_eligible}</span> not eligible
          </li>
        </ul>

        {selections.ineligible_with_selection > 0 && (
          <p className="panel__note">
            <strong>{selections.ineligible_with_selection}</strong> selection
            {selections.ineligible_with_selection === 1 ? ' is' : 's are'} held by employees who are
            not eligible on this date — usually a roster change after they ordered. They are not
            counted as portions.
          </p>
        )}
      </section>

      <ReasonTable
        title="Eligibility breakdown"
        rows={report.eligibility.by_reason}
        empty="No employees were considered for this date."
      />

      <ReasonTable
        title="Why employees were not eligible"
        rows={report.not_eligible.by_reason}
        empty="Every employee considered was eligible."
      />
    </>
  );
}

function ReasonTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: ReportReasonCount[];
  empty: string;
}) {
  return (
    <section className="card">
      <h2 className="card__title">{title}</h2>
      {rows.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Reason</th>
                <th scope="col">Code</th>
                <th scope="col">Employees</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.reason}>
                  <td>{row.label}</td>
                  {/* The authoritative code, shown alongside the wording. */}
                  <td>
                    <code className="code">{row.reason}</code>
                  </td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
