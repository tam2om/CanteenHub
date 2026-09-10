/**
 * The three meal choices.
 *
 * Rendered as a radio fieldset rather than divs so keyboard navigation and
 * screen-reader grouping come from the platform. Selection state is conveyed by
 * a checkmark and the word "Selected" as well as colour, since colour alone
 * would fail for a colour-blind employee reading the single most important
 * piece of information on the screen.
 */

import type { LunchChoice } from '../types/index.js';
import { CHOICE_LABELS } from '../lib/format.js';

const CHOICES: LunchChoice[] = ['option_1', 'option_2', 'no_preference'];

interface Props {
  current: LunchChoice | null;
  disabled: boolean;
  pending: LunchChoice | null;
  optionNames: Partial<Record<LunchChoice, string>>;
  onSelect: (choice: LunchChoice) => void;
}

export function MealSelection({ current, disabled, pending, optionNames, onSelect }: Props) {
  return (
    <fieldset className="choices" disabled={disabled}>
      <legend className="choices__legend">Choose your lunch</legend>

      {CHOICES.map((choice) => {
        const isSelected = current === choice;
        const isPending = pending === choice;

        return (
          <label
            key={choice}
            className={`choice ${isSelected ? 'choice--selected' : ''} ${isPending ? 'choice--pending' : ''}`}
          >
            <input
              type="radio"
              name="lunch-choice"
              value={choice}
              className="choice__input"
              checked={isSelected}
              disabled={disabled}
              onChange={() => onSelect(choice)}
              // A radio that is already checked fires no change event, so
              // re-tapping your current choice would do nothing at all and look
              // broken. onClick makes the re-tap resolve to the server's
              // "no change" answer instead of silence.
              onClick={() => {
                if (isSelected && !disabled) onSelect(choice);
              }}
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
            {isSelected && <span className="sr-only">Selected</span>}
          </label>
        );
      })}
    </fieldset>
  );
}
