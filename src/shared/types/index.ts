/**
 * CanteenHub Shared Types
 * These types are shared between frontend and worker
 */

// ============================================================================
// ROLES & AUTHORIZATION
// ============================================================================

/**
 * `supervisor` keeps their own employee portal and, in the admin area, may only
 * edit employees' details and read the lunch report. The exact endpoints are an
 * allowlist in routes/admin.ts; everything else there stays administrator-only.
 */
export type Role = 'employee' | 'admin' | 'super_admin' | 'supervisor';

// ============================================================================
// EMPLOYEE & ROSTER TYPES
// ============================================================================

export type RosterType = 'regular' | 'shift' | 'amman_hq';

export interface Employee {
  id: number;
  amco_id: string;
  full_name: string;
  department: string | null;
  section: string | null;
  roster_type: RosterType;
  is_active: boolean;
  /** Where this employee normally collects their meal. */
  default_location: MealLocation;
  /** Menu options, or the healthy meal. Only an administrator changes this. */
  meal_preference: MealPreference;
  created_at: string;
  updated_at: string;
}

export interface EmployeeWithRole extends Employee {
  role: Role;
}

// ============================================================================
// SHIFT ROSTER
// ============================================================================

export type ShiftValue = 'day' | 'night' | 'off';
export type ImportSource = 'import' | 'manual';

export interface RosterEntry {
  id: number;
  employee_id: number;
  work_date: string; // YYYY-MM-DD
  shift_value: ShiftValue;
  source: ImportSource;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// MENU
// ============================================================================

export type MenuStatus = 'draft' | 'published' | 'archived';
export type ComponentType = 'condiment' | 'beverage' | 'dessert' | 'salad' | 'soup' | 'bread' | 'other';

export interface MenuDay {
  id: number;
  meal_date: string; // YYYY-MM-DD
  status: MenuStatus;
  created_at: string;
  updated_at: string;
}

export interface MenuOption {
  id: number;
  menu_day_id: number;
  option_number: 1 | 2;
  name: string;
  description: string | null;
  created_at: string;
}

export interface MenuComponent {
  id: number;
  menu_day_id: number;
  component_type: ComponentType;
  name: string;
  sort_order: number;
  created_at: string;
}

export interface MenuDayWithDetails extends MenuDay {
  options: MenuOption[];
  components: MenuComponent[];
}

// ============================================================================
// LUNCH SELECTIONS
// ============================================================================

/**
 * What an employee eats on a given day.
 *
 * `no_preference` is GONE. It existed so an employee could decline to choose,
 * but the kitchen still had to cook something, and a third pile of portions
 * nobody had asked for is not a preference - it is an unanswered question.
 * Not choosing now means Option 1 (see DEFAULT_LUNCH_CHOICE), which is a real
 * plate on a real trolley.
 *
 * `healthy` is not something an employee picks. It is set on the person by an
 * administrator (`employees.meal_preference`) and then applies every day; those
 * employees do not choose between the options at all.
 */
export const LUNCH_CHOICES = ['option_1', 'option_2', 'healthy'] as const;
export type LunchChoice = (typeof LUNCH_CHOICES)[number];

/** The two options an ordinary employee chooses between. */
export const SELECTABLE_LUNCH_CHOICES = ['option_1', 'option_2'] as const;
export type SelectableLunchChoice = (typeof SELECTABLE_LUNCH_CHOICES)[number];

/**
 * What an eligible employee gets when they never choose.
 *
 * The kitchen counts them under this; no row is written on their behalf, so
 * their history still shows honestly that they made no choice.
 */
export const DEFAULT_LUNCH_CHOICE: SelectableLunchChoice = 'option_1';

export function isLunchChoice(value: unknown): value is LunchChoice {
  return typeof value === 'string' && (LUNCH_CHOICES as readonly string[]).includes(value);
}

export function isSelectableLunchChoice(value: unknown): value is SelectableLunchChoice {
  return (
    typeof value === 'string' && (SELECTABLE_LUNCH_CHOICES as readonly string[]).includes(value)
  );
}

/**
 * Whether this person eats from the daily menu or gets the healthy meal.
 *
 * A property of the PERSON, not of a day: someone on the healthy meal is on it
 * every day until an administrator says otherwise, and cannot switch themselves.
 */
export const MEAL_PREFERENCES = ['standard', 'healthy'] as const;
export type MealPreference = (typeof MEAL_PREFERENCES)[number];

export const MEAL_PREFERENCE_LABELS: Record<MealPreference, string> = {
  standard: 'Chooses from the menu',
  healthy: 'Healthy meal',
};

export const DEFAULT_MEAL_PREFERENCE: MealPreference = 'standard';

export function isMealPreference(value: unknown): value is MealPreference {
  return typeof value === 'string' && (MEAL_PREFERENCES as readonly string[]).includes(value);
}

export type SelectionSource = 'employee' | 'admin_override' | 'system';

/**
 * Where a meal is collected.
 *
 * The codes are stored; the labels are what people read. Both live here so the
 * worker, the portal and the Excel export all name a canteen the same way -
 * a report that says "omco_canteen" to a kitchen manager is a report nobody
 * uses.
 */
export const MEAL_LOCATIONS = ['amco_canteen', 'omco_canteen', 'whc_canteen'] as const;
export type MealLocation = (typeof MEAL_LOCATIONS)[number];

export const MEAL_LOCATION_LABELS: Record<MealLocation, string> = {
  amco_canteen: 'AMCO Canteen',
  omco_canteen: 'OMCO Canteen',
  whc_canteen: 'WHC Canteen',
};

/** The location a new employee gets when no other is stated. */
export const DEFAULT_MEAL_LOCATION: MealLocation = 'amco_canteen';

export function isMealLocation(value: unknown): value is MealLocation {
  return typeof value === 'string' && (MEAL_LOCATIONS as readonly string[]).includes(value);
}

/**
 * Read a location written by a person - an import cell, or an API caller.
 * Accepts the stored code, the printed label, and the bare site name, because
 * all three turn up in real spreadsheets. Returns null for anything else rather
 * than guessing a canteen, which would send food to the wrong site.
 */
export function parseMealLocation(value: unknown): MealLocation | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  if (!key) return null;
  for (const location of MEAL_LOCATIONS) {
    const site = location.replace('_canteen', '');
    if (key === location.replace(/_/g, ' ') || key === site || key === `${site} canteen`) {
      return location;
    }
  }
  return null;
}

export interface LunchSelection {
  id: number;
  employee_id: number;
  meal_date: string; // YYYY-MM-DD
  choice: LunchChoice;
  /** Where this meal, on this date, is collected. */
  pickup_location: MealLocation;
  source: SelectionSource;
  set_by: number | null; // employee_id of admin who made override
  override_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface LunchSelectionHistory {
  id: number;
  employee_id: number;
  meal_date: string;
  previous_choice: LunchChoice | null;
  new_choice: LunchChoice;
  previous_location: MealLocation | null;
  new_location: MealLocation | null;
  changed_at: string;
  changed_by: number | null;
  source: SelectionSource;
  override_reason: string | null;
  ip_address: string | null;
}

// ============================================================================
// ELIGIBILITY
// ============================================================================

export type EligibilityReason = 
  | 'REGULAR_WORKING_DAY'
  | 'SHIFT_DAY'
  | 'SHIFT_NIGHT';

export type EligibilityDenialReason =
  | 'EMPLOYEE_INACTIVE'
  | 'AMMAN_HQ_NO_MEAL'
  | 'HOLIDAY'
  | 'REGULAR_NON_WORKING_DAY'
  | 'SHIFT_OFF'
  | 'ROSTER_MISSING';

export interface EligibilityResult {
  eligible: true;
  reason: EligibilityReason;
  rosterType: RosterType;
  dailyStatus?: ShiftValue;
  nextEligibleDate: null;
}

export interface EligibilityDenialResult {
  eligible: false;
  reason: EligibilityDenialReason;
  rosterType: RosterType;
  dailyStatus?: ShiftValue | null;
  nextEligibleDate: string | null;
}

export type EligibilityResponse = EligibilityResult | EligibilityDenialResult;

// ============================================================================
// SETTINGS
// ============================================================================

export type SettingValueType = 'string' | 'number' | 'boolean' | 'json' | 'time';

export interface Setting {
  key: string;
  value: string; // JSON-encoded
  value_type: SettingValueType;
  updated_at: string;
  updated_by: number | null;
}

export interface AppSettings {
  lunch_cutoff_time: string; // HH:MM format
  working_days: number[]; // 0=Sunday, 6=Saturday
  timezone: string;
  allow_future_selection: boolean;
}

// ============================================================================
// IMPORT & AUDIT
// ============================================================================

export type ImportType = 'employees' | 'roster' | 'menu';
export type ImportStatus = 'pending' | 'validating' | 'preview' | 'confirmed' | 'committed' | 'failed';

export interface ImportBatch {
  id: number;
  import_type: ImportType;
  status: ImportStatus;
  original_filename: string;
  uploaded_by: number;
  record_count: number;
  error_count: number;
  created_at: string;
  completed_at: string | null;
}

export interface AuditLog {
  id: number;
  actor_id: number | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  before_json: string | null;
  after_json: string | null;
  ip_address: string | null;
  created_at: string;
}

// ============================================================================
// API RESPONSES
// ============================================================================

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// ============================================================================
// SESSION & AUTH
// ============================================================================

export interface SessionData {
  employee_id: number;
  amco_id: string;
  role: Role;
  issued_at: number;
  expires_at: number;
}

export interface LoginRequest {
  amco_id: string;
  password: string;
}

export interface LoginResponse {
  success: boolean;
  employee?: {
    id: number;
    amco_id: string;
    full_name: string;
    role: Role;
  };
  error?: string;
}
