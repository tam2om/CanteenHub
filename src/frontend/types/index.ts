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

// ============================================================================
// Admin portal
// ============================================================================

/** Role ids as stored in the employees table (see migration 0001). */
export const ROLE_IDS = { employee: 1, admin: 2, super_admin: 3 } as const;
export type RoleName = keyof typeof ROLE_IDS;

/** An employee row as the admin API returns it - never carries password_hash. */
export interface AdminEmployee extends Employee {
  role_id?: number;
  created_at?: string;
  updated_at?: string;
}

export interface AdminEmployeeList {
  employees: AdminEmployee[];
  total: number;
}

export interface EmployeeFilters {
  search?: string;
  rosterType?: RosterType | '';
  isActive?: 'true' | 'false' | '';
  page?: number;
  pageSize?: number;
}

/** Body accepted by POST /api/admin/employees. */
export interface CreateEmployeeInput {
  amco_id: string;
  full_name: string;
  department?: string | null;
  section?: string | null;
  roster_type: RosterType;
  role_id?: number;
}

/**
 * Body accepted by PUT /api/admin/employees/:id.
 * `is_active` is deliberately absent: the server routes activation through its
 * own endpoint so it gets its own audit action and revokes sessions.
 */
export interface UpdateEmployeeInput {
  full_name?: string;
  department?: string | null;
  section?: string | null;
  roster_type?: RosterType;
  role_id?: number;
}

/** Response of PUT /api/admin/employees/:id/password - carries no credential. */
export interface PasswordSetResult {
  employee_id: number;
  amco_id: string;
  password_set: boolean;
  sessionsRevoked: number;
}

export interface Setting {
  key: string;
  value: string;
  value_type: string;
  description?: string | null;
  updated_at?: string;
}

export interface Holiday {
  holiday_date: string;
  name: string;
  created_at?: string;
  created_by?: number | null;
}

// ============================================================================
// Imports (Phase 4 foundation)
// ============================================================================

export type ImportType = 'employees' | 'roster' | 'menu';

export type ImportStatus =
  | 'pending'
  | 'validating'
  | 'validation_failed'
  | 'preview'
  | 'committing'
  | 'committed'
  | 'commit_failed'
  | 'cancelled';

export type ImportRowStatus = 'valid' | 'warning' | 'invalid';

/**
 * An import batch as the API returns it.
 *
 * Note the absence of any storage key: the server reports `file_archived`
 * rather than where the object lives.
 */
export interface ImportBatch {
  id: number;
  import_type: ImportType;
  status: ImportStatus;
  original_filename: string;
  file_size_bytes: number | null;
  content_sha256: string | null;
  file_archived: boolean;
  uploaded_by: number;
  uploaded_by_name?: string | null;
  uploaded_by_amco_id?: string | null;
  committed_by: number | null;
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  warning_rows: number;
  failure_reason: string | null;
  /** Server-supplied timestamps. Never recomputed in the browser. */
  created_at: string;
  validated_at: string | null;
  committed_at: string | null;
}

export interface ImportPreviewRow {
  row_number: number;
  status: ImportRowStatus;
  messages: string[];
  preview: unknown;
}

export interface ImportDetail extends ImportBatch {
  importer_available: boolean;
  committer_available: boolean;
  preview_rows: ImportPreviewRow[];
  preview_row_limit: number;
}

export interface ImportList {
  imports: ImportBatch[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Admin menu management
// ---------------------------------------------------------------------------

/** The component types the database CHECK constraint actually allows. */
export const COMPONENT_TYPES = [
  'salad',
  'soup',
  'bread',
  'condiment',
  'beverage',
  'dessert',
  'other',
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export type MenuStatus = 'draft' | 'published' | 'archived';

export interface AdminMenuOption {
  id: number;
  menu_day_id: number;
  option_number: 1 | 2;
  name: string;
  description: string | null;
}

export interface AdminMenuComponent {
  id: number;
  menu_day_id: number;
  component_type: ComponentType;
  name: string;
  sort_order: number;
}

/** A menu day as the admin range endpoint returns it - drafts included. */
export interface AdminMenuDay {
  id: number;
  meal_date: string;
  status: MenuStatus;
  options: AdminMenuOption[];
  components: AdminMenuComponent[];
}

export interface AdminMenuMonth {
  menus: AdminMenuDay[];
  month: string;
  from: string;
  to: string;
  /** The server's business date. The browser never derives this itself. */
  today: string;
}

// ---------------------------------------------------------------------------
// Admin lunch report
// ---------------------------------------------------------------------------

export interface ReportReasonCount {
  reason: string;
  label: string;
  count: number;
}

export interface LunchReport {
  date: string;
  /** The IANA timezone the server resolved the business date in. */
  timezone: string;
  menu: { exists: boolean; published: boolean; status: string | null };
  totals: { employees_considered: number; eligible: number; not_eligible: number };
  selections: {
    option_1: number;
    option_2: number;
    no_preference: number;
    eligible_not_selected: number;
    ineligible_with_selection: number;
  };
  eligibility: { by_reason: ReportReasonCount[] };
  not_eligible: { by_reason: ReportReasonCount[] };
}
