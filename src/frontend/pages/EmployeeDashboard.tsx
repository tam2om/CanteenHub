/**
 * The employee's main screen: identity, the day being ordered, eligibility,
 * menu, selection.
 *
 * THE DAY IS NOT TODAY. Lunch is ordered a day ahead - the kitchen buys and
 * preps for tomorrow - so this screen is always about a future meal. The server
 * decides which one (tomorrow before the cutoff, the day after once it has
 * passed) and the screen names that date everywhere rather than saying "today".
 * Ordering for a date is open from 12:00 AM the day before it until the cutoff
 * that day; the server says whether that window is open now.
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
import { formatBusinessDate, formatTimeOfDay } from '../lib/format.js';
import type { LunchChoice, MealLocation, SelectableLunchChoice } from '../types/index.js';
import {
  DEFAULT_LUNCH_CHOICE,
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
  // null means the employee has not chosen a canteen in this visit. It is NOT
  // pre-filled: see the field below.
  const [chosenLocation, setChosenLocation] = useState<MealLocation | null>(null);

  if (isLoading) return <LoadingState label="Loading your next lunch…" />;

  if (error) {
    return (
      <ErrorState
        message={
          error instanceof ApiError
            ? error.message
            : 'We could not load your next lunch. Please try again.'
        }
      />
    );
  }

  if (!data) return <ErrorState message="No data was returned. Please try again." />;

  const {
    employee,
    businessDate,
    eligibility,
    menu,
    selection,
    cutoffPassed,
    orderingOpen,
    orderingOpensOn,
    cutoffTime,
    canSelect,
    choiceLocked = false,
  } = data;

  // The window for mealDate opens at midnight; it is neither open nor past.
  const notOpenYet = !orderingOpen && !cutoffPassed;

  const optionNames: Partial<Record<LunchChoice, string>> = {
    option_1: menu?.options.find((o) => o.option_number === 1)?.name,
    option_2: menu?.options.find((o) => o.option_number === 2)?.name,
  };

  const savedChoice = selection?.choice ?? null;
  const savedLocation = selection?.pickup_location ?? null;

  // WHERE the meal is collected must be chosen, every time, and is never
  // pre-filled from the employee's usual canteen: a value that is already there
  // is a value nobody reads, and a portion sent to the wrong site is a meal
  // somebody does not get.
  const location = chosenLocation ?? savedLocation;

  // WHAT they eat has a default, because everyone entitled to a meal gets one
  // whether or not they say anything. The screen marks Option 1 up front so the
  // default is visible rather than discovered at the counter.
  const markedChoice: LunchChoice = choiceLocked
    ? 'healthy'
    : (draftChoice ?? savedChoice ?? DEFAULT_LUNCH_CHOICE);

  // Something to send: nothing submitted yet, a different meal, or the same
  // meal at a different canteen (moving where a portion goes is a change the
  // kitchen needs).
  const hasUnsentChange =
    location !== null &&
    (selection === null || markedChoice !== savedChoice || location !== savedLocation);

  const handleSelect = (choice: SelectableLunchChoice) => {
    setDraftChoice(choice);
    setFeedback(null);
  };

  const handleSubmit = () => {
    if (!location) return;
    // The server decides whether this is allowed - and what an employee on the
    // healthy meal is recorded as. The button being enabled is a convenience,
    // never the control.
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
        {/* Both dates come from the server. The browser never decides what day
            it is, and never derives tomorrow from its own clock. */}
        <div className="identity__dates">
          <p className="identity__date">Lunch for {formatBusinessDate(mealDate)}</p>
          <p className="identity__today">Today is {formatBusinessDate(businessDate)}</p>
        </div>
      </section>

      {/* Between the cut-off and midnight nothing can be ordered. The next
          date's menu stays hidden until its window opens, so nobody reads it
          as something they can choose now. */}
      {notOpenYet ? (
        <section className="status status--warn" aria-live="polite">
          <p className="status__headline">
            <span className="status__dot" aria-hidden="true" />
            Ordering is closed for now
          </p>
          <p className="status__detail">
            To choose your lunch for <strong>{formatBusinessDate(mealDate)}</strong>, please log in
            from <strong>12:00 AM on {formatBusinessDate(orderingOpensOn)}</strong> until{' '}
            <strong>{formatTimeOfDay(cutoffTime)}</strong> that day.
          </p>
        </section>
      ) : (
        <>
          <EligibilityStatus
            eligibility={eligibility}
            cutoffPassed={cutoffPassed}
            orderingOpen={orderingOpen}
            cutoffTime={cutoffTime}
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
                locked={choiceLocked}
              />

              {/* Where to collect it. Required, and deliberately empty until the
                  employee picks: this is the one thing the kitchen cannot work out
                  for itself. Like the meal, a change here is only marked until
                  Submit is pressed. */}
              <div className="field field--location">
                <label className="field__label" htmlFor="pickup-location">
                  Collect from
                </label>
                <select
                  id="pickup-location"
                  className="field__input"
                  value={location ?? ''}
                  required
                  disabled={!canSelect || select.isPending}
                  onChange={(e) => {
                    const value = e.target.value;
                    setChosenLocation(value === '' ? null : (value as MealLocation));
                    setFeedback(null);
                  }}
                >
                  <option value="">Choose a canteen…</option>
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

              {canSelect && location === null && !select.isPending && (
                <p className="feedback feedback--warn" role="status">
                  Choose where you will collect this meal before submitting.
                </p>
              )}

              <SelectionConfirmation feedback={feedback} />

              {hasUnsentChange && !select.isPending && (
                <p className="feedback feedback--warn" role="status">
                  Not submitted yet. Press &ldquo;Submit my choice&rdquo; to send it to the kitchen.
                </p>
              )}

              {selection && !feedback && !hasUnsentChange && (
                <p className="feedback feedback--muted" role="status">
                  Your choice for {formatBusinessDate(mealDate)} is saved.
                  {orderingOpen && ` You can change it until ${formatTimeOfDay(cutoffTime)} today.`}
                </p>
              )}

              {cutoffPassed && (
                <p className="feedback feedback--muted">
                  The deadline has passed for this date.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
