// @vitest-environment node
/**
 * Unit Tests - Business date/time utilities
 *
 * Focused on the cases where UTC and Asia/Amman fall on DIFFERENT calendar days,
 * which is precisely where the old `toISOString().split('T')[0]` shortcut was wrong.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  getBusinessDate,
  getBusinessTimeMinutes,
  getWeekday,
  addBusinessDays,
  compareBusinessDates,
  isValidBusinessDate,
  resolveTimezone,
} from '../../src/worker/lib/datetime.js';

describe('Business date utilities', () => {
  describe('the default timezone', () => {
    it('is Asia/Amman', () => {
      expect(DEFAULT_TIMEZONE).toBe('Asia/Amman');
    });

    it('falls back to the default for an unknown timezone rather than throwing', () => {
      expect(resolveTimezone('Mars/Olympus_Mons')).toBe('Asia/Amman');
      expect(resolveTimezone(null)).toBe('Asia/Amman');
      expect(resolveTimezone('')).toBe('Asia/Amman');
    });

    it('honours a valid non-default IANA zone', () => {
      expect(resolveTimezone('Europe/London')).toBe('Europe/London');
    });
  });

  describe('UTC and Asia/Amman disagree about the date', () => {
    it('22:30 UTC is ALREADY the next day in Amman', () => {
      const instant = new Date('2026-10-15T22:30:00Z');

      expect(instant.toISOString().split('T')[0]).toBe('2026-10-15'); // the old, wrong answer
      expect(getBusinessDate('Asia/Amman', instant)).toBe('2026-10-16'); // the correct one
    });

    it('21:00 UTC is already the next day in Amman (UTC+3 boundary)', () => {
      const instant = new Date('2026-10-15T21:00:00Z');
      expect(getBusinessDate('Asia/Amman', instant)).toBe('2026-10-16');
    });

    it('20:59 UTC is still the same day in Amman', () => {
      const instant = new Date('2026-10-15T20:59:00Z');
      expect(getBusinessDate('Asia/Amman', instant)).toBe('2026-10-15');
    });

    it('the divergence crosses a month boundary', () => {
      const instant = new Date('2026-09-30T22:00:00Z');
      expect(instant.toISOString().split('T')[0]).toBe('2026-09-30');
      expect(getBusinessDate('Asia/Amman', instant)).toBe('2026-10-01');
    });

    it('the divergence crosses a year boundary', () => {
      const instant = new Date('2026-12-31T23:00:00Z');
      expect(getBusinessDate('Asia/Amman', instant)).toBe('2027-01-01');
    });

    it('early-morning UTC is the same Amman day', () => {
      const instant = new Date('2026-10-16T01:00:00Z');
      expect(getBusinessDate('Asia/Amman', instant)).toBe('2026-10-16');
    });
  });

  describe('the implementation is genuinely timezone-driven, not a fixed +3', () => {
    it('produces a different date for a different configured zone', () => {
      const instant = new Date('2026-10-15T22:30:00Z');

      expect(getBusinessDate('Asia/Amman', instant)).toBe('2026-10-16');
      expect(getBusinessDate('UTC', instant)).toBe('2026-10-15');
      expect(getBusinessDate('America/New_York', instant)).toBe('2026-10-15');
      expect(getBusinessDate('Pacific/Kiritimati', instant)).toBe('2026-10-16');
    });

    it('respects daylight saving in a zone that observes it', () => {
      // Europe/London is UTC+1 in July, UTC+0 in January. A fixed-offset
      // implementation could not produce both of these answers.
      const summer = new Date('2026-07-15T23:30:00Z');
      const winter = new Date('2026-01-15T23:30:00Z');

      expect(getBusinessDate('Europe/London', summer)).toBe('2026-07-16');
      expect(getBusinessDate('Europe/London', winter)).toBe('2026-01-15');
    });
  });

  describe('getBusinessTimeMinutes', () => {
    it('reports Amman wall-clock minutes, not UTC minutes', () => {
      // 07:30 UTC is 10:30 in Amman = 630 minutes.
      const instant = new Date('2026-10-15T07:30:00Z');
      expect(getBusinessTimeMinutes('Asia/Amman', instant)).toBe(630);
      expect(getBusinessTimeMinutes('UTC', instant)).toBe(450);
    });

    it('handles midnight correctly (00:00 is 0, not 1440)', () => {
      const instant = new Date('2026-10-15T21:00:00Z'); // 00:00 Amman
      expect(getBusinessTimeMinutes('Asia/Amman', instant)).toBe(0);
    });

    it('handles the hour before midnight', () => {
      const instant = new Date('2026-10-15T20:45:00Z'); // 23:45 Amman
      expect(getBusinessTimeMinutes('Asia/Amman', instant)).toBe(23 * 60 + 45);
    });
  });

  describe('getWeekday', () => {
    it('maps Sunday to 0 and Saturday to 6', () => {
      expect(getWeekday('2026-09-06')).toBe(0); // Sunday
      expect(getWeekday('2026-09-07')).toBe(1); // Monday
      expect(getWeekday('2026-09-10')).toBe(4); // Thursday
      expect(getWeekday('2026-09-11')).toBe(5); // Friday
      expect(getWeekday('2026-09-12')).toBe(6); // Saturday
    });

    it('does not depend on the server timezone', () => {
      // A bare date string identifies a calendar day; converting it through a
      // timezone would be the bug, not the fix.
      const original = process.env.TZ;
      try {
        process.env.TZ = 'Pacific/Kiritimati';
        expect(getWeekday('2026-09-06')).toBe(0);
        process.env.TZ = 'Pacific/Niue';
        expect(getWeekday('2026-09-06')).toBe(0);
      } finally {
        process.env.TZ = original;
      }
    });
  });

  describe('addBusinessDays', () => {
    it('adds days within a month', () => {
      expect(addBusinessDays('2026-09-06', 1)).toBe('2026-09-07');
      expect(addBusinessDays('2026-09-06', 30)).toBe('2026-10-06');
    });

    it('crosses month and year boundaries', () => {
      expect(addBusinessDays('2026-09-30', 1)).toBe('2026-10-01');
      expect(addBusinessDays('2026-12-31', 1)).toBe('2027-01-01');
    });

    it('handles leap years', () => {
      expect(addBusinessDays('2028-02-28', 1)).toBe('2028-02-29');
      expect(addBusinessDays('2028-02-29', 1)).toBe('2028-03-01');
      expect(addBusinessDays('2027-02-28', 1)).toBe('2027-03-01');
    });

    it('subtracts with a negative count', () => {
      expect(addBusinessDays('2026-10-01', -1)).toBe('2026-09-30');
    });
  });

  describe('compareBusinessDates', () => {
    it('orders dates correctly', () => {
      expect(compareBusinessDates('2026-09-06', '2026-09-07')).toBeLessThan(0);
      expect(compareBusinessDates('2026-09-07', '2026-09-06')).toBeGreaterThan(0);
      expect(compareBusinessDates('2026-09-06', '2026-09-06')).toBe(0);
      expect(compareBusinessDates('2026-12-31', '2027-01-01')).toBeLessThan(0);
    });
  });

  describe('isValidBusinessDate', () => {
    it('accepts well-formed dates', () => {
      expect(isValidBusinessDate('2026-09-06')).toBe(true);
      expect(isValidBusinessDate('2028-02-29')).toBe(true); // leap year
    });

    it('rejects malformed and impossible dates', () => {
      expect(isValidBusinessDate('2026-9-6')).toBe(false);
      expect(isValidBusinessDate('06-09-2026')).toBe(false);
      expect(isValidBusinessDate('2026-02-30')).toBe(false);
      expect(isValidBusinessDate('2027-02-29')).toBe(false); // not a leap year
      expect(isValidBusinessDate('2026-13-01')).toBe(false);
      expect(isValidBusinessDate('not-a-date')).toBe(false);
      expect(isValidBusinessDate('')).toBe(false);
      expect(isValidBusinessDate(null)).toBe(false);
      expect(isValidBusinessDate(20260906)).toBe(false);
    });
  });
});
