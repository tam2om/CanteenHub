/** The employee's own selection history. A clean list is enough for the MVP. */

import { useHistory } from '../hooks/useHistory.js';
import { ApiError } from '../api/client.js';
import { EmptyState, ErrorState, LoadingState } from '../components/States.js';
import { formatChoice, formatShortDate, SOURCE_LABELS } from '../lib/format.js';

export function SelectionHistoryPage() {
  const { data, isLoading, error } = useHistory();

  if (isLoading) return <LoadingState label="Loading your history…" />;
  if (error) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.message : 'We could not load your history.'}
      />
    );
  }

  return (
    <main className="page">
      <h1 className="page__title">Your selections</h1>

      {!data || data.entries.length === 0 ? (
        <EmptyState message="You have not made any lunch selections yet." />
      ) : (
        <>
          <ul className="history">
            {data.entries.map((entry) => (
              <li className="history__item" key={entry.id}>
                <div className="history__main">
                  <span className="history__date">{formatShortDate(entry.meal_date)}</span>
                  <span className="history__choice">{formatChoice(entry.new_choice)}</span>
                </div>
                <p className="history__meta">
                  {entry.previous_choice
                    ? `Changed from ${formatChoice(entry.previous_choice)}`
                    : 'First selection'}
                  {' · set by '}
                  {SOURCE_LABELS[entry.source] ?? entry.source}
                </p>
              </li>
            ))}
          </ul>
          <p className="history__count">
            Showing {data.entries.length} of {data.total}.
          </p>
        </>
      )}
    </main>
  );
}
