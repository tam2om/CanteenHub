/**
 * The meal choice.
 *
 * OPTION 1 IS THE DEFAULT, AND THE SCREEN SAYS SO FIRST. Everyone entitled to
 * lunch is served Option 1 unless they act; the only thing an ordinary employee
 * can opt into is Option 2. So the choice is a single checkbox - "I want
 * Option 2" - rather than two equal radio buttons that suggest nothing happens
 * until one is picked.
 *
 * A healthy-meal employee does not choose between the options at all. They
 * RESERVE the healthy meal by submitting for the date; one who does not is
 * served Option 1. Their statement says exactly that, because the cost of
 * missing it is the wrong lunch.
 *
 * PICKING IS NOT SUBMITTING. Ticking the box only marks it; the dashboard's
 * Submit button is what sends it, and an unsent tick is shown as unsent so
 * nobody leaves believing an unsubmitted change was recorded.
 */

import type { LunchChoice, SelectableLunchChoice } from '../types/index.js';
import { CHOICE_LABELS } from '../lib/format.js';

interface Props {
  /** What is marked on screen: the unsent change if there is one, else the saved choice. */
  current: LunchChoice | null;
  /** What the server currently holds. Used only to tell saved from unsent. */
  saved: LunchChoice | null;
  disabled: boolean;
  pending: LunchChoice | null;
  optionNames: Partial<Record<LunchChoice, string>>;
  onSelect: (choice: SelectableLunchChoice) => void;
  /** This employee is on the healthy meal: no options, only a reservation. */
  locked?: boolean;
}

export function MealSelection({
  current,
  saved,
  disabled,
  pending,
  optionNames,
  onSelect,
  locked = false,
}: Props) {
  const option1 = optionNames.option_1;

  if (locked) {
    const reserved = saved === 'healthy';
    return (
      <section className="choices" aria-label="Your meal">
        <p className="choices__legend">Your meal</p>

        <p className="meal-rule" role="note">
          You are on the <strong>healthy meal</strong>. To reserve it for this date, choose where
          you will collect it and press <strong>Submit</strong>. If you do not submit, you will be
          served <strong>Option 1</strong>
          {option1 ? ` (${option1})` : ''} instead.
        </p>

        <div className={`choice choice--selected choice--fixed ${reserved ? '' : 'choice--unsent'}`}>
          <span className="choice__body">
            <span className="choice__label">{CHOICE_LABELS.healthy}</span>
            <span className="choice__dish">
              {reserved ? 'Reserved for this date.' : 'Not reserved yet.'}
            </span>
          </span>
          <span className="choice__state" aria-hidden="true">
            {reserved ? '✓' : ''}
          </span>
        </div>
      </section>
    );
  }

  const wantsOption2 = current === 'option_2';
  // Ticked or unticked, but not what the server holds.
  const isUnsent = saved !== null ? current !== saved : wantsOption2;

  return (
    <section className="choices" aria-label="Your meal">
      <p className="choices__legend">Your lunch</p>

      <p className="meal-rule" role="note">
        The default meal is <strong>Option 1</strong>
        {option1 ? ` (${option1})` : ''}. If you do not check Option 2, you will be served
        Option 1.
      </p>

      <label
        className={`choice choice--check ${wantsOption2 ? 'choice--selected' : ''} ${isUnsent ? 'choice--unsent' : ''} ${pending ? 'choice--pending' : ''}`}
      >
        <input
          type="checkbox"
          className="choice__checkbox"
          checked={wantsOption2}
          disabled={disabled}
          onChange={(e) => onSelect(e.target.checked ? 'option_2' : 'option_1')}
        />
        <span className="choice__body">
          <span className="choice__label">I want Option 2 instead</span>
          {optionNames.option_2 && <span className="choice__dish">{optionNames.option_2}</span>}
        </span>
        {isUnsent && <span className="sr-only">Not submitted yet</span>}
      </label>
    </section>
  );
}
