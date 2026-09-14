/**
 * The three meal choices.
 *
 * Rendered as a radio fieldset rather than divs so keyboard navigation and
 * screen-reader grouping come from the platform. Selection state is conveyed by
 * a checkmark and a word as well as colour, since colour alone would fail for a
 * colour-blind employee reading the single most important piece of information
 * on the screen.
 *
 * PICKING IS NOT SUBMITTING. Tapping an option only marks it; the dashboard's
 * Submit button is what sends it. So the tick has to say WHICH of the two states
 * it means - "Selected" for what the kitchen currently has, "Not submitted yet"
 * for a pick still waiting - or an employee would leave the screen believing an
 * unsent choice was safely recorded.
 */

import type { LunchChoice } from '../types/index.js';
import { CHOICE_LABELS } from '../lib/format.js';

const CHOICES: LunchChoice[] = ['option_1', 'option_2', 'no_preference'];

interface Props {
  /** What is marked on screen: the unsent pick if there is one, else the saved choice. */
  current: LunchChoice | null;
  /** What the server currently holds. Used only to tell saved from unsent. */
  saved: LunchChoice | null;
  disabled: boolean;
  pending: LunchChoice | null;
  optionNames: Partial<Record<LunchChoice, string>>;
  onSelect: (choice: LunchChoice) => void;
}

export function MealSelection({
  current,
  saved,
  disabled,
  pending,
  optionNames,
  onSelect,
}: Props) {
  return (
    <fieldset className="choices" disabled={disabled}>
      <legend className="choices__legend">Choose your lunch</legend>

      {CHOICES.map((choice) => {
        const isSelected = current === choice;
        const isPending = pending === choice;
        // Marked, but not what the server holds: picked and not yet submitted.
        const isUnsent = isSelected && saved !== choice;

        return (
          <label
            key={choice}
            className={`choice ${isSelected ? 'choice--selected' : ''} ${isUnsent ? 'choice--unsent' : ''} ${isPending ? 'choice--pending' : ''}`}
          >
            <input
              type="radio"
              name="lunch-choice"
              value={choice}
              className="choice__input"
              checked={isSelected}
              disabled={disabled}
              onChange={() => onSelect(choice)}
            />
            <span className="choice__body">
              <span className="choice__label">{CHOICE_LABELS[choice]}</span>
              {optionNames[choice] && <span className="choice__dish">{optionNames[choice]}</span>}
              {choice === 'no_preference' && (
                <span className="choice__dish">Either option is fine</span>
              )}
            </span>
            <span className="choice__state" aria-hidden="true">
              {isPending ? '…' : isSelected ? '✓' : ''}
            </span>
            {isSelected && (
              <span className="sr-only">{isUnsent ? 'Chosen, not submitted yet' : 'Selected'}</span>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}
