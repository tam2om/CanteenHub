/**
 * Presentation helpers.
 *
 * IMPORTANT: nothing here computes a date. `formatBusinessDate` formats a
 * YYYY-MM-DD string the SERVER supplied, using UTC accessors so the browser's
 * own timezone cannot shift the displayed day. The portal never asks the
 * browser what day it is.
 */

import type { EligibilityReason, LunchChoice, SelectionSource } from '../types/index.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Format a server-supplied YYYY-MM-DD for display. Never derives "today". */
export function formatBusinessDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  // UTC accessors: the string already names a calendar day, so converting it
  // through the browser's timezone would be the bug, not the fix.
  const d = new Date(Date.UTC(year, month - 1, day));
  return `${WEEKDAYS[d.getUTCDay()]}, ${day} ${MONTHS[month - 1]} ${year}`;
}

export function formatShortDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  return `${String(day).padStart(2, '0')} ${MONTHS[month - 1]?.slice(0, 3)} ${year}`;
}

export const CHOICE_LABELS: Record<LunchChoice, string> = {
  option_1: 'Option 1',
  option_2: 'Option 2',
  no_preference: 'No Preference',
};

export function formatChoice(choice: LunchChoice | null): string {
  return choice ? CHOICE_LABELS[choice] : '—';
}

export const SOURCE_LABELS: Record<SelectionSource, string> = {
  employee: 'You',
  admin_override: 'Administrator',
  system: 'System',
};

/**
 * Human-readable text for each backend reason code.
 *
 * These translate the EXISTING codes. No new rule is introduced, and the wording
 * explains the situation without exposing internals.
 */
export const ELIGIBILITY_MESSAGES: Record<EligibilityReason, string> = {
  REGULAR_WORKING_DAY: 'You are eligible for lunch today.',
  SHIFT_DAY: 'You are on a day shift and eligible for lunch.',
  SHIFT_NIGHT: 'You are on a night shift and eligible for lunch.',
  REGULAR_NON_WORKING_DAY: 'This is not one of your working days, so no meal is provided.',
  SHIFT_OFF: 'You are rostered off, so no meal is provided.',
  ROSTER_MISSING: 'Your shift roster for this date has not been published yet.',
  AMMAN_HQ_NO_MEAL: 'Amman HQ employees do not receive a company meal.',
  HOLIDAY: 'This is a company holiday, so no meal is served.',
  EMPLOYEE_INACTIVE: 'Your account is not active. Please contact the canteen administrator.',
};

export function eligibilityMessage(reason: EligibilityReason): string {
  return ELIGIBILITY_MESSAGES[reason] ?? 'Meal selection is not available for this date.';
}

export const ROSTER_LABELS: Record<string, string> = {
  regular: 'Regular',
  shift: 'Shift',
  amman_hq: 'Amman HQ',
};
