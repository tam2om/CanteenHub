/**
 * Eligibility banner. Renders the server's decision and reason code as plain
 * language; it never re-derives eligibility.
 */

import type { Eligibility } from '../types/index.js';
import { eligibilityMessage, formatBusinessDate } from '../lib/format.js';

interface Props {
  eligibility: Eligibility;
  cutoffPassed: boolean;
  hasMenu: boolean;
}

export function EligibilityStatus({ eligibility, cutoffPassed, hasMenu }: Props) {
  const { eligible, reason, nextEligibleDate } = eligibility;

  const tone = eligible ? (cutoffPassed || !hasMenu ? 'warn' : 'ok') : 'off';

  return (
    <section className={`status status--${tone}`} aria-live="polite">
      <p className="status__headline">
        <span className="status__dot" aria-hidden="true" />
        {eligible ? 'Eligible for lunch' : 'Not eligible for lunch'}
      </p>

      <p className="status__detail">{eligibilityMessage(reason)}</p>

      {eligible && cutoffPassed && (
        <p className="status__detail">
          The selection deadline for this date has passed, so your choice can no longer be changed.
        </p>
      )}

      {!eligible && (
        <p className="status__detail status__next">
          {nextEligibleDate
            ? <>Your next meal is on <strong>{formatBusinessDate(nextEligibleDate)}</strong>.</>
            : 'No upcoming eligible meal is currently scheduled.'}
        </p>
      )}
    </section>
  );
}
