/**
 * Eligibility banner. Renders the server's decision and reason code as plain
 * language; it never re-derives eligibility.
 */

import type { Eligibility } from '../types/index.js';
import { eligibilityMessage, formatBusinessDate, formatTimeOfDay } from '../lib/format.js';

interface Props {
  eligibility: Eligibility;
  cutoffPassed: boolean;
  orderingOpen: boolean;
  orderingOpensOn: string;
  cutoffTime: string;
  hasMenu: boolean;
}

export function EligibilityStatus({
  eligibility,
  cutoffPassed,
  orderingOpen,
  orderingOpensOn,
  cutoffTime,
  hasMenu,
}: Props) {
  const { eligible, reason, nextEligibleDate } = eligibility;

  const tone = eligible ? (!orderingOpen || !hasMenu ? 'warn' : 'ok') : 'off';

  return (
    <section className={`status status--${tone}`} aria-live="polite">
      <p className="status__headline">
        <span className="status__dot" aria-hidden="true" />
        {eligible ? 'Eligible for lunch' : 'Not eligible for lunch'}
      </p>

      <p className="status__detail">{eligibilityMessage(reason)}</p>

      {eligible && orderingOpen && (
        <p className="status__detail">
          Ordering is open until <strong>{formatTimeOfDay(cutoffTime)}</strong> today.
        </p>
      )}

      {eligible && !orderingOpen && !cutoffPassed && (
        <p className="status__detail">
          Ordering for this date opens at 12:00 AM on{' '}
          <strong>{formatBusinessDate(orderingOpensOn)}</strong> and closes at{' '}
          <strong>{formatTimeOfDay(cutoffTime)}</strong> that day.
        </p>
      )}

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
