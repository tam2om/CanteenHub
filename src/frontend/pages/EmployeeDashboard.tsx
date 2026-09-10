/**
 * The employee's main screen: identity, business date, eligibility, menu,
 * selection. The whole task should be one tap.
 */

import { useState } from 'react';
import { useSelectMeal, useToday } from '../hooks/useToday.js';
import { ApiError } from '../api/client.js';
import { EligibilityStatus } from '../components/EligibilityStatus.js';
import { MenuCard } from '../components/MenuCard.js';
import { MealSelection } from '../components/MealSelection.js';
import {
  SelectionConfirmation,
  type SelectionFeedback,
} from '../components/SelectionConfirmation.js';
import { ErrorState, LoadingState } from '../components/States.js';
import { formatBusinessDate } from '../lib/format.js';
import type { LunchChoice } from '../types/index.js';

export function EmployeeDashboard() {
  const { data, isLoading, error } = useToday();
  const [feedback, setFeedback] = useState<SelectionFeedback | null>(null);
  const [pending, setPending] = useState<LunchChoice | null>(null);

  const mealDate = data?.mealDate ?? '';
  const select = useSelectMeal(mealDate);

  if (isLoading) return <LoadingState label="Loading today&rsquo;s lunch…" />;

  if (error) {
    return (
      <ErrorState
        message={
          error instanceof ApiError
            ? error.message
            : 'We could not load today&rsquo;s lunch. Please try again.'
        }
      />
    );
  }

  if (!data) return <ErrorState message="No data was returned. Please try again." />;

  const { employee, businessDate, eligibility, menu, selection, cutoffPassed, canSelect } = data;

  const optionNames: Partial<Record<LunchChoice, string>> = {
    option_1: menu?.options.find((o) => o.option_number === 1)?.name,
    option_2: menu?.options.find((o) => o.option_number === 2)?.name,
  };

  const handleSelect = (choice: LunchChoice) => {
    // The server decides whether this is allowed; the button being enabled is a
    // convenience, never the control.
    const previous = selection?.choice ?? null;
    setPending(choice);
    setFeedback(null);

    select.mutate(choice, {
      onSuccess: () => setFeedback({ kind: 'saved', choice, changed: previous !== choice }),
      onError: (err) =>
        setFeedback({
          kind: 'error',
          message:
            err instanceof ApiError
              ? err.message
              : 'Your selection could not be saved. Please try again.',
        }),
      onSettled: () => setPending(null),
    });
  };

  return (
    <main className="page">
      <section className="identity">
        <h1 className="identity__name">{employee.full_name}</h1>
        <p className="identity__meta">
          {employee.amco_id}
          {employee.department && ` · ${employee.department}`}
          {employee.section && ` · ${employee.section}`}
        </p>
        {/* Date comes from the server. The browser never decides what day it is. */}
        <p className="identity__date">{formatBusinessDate(businessDate)}</p>
      </section>

      <EligibilityStatus
        eligibility={eligibility}
        cutoffPassed={cutoffPassed}
        hasMenu={menu !== null}
      />

      <MenuCard menu={menu} />

      {eligibility.eligible && menu && (
        <section className="card">
          <MealSelection
            current={selection?.choice ?? null}
            disabled={!canSelect || select.isPending}
            pending={pending}
            optionNames={optionNames}
            onSelect={handleSelect}
          />

          <SelectionConfirmation feedback={feedback} />

          {selection && !feedback && (
            <p className="feedback feedback--muted" role="status">
              Your current choice is saved.
              {!cutoffPassed && ' You can change it until the deadline.'}
            </p>
          )}

          {cutoffPassed && (
            <p className="feedback feedback--muted">
              The deadline has passed for this date.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
