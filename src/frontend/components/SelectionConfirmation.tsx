/**
 * Feedback after a submitted selection: saved, or refused.
 *
 * A refusal shows the server's own message. The portal does not decide why a
 * write was rejected; it reports what the server said.
 *
 * There is no "no change" case: the Submit button is only enabled when
 * something actually differs from what the server holds, so anything that
 * reaches here is a real change. The confirmation names both halves of it -
 * the meal and the canteen - because the employee just chose both.
 */

import type { LunchChoice, MealLocation } from '../types/index.js';
import { MEAL_LOCATION_LABELS } from '../types/index.js';
import { CHOICE_LABELS } from '../lib/format.js';

export type SelectionFeedback =
  | { kind: 'saved'; choice: LunchChoice; location: MealLocation }
  | { kind: 'error'; message: string };

export function SelectionConfirmation({ feedback }: { feedback: SelectionFeedback | null }) {
  if (!feedback) return null;

  if (feedback.kind === 'error') {
    return (
      <p className="feedback feedback--error" role="alert">
        {feedback.message}
      </p>
    );
  }

  return (
    <p className="feedback feedback--ok" role="status">
      {`Submitted. You are down for ${CHOICE_LABELS[feedback.choice]} at ${MEAL_LOCATION_LABELS[feedback.location]}.`}
    </p>
  );
}
