/**
 * Lunch reporting.
 *
 * Answers one question for one business date: how many portions of what, and
 * who was not entitled to a meal and why.
 *
 * NO ELIGIBILITY RULE LIVES HERE. Every verdict comes from
 * `domain/eligibility.ts` - the same pure function the employee portal and the
 * selection endpoint use - fed with real data by this module. A report that
 * decided eligibility for itself would eventually disagree with the screen the
 * employee saw, and the caterer would cook to the wrong number.
 *
 * SET-BASED BY DESIGN. The whole report is a fixed handful of queries whatever
 * the headcount: employees, that date's roster rows, that date's selections,
 * the menu day, plus the settings and holidays the config loader reads. There
 * is no per-employee query - D1 allows 50 per invocation on the free plan, and
 * a per-employee lookup would exhaust that at 50 people.
 *
 * READ-ONLY. Nothing is written: no snapshot table, no cached row, no audit
 * entry. The report is derived from current state every time, so it cannot
 * drift from the database it describes.
 */

import type { D1Database } from '@cloudflare/workers-types';
import type {
  Employee,
  EligibilityDenialReason,
  EligibilityReason,
  LunchChoice,
  MealLocation,
  MealPreference,
  RosterEntry,
} from '../../shared/types/index.js';

/**
 * Every reason code the eligibility engine can return, eligible or not.
 *
 * The shared types split these into two unions because a verdict's shape
 * differs; a report counts them side by side, so it needs the whole set.
 */
export type AnyEligibilityReason = EligibilityReason | EligibilityDenialReason;
import {
  DEFAULT_LUNCH_CHOICE,
  DEFAULT_MEAL_LOCATION,
  MEAL_LOCATIONS,
  MEAL_LOCATION_LABELS,
} from '../../shared/types/index.js';
import { computeEligibility } from '../domain/eligibility.js';
import { loadEligibilityConfig } from './eligibility.service.js';
import type { BusinessDate } from '../lib/datetime.js';

/**
 * Administrator-facing wording for the existing reason codes.
 *
 * The frontend already has an employee-facing map ("You are rostered off..."),
 * which reads wrongly in a report about other people. These are the same codes,
 * described in the third person - no new code is introduced, and none is
 * dropped.
 */
export const REASON_LABELS: Record<AnyEligibilityReason, string> = {
  REGULAR_WORKING_DAY: 'Regular employee on a working day',
  SHIFT_DAY: 'Shift employee on a day shift',
  SHIFT_NIGHT: 'Shift employee on a night shift',
  REGULAR_NON_WORKING_DAY: 'Regular employee, not a working day',
  SHIFT_OFF: 'Shift employee rostered off',
  ROSTER_MISSING: 'Shift employee with no roster entry for this date',
  AMMAN_HQ_NO_MEAL: 'Amman HQ employee — no company meal',
  HOLIDAY: 'Company holiday',
  EMPLOYEE_INACTIVE: 'Employee is not active',
};

export interface ReasonCount {
  reason: AnyEligibilityReason;
  label: string;
  count: number;
}

/** One canteen's portion counts for a date. */
export interface LocationCount {
  location: MealLocation;
  label: string;
  option_1: number;
  option_2: number;
  /** Employees an administrator has put on the healthy meal. */
  healthy: number;
  /** option_1 + option_2 + healthy: portions to send to this canteen. */
  total: number;
  /**
   * How many of this canteen's option_1 portions come from employees who never
   * chose. They ARE counted and cooked for - not choosing means Option 1 - but
   * the kitchen can see how much of the count is a default rather than a
   * decision, which is the difference between "120 people asked for this" and
   * "40 asked and 80 said nothing".
   */
  defaulted_to_option_1: number;
}

export interface LunchReport {
  date: BusinessDate;
  /** The IANA timezone the business date was resolved in. */
  timezone: string;
  menu: {
    exists: boolean;
    /** Only a PUBLISHED menu is selectable; draft and archived are not. */
    published: boolean;
    status: string | null;
  };
  totals: {
    employees_considered: number;
    eligible: number;
    not_eligible: number;
  };
  selections: {
    option_1: number;
    option_2: number;
    /** Employees on the healthy meal, who never choose between the options. */
    healthy: number;
    /**
     * Eligible employees who made no selection. They are cooked for as Option 1
     * and are already included in `option_1` above; this is how many of that
     * number chose nothing. Never includes ineligible employees.
     */
    defaulted_to_option_1: number;
    /**
     * Healthy-meal employees who did NOT reserve this date by submitting. They
     * are served Option 1 and are already inside both `option_1` and
     * `defaulted_to_option_1`; this says how many of those are healthy-meal
     * people, so a missing reservation can be chased before the cutoff.
     */
    healthy_not_confirmed: number;
    /**
     * Selections held by employees who are NOT eligible on this date - for
     * instance someone whose roster changed after they ordered. Surfaced rather
     * than silently dropped, but deliberately kept out of the portion counts:
     * the caterer cooks for who is entitled today.
     */
    ineligible_with_selection: number;
  };
  /**
   * Portions per canteen - the number the kitchen actually dispatches on.
   *
   * Every location appears, including those with no orders, so a zero is
   * visibly a zero rather than a missing row somebody has to notice.
   */
  by_location: LocationCount[];
  eligibility: {
    /** Every reason seen on this date, eligible and not, with counts. */
    by_reason: ReasonCount[];
  };
  not_eligible: {
    by_reason: ReasonCount[];
  };
}

/**
 * The only employee columns the report needs.
 *
 * `computeEligibility` reads `is_active` and `roster_type`; `id` joins the
 * roster and selection rows. Name and AMCO ID are deliberately NOT selected -
 * the report is counts only, and PII that is never fetched cannot leak through
 * a future change to the response shape.
 */
type ReportEmployee = Pick<
  Employee,
  'id' | 'roster_type' | 'is_active' | 'default_location' | 'meal_preference'
>;

/**
 * What the kitchen serves ONE ELIGIBLE employee on a date - the single rule
 * behind both the totals and the per-person Excel sheet, so the two can never
 * disagree.
 *
 * OPTION 1 IS EVERYONE'S DEFAULT. Every eligible employee is served exactly one
 * meal; what they get depends on what they submitted for that date:
 *
 *   - nothing submitted          -> Option 1
 *   - submitted, ordinary        -> what they submitted (Option 2, or Option 1)
 *   - submitted, healthy meal    -> the healthy meal, whatever the row says
 *
 * A healthy-meal employee therefore has to RESERVE the day by submitting; one
 * who does not is served Option 1 like anybody else who said nothing. (An
 * earlier version served them nothing at all; the business rule is that
 * nobody entitled to lunch goes without one.)
 *
 * ONLY WHEN LUNCH IS BEING SERVED. With no published menu there is no Option 1
 * to cook, and counting a default portion of it would fabricate a number the
 * kitchen then prepares for. An explicit selection row (which only an
 * administrator's override can create without a published menu) is still
 * honoured; the default is not applied. `null` means nothing is served.
 */
export function servedMeal(
  preference: MealPreference,
  choice: LunchChoice | null,
  menuPublished: boolean
): LunchChoice | null {
  if (choice === null) return menuPublished ? DEFAULT_LUNCH_CHOICE : null;
  return preference === 'healthy' ? 'healthy' : choice;
}

/**
 * Build the lunch report for one business date.
 *
 * `date` must already be a validated business date; the caller owns that, and
 * the value is always bound as a parameter, never interpolated into SQL.
 */
export async function buildLunchReport(
  db: D1Database,
  date: BusinessDate
): Promise<LunchReport> {
  // ---- one pass of set-based reads --------------------------------------
  const [employeeRows, rosterRows, selectionRows, menuRow, config] = await Promise.all([
    // Every employee is "considered", inactive included: EMPLOYEE_INACTIVE is
    // itself a reported reason, so excluding them here would hide people.
    db
      .prepare(
        'SELECT id, roster_type, is_active, default_location, meal_preference FROM employees'
      )
      .all<ReportEmployee>(),
    // Indexed on work_date; only this date's rows are read.
    db
      .prepare(
        'SELECT employee_id, work_date, shift_value FROM roster_entries WHERE work_date = ? AND deleted_at IS NULL'
      )
      .bind(date)
      .all<{ employee_id: number; work_date: string; shift_value: RosterEntry['shift_value'] }>(),
    // Indexed on meal_date.
    db
      .prepare(
        'SELECT employee_id, choice, pickup_location FROM lunch_selections WHERE meal_date = ?'
      )
      .bind(date)
      .all<{ employee_id: number; choice: LunchChoice; pickup_location: MealLocation }>(),
    db
      .prepare('SELECT id, status FROM menu_days WHERE meal_date = ?')
      .bind(date)
      .first<{ id: number; status: string }>(),
    loadEligibilityConfig(db),
  ]);

  const employees = employeeRows.results || [];
  const menuPublished = menuRow?.status === 'published';

  const rosterByEmployee = new Map<number, RosterEntry>();
  for (const row of rosterRows.results || []) {
    rosterByEmployee.set(row.employee_id, row as unknown as RosterEntry);
  }

  const choiceByEmployee = new Map<number, LunchChoice>();
  const locationByEmployee = new Map<number, MealLocation>();
  for (const row of selectionRows.results || []) {
    choiceByEmployee.set(row.employee_id, row.choice);
    locationByEmployee.set(row.employee_id, row.pickup_location ?? DEFAULT_MEAL_LOCATION);
  }

  // Seeded with every canteen so a site with no orders still reports a zero.
  const byLocation = new Map<MealLocation, Omit<LocationCount, 'location' | 'label'>>(
    MEAL_LOCATIONS.map((location) => [
      location,
      { option_1: 0, option_2: 0, healthy: 0, total: 0, defaulted_to_option_1: 0 },
    ])
  );

  // ---- classify in memory, using the ONE authoritative rule engine -------
  const counts = { option_1: 0, option_2: 0, healthy: 0 };
  let eligible = 0;
  let defaultedToOption1 = 0;
  let healthyNotConfirmed = 0;
  let ineligibleWithSelection = 0;

  const byReason = new Map<AnyEligibilityReason, number>();
  const notEligibleByReason = new Map<AnyEligibilityReason, number>();

  for (const employee of employees) {
    const verdict = computeEligibility({
      // The domain function reads only these fields; the row carries no more.
      employee: employee as unknown as Employee,
      mealDate: date,
      rosterEntry: rosterByEmployee.get(employee.id) ?? null,
      workingDays: config.workingDays,
      holidays: config.holidays,
    });

    byReason.set(verdict.reason, (byReason.get(verdict.reason) ?? 0) + 1);

    const choice = choiceByEmployee.get(employee.id) ?? null;

    if (!verdict.eligible) {
      notEligibleByReason.set(verdict.reason, (notEligibleByReason.get(verdict.reason) ?? 0) + 1);
      // Counted separately, never as a portion and never as "not selected".
      if (choice) ineligibleWithSelection += 1;
      continue;
    }

    eligible += 1;

    // The location recorded ON THE SELECTION is authoritative. Only an employee
    // with no selection falls back to their current default.
    const location =
      locationByEmployee.get(employee.id) ?? employee.default_location ?? DEFAULT_MEAL_LOCATION;
    const bucket = byLocation.get(location) ?? byLocation.get(DEFAULT_MEAL_LOCATION)!;

    // WHAT THIS PERSON IS COOKED FOR - see `servedMeal`. When lunch is being
    // served, every eligible employee contributes exactly one portion, which
    // is what makes `total` a number the kitchen can load a trolley from.
    const served = servedMeal(employee.meal_preference, choice, menuPublished);
    if (served === null) continue;

    counts[served] += 1;
    bucket[served] += 1;
    bucket.total += 1;

    // Served the default because nothing was submitted - including a
    // healthy-meal employee who did not reserve the day.
    if (choice === null) {
      defaultedToOption1 += 1;
      bucket.defaulted_to_option_1 += 1;
      if (employee.meal_preference === 'healthy') healthyNotConfirmed += 1;
    }
  }

  const toReasonCounts = (map: Map<AnyEligibilityReason, number>): ReasonCount[] =>
    [...map.entries()]
      .map(([reason, count]) => ({ reason, label: REASON_LABELS[reason], count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const locationCounts: LocationCount[] = MEAL_LOCATIONS.map((location) => ({
    location,
    label: MEAL_LOCATION_LABELS[location],
    ...byLocation.get(location)!,
  }));

  return {
    date,
    timezone: config.timezone,
    by_location: locationCounts,
    menu: {
      exists: menuRow !== null,
      published: menuRow?.status === 'published',
      status: menuRow?.status ?? null,
    },
    totals: {
      employees_considered: employees.length,
      eligible,
      not_eligible: employees.length - eligible,
    },
    selections: {
      ...counts,
      defaulted_to_option_1: defaultedToOption1,
      healthy_not_confirmed: healthyNotConfirmed,
      ineligible_with_selection: ineligibleWithSelection,
    },
    eligibility: { by_reason: toReasonCounts(byReason) },
    not_eligible: { by_reason: toReasonCounts(notEligibleByReason) },
  };
}

// ============================================================================
// DETAIL - for the Excel export only
// ============================================================================

/**
 * One row per employee behind the totals.
 *
 * SEPARATE from `buildLunchReport` on purpose. The JSON report is counts only
 * and deliberately fetches no names, so PII cannot leak through a later change
 * to its response shape. This function DOES read identity, because a kitchen
 * sheet has to say who is collecting what - so it is called from exactly one
 * place, the admin-only Excel export.
 */
export interface LunchReportRow {
  amco_id: string;
  full_name: string;
  department: string | null;
  section: string | null;
  roster_type: string;
  eligible: boolean;
  reason: AnyEligibilityReason;
  reason_label: string;
  /** What this employee actually chose. `null` means they chose nothing. */
  choice: LunchChoice | null;
  /**
   * What the kitchen serves them: the healthy meal if they are on it, their own
   * choice otherwise, and Option 1 if they made none. `null` only when they are
   * not eligible on this date and so get nothing.
   */
  served: LunchChoice | null;
  meal_preference: MealPreference;
  location: MealLocation;
  location_label: string;
}

export async function buildLunchReportDetail(
  db: D1Database,
  date: BusinessDate
): Promise<LunchReportRow[]> {
  const [employeeRows, rosterRows, selectionRows, menuRow, config] = await Promise.all([
    db
      .prepare(
        `SELECT id, amco_id, full_name, department, section, roster_type, is_active,
                default_location, meal_preference
           FROM employees ORDER BY amco_id`
      )
      .all<
        ReportEmployee & {
          amco_id: string;
          full_name: string;
          department: string | null;
          section: string | null;
        }
      >(),
    db
      .prepare(
        'SELECT employee_id, work_date, shift_value FROM roster_entries WHERE work_date = ? AND deleted_at IS NULL'
      )
      .bind(date)
      .all<{ employee_id: number; work_date: string; shift_value: RosterEntry['shift_value'] }>(),
    db
      .prepare(
        'SELECT employee_id, choice, pickup_location FROM lunch_selections WHERE meal_date = ?'
      )
      .bind(date)
      .all<{ employee_id: number; choice: LunchChoice; pickup_location: MealLocation }>(),
    db
      .prepare('SELECT status FROM menu_days WHERE meal_date = ?')
      .bind(date)
      .first<{ status: string }>(),
    loadEligibilityConfig(db),
  ]);

  const menuPublished = menuRow?.status === 'published';

  const rosterByEmployee = new Map<number, RosterEntry>();
  for (const row of rosterRows.results || []) {
    rosterByEmployee.set(row.employee_id, row as unknown as RosterEntry);
  }

  const selectionByEmployee = new Map<number, { choice: LunchChoice; location: MealLocation }>();
  for (const row of selectionRows.results || []) {
    selectionByEmployee.set(row.employee_id, {
      choice: row.choice,
      location: row.pickup_location ?? DEFAULT_MEAL_LOCATION,
    });
  }

  return (employeeRows.results || []).map((employee) => {
    const verdict = computeEligibility({
      employee: employee as unknown as Employee,
      mealDate: date,
      rosterEntry: rosterByEmployee.get(employee.id) ?? null,
      workingDays: config.workingDays,
      holidays: config.holidays,
    });

    const selection = selectionByEmployee.get(employee.id) ?? null;
    const location = selection?.location ?? employee.default_location ?? DEFAULT_MEAL_LOCATION;

    // The same rule the totals use, so a sheet and the number above it can
    // never disagree.
    const served = verdict.eligible
      ? servedMeal(employee.meal_preference, selection?.choice ?? null, menuPublished)
      : null;

    return {
      amco_id: employee.amco_id,
      full_name: employee.full_name,
      department: employee.department,
      section: employee.section,
      roster_type: employee.roster_type,
      eligible: verdict.eligible,
      reason: verdict.reason,
      reason_label: REASON_LABELS[verdict.reason],
      choice: selection?.choice ?? null,
      served,
      meal_preference: employee.meal_preference,
      location,
      location_label: MEAL_LOCATION_LABELS[location],
    };
  });
}
