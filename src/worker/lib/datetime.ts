/**
 * Business Date/Time Utilities
 *
 * CanteenHub reasons about two different kinds of time:
 *
 *   1. Instants    - stored in the database as UTC timestamps.
 *   2. Business dates - the calendar date in the company's configured timezone.
 *      "Today's lunch" and the selection cutoff are business-date concepts and
 *      must never be derived from UTC or from the server's local timezone.
 *
 * Everything here is IANA-timezone aware via Intl, which is available in the
 * Cloudflare Workers runtime. There is deliberately no fixed +3 offset: Jordan
 * is currently UTC+3 year-round, but encoding that as a constant would silently
 * break if the policy ever changes. The timezone is a configured setting.
 *
 * No Node-only APIs are used here.
 */

/** Fallback when no `timezone` setting has been configured. */
export const DEFAULT_TIMEZONE = 'Asia/Amman';

/** A calendar date in YYYY-MM-DD form. */
export type BusinessDate = string;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a YYYY-MM-DD business date string.
 */
export function isValidBusinessDate(value: unknown): value is BusinessDate {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  // Reject impossible dates such as 2026-02-30.
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

/**
 * Throw if the timezone is not a valid IANA identifier that this runtime knows.
 * Falls back to the default rather than crashing a request on a bad setting.
 */
export function resolveTimezone(timezone: string | null | undefined): string {
  if (!timezone) {
    return DEFAULT_TIMEZONE;
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return timezone;
  } catch {
    console.error(`Invalid IANA timezone configured: ${timezone}. Falling back to ${DEFAULT_TIMEZONE}.`);
    return DEFAULT_TIMEZONE;
  }
}

/**
 * The current business date (YYYY-MM-DD) in the given IANA timezone.
 *
 * This replaces `new Date().toISOString().split('T')[0]`, which returns the UTC
 * date and is wrong for roughly three hours of every Amman day.
 */
export function getBusinessDate(timezone: string, now: Date = new Date()): BusinessDate {
  const tz = resolveTimezone(timezone);
  // 'en-CA' formats as YYYY-MM-DD, which is exactly the storage format.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Minutes since midnight in the given IANA timezone. Used for cutoff comparison.
 */
export function getBusinessTimeMinutes(timezone: string, now: Date = new Date()): number {
  const tz = resolveTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * Weekday index for a business date. 0 = Sunday ... 6 = Saturday.
 *
 * Computed from the date string via UTC arithmetic, NOT from the server's local
 * timezone. A YYYY-MM-DD string already identifies a calendar day, so no
 * timezone conversion is involved or wanted here - converting would be the bug.
 */
export function getWeekday(date: BusinessDate): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * Add (or subtract, with a negative count) whole days to a business date.
 * Pure calendar arithmetic on the date string; independent of any timezone.
 */
export function addBusinessDays(date: BusinessDate, days: number): BusinessDate {
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day));
  result.setUTCDate(result.getUTCDate() + days);
  return formatUtcAsBusinessDate(result);
}

/**
 * Compare two business dates. Negative if a < b, 0 if equal, positive if a > b.
 * YYYY-MM-DD sorts correctly lexicographically, which is one reason it is the
 * chosen storage format.
 */
export function compareBusinessDates(a: BusinessDate, b: BusinessDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function formatUtcAsBusinessDate(date: Date): BusinessDate {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
