/**
 * Feedback after a selection attempt: saved, unchanged, or refused.
 *
 * A refusal shows the server's own message. The portal does not decide why a
 * write was rejected; it reports what the server said.
 */

import type { LunchChoice } from '../types/index.js';
import { CHOICE_LABELS } from '../lib/format.js';

export type SelectionFeedback =
  | { kind: 'saved'; choice: LunchChoice; changed: boolean }
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
      {feedback.changed
        ? `Saved. You are down for ${CHOICE_LABELS[feedback.choice]}.`
        : `No change — you were already down for ${CHOICE_LABELS[feedback.choice]}.`}
    </p>
  );
}
