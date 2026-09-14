/**
 * The employee's main screen: identity, business date, eligibility, menu,
 * selection.
 *
 * Picking and submitting are separate. Tapping an option (or changing the
 * canteen) only marks it locally; nothing reaches the kitchen until Submit is
 * pressed. That costs one extra tap but removes the worse failure: a mis-tap
 * silently becoming the order of record.
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
import type { LunchChoice, MealLocation } from '../types/index.js';
import {
  DEFAULT_MEAL_LOCATION,
  MEAL_LOCATIONS,
  MEAL_LOCATION_LABELS,
} from '../types/index.js';

export function EmployeeDashboard() {
  const { data, isLoading, error } = useToday();
  const [feedback, setFeedback] = useState<SelectionFeedback | null>(null);
  const [pending, setPending] = useState<LunchChoice | null>(null);

  const mealDate = data?.mealDate ?? '';
  const select = useSelectMeal(mealDate);
  // The unsent pick. null means "nothing picked since the last submit", so the
  // screen falls back to showing what the server holds.
  const [draftChoice, setDraftChoice] = useState<LunchChoice | null>(null);
  const [chosenLocation, setChosenLocation] = useState<MealLocation | null>(null);

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

  // Where the meal will be collected. Seeded from the saved selection if there
  // is one, otherwise from the employee's own default - so the common case is
  // already correct and nobody has to choose every day.
  const savedChoice = selection?.choice ?? null;
  const savedLocation =
    selection?.pickup_location ?? employee.default_location ?? DEFAULT_MEAL_LOCATION;
  const location = chosenLocation ?? savedLocation;
  const markedChoice = draftChoice ?? savedChoice;

  // Something to send: a different meal, or the same meal at a different
  // canteen (moving where a portion goes is a change the kitchen needs).
  const hasUnsentChange =
    markedChoice !== null && (markedChoice !== savedChoice || location !== savedLocation);

  const handleSelect = (choice: LunchChoice) => {
    setDraftChoice(choice);
    setFeedback(null);
  };

  const handleSubmit = () => {
    if (!markedChoice) return;
    // The server decides whether this is allowed; the button being enabled is a
    // convenience, never the control.
    const choice = markedChoice;
    setPending(choice);
    setFeedback(null);

    select.mutate(
      { choice, pickupLocation: location },
      {
        onSuccess: () => {
          // Back to showing the server's own state.
          setDraftChoice(null);
          setChosenLocation(null);
          setFeedback({ kind: 'saved', choice, location });
        },
        onError: (err) =>
          setFeedback({
            kind: 'error',
            message:
              err instanceof ApiError
                ? err.message
                : 'Your selection could not be saved. Please try again.',
          }),
        onSettled: () => setPending(null),
      }
    );
  };

  return (
    <main className="page page--dashboard">
      <section className="identity">
        <div>
          <h1 className="identity__name">{employee.full_name}</h1>
          <p className="identity__meta">
            {employee.amco_id}
            {employee.department && ` · ${employee.department}`}
            {employee.section && ` · ${employee.section}`}
          </p>
        </div>
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
            current={markedChoice}
            saved={savedChoice}
            disabled={!canSelect || select.isPending}
            pending={pending}
            optionNames={optionNames}
            onSelect={handleSelect}
          />

          {/* Where to collect it. Like the meal itself, a change here is only
              marked until Submit is pressed. */}
          <div className="field field--location">
            <label className="field__label" htmlFor="pickup-location">
              Collect from
            </label>
            <select
              id="pickup-location"
              className="field__input"
              value={location}
              disabled={!canSelect || select.isPending}
              onChange={(e) => {
                setChosenLocation(e.target.value as MealLocation);
                setFeedback(null);
              }}
            >
              {MEAL_LOCATIONS.map((value) => (
                <option key={value} value={value}>
                  {MEAL_LOCATION_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              disabled={!canSelect || select.isPending || !hasUnsentChange}
              onClick={handleSubmit}
            >
              {select.isPending ? 'Submitting…' : 'Submit my choice'}
            </button>
          </div>

          <SelectionConfirmation feedback={feedback} />

          {hasUnsentChange && !select.isPending && (
            <p className="feedback feedback--warn" role="status">
              Not submitted yet. Press &ldquo;Submit my choice&rdquo; to send it to the kitchen.
            </p>
          )}

          {selection && !feedback && !hasUnsentChange && (
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
