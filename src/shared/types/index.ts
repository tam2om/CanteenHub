/**
 * CanteenHub Shared Types
 * These types are shared between frontend and worker
 */

// ============================================================================
// ROLES & AUTHORIZATION
// ============================================================================

export type Role = 'employee' | 'admin' | 'super_admin';

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

export type LunchChoice = 'option_1' | 'option_2' | 'no_preference';
export type SelectionSource = 'employee' | 'admin_override' | 'system';

export interface LunchSelection {
  id: number;
  employee_id: number;
  meal_date: string; // YYYY-MM-DD
  choice: LunchChoice;
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
  r2_object_key: string | null;
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
