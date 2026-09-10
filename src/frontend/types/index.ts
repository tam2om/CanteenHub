/**
 * Employee portal types.
 *
 * Reason codes mirror the backend's EligibilityReason / EligibilityDenialReason
 * unions. The portal never invents a rule - it only renders what the server
 * decided.
 */

export type RosterType = 'regular' | 'shift' | 'amman_hq';
export type LunchChoice = 'option_1' | 'option_2' | 'no_preference';
export type SelectionSource = 'employee' | 'admin_override' | 'system';

export type EligibilityReason =
  | 'REGULAR_WORKING_DAY'
  | 'SHIFT_DAY'
  | 'SHIFT_NIGHT'
  | 'EMPLOYEE_INACTIVE'
  | 'AMMAN_HQ_NO_MEAL'
  | 'HOLIDAY'
  | 'REGULAR_NON_WORKING_DAY'
  | 'SHIFT_OFF'
  | 'ROSTER_MISSING';

export interface Employee {
  id: number;
  amco_id: string;
  full_name: string;
  department: string | null;
  section: string | null;
  roster_type: RosterType;
  is_active: boolean | number;
}

export interface Eligibility {
  eligible: boolean;
  reason: EligibilityReason;
  rosterType: RosterType;
  dailyStatus?: string | null;
  nextEligibleDate: string | null;
}

export interface MenuOption {
  id: number;
  option_number: 1 | 2;
  name: string;
  description: string | null;
}

export interface MenuComponent {
  id: number;
  component_type: string;
  name: string;
}

export interface Menu {
  id: number;
  meal_date: string;
  status: string;
  options: MenuOption[];
  components: MenuComponent[];
}

export interface Selection {
  id: number;
  meal_date: string;
  choice: LunchChoice;
  source: SelectionSource;
  selected_at: string;
  updated_at: string;
}

/** Payload of GET /api/me/today - everything the dashboard renders. */
export interface TodayPayload {
  businessDate: string;
  mealDate: string;
  employee: Employee;
  eligibility: Eligibility;
  menu: Menu | null;
  selection: Selection | null;
  cutoffPassed: boolean;
  canSelect: boolean;
}

export interface HistoryEntry {
  id: number;
  meal_date: string;
  previous_choice: LunchChoice | null;
  new_choice: LunchChoice;
  changed_at: string;
  source: SelectionSource;
}

export interface HistoryPayload {
  entries: HistoryEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface SessionUser {
  id: number;
  amco_id: string;
  full_name: string;
  department: string | null;
  section: string | null;
  roster_type: RosterType;
  role: string;
}
