-- CanteenHub Initial Schema
-- Migration: 0001_initial_schema.sql
-- Description: Core tables for employee management, menu, roster, selections, and audit

-- Enable foreign keys (SQLite/D1 default is off, but we enforce via application)
PRAGMA foreign_keys = ON;

-- ============================================================================
-- ROLES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL CHECK (name IN ('employee', 'admin', 'super_admin')),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Insert default roles
INSERT OR IGNORE INTO roles (name, description) VALUES 
  ('employee', 'Standard employee with meal selection access'),
  ('admin', 'Administrator with management access'),
  ('super_admin', 'Super administrator with full system access');

-- ============================================================================
-- EMPLOYEES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  amco_id TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  department TEXT,
  section TEXT,
  roster_type TEXT NOT NULL CHECK (roster_type IN ('regular', 'shift', 'amman_hq')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  password_hash TEXT,  -- NULL until password is set
  role_id INTEGER NOT NULL DEFAULT 1 REFERENCES roles(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_employees_amco_id ON employees(amco_id);
CREATE INDEX IF NOT EXISTS idx_employees_roster_type ON employees(roster_type);
CREATE INDEX IF NOT EXISTS idx_employees_is_active ON employees(is_active);

-- ============================================================================
-- SETTINGS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,  -- JSON-encoded
  value_type TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'json', 'time')),
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES employees(id)
);

-- Insert default settings
INSERT OR IGNORE INTO settings (key, value, value_type, description) VALUES
  ('lunch_cutoff_time', '"10:00"', 'time', 'Daily lunch selection cutoff time (HH:MM, Asia/Amman timezone)'),
  ('working_days', '[0,1,2,3,4]', 'json', 'Working days for regular employees (0=Sunday, 6=Saturday)'),
  ('timezone', '"Asia/Amman"', 'string', 'Application timezone');
-- Note: allow_future_selection is reserved for future phases but not actively used in Phase 1/2

-- ============================================================================
-- MENU DAYS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS menu_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_date TEXT UNIQUE NOT NULL,  -- YYYY-MM-DD format
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_menu_days_meal_date ON menu_days(meal_date);
CREATE INDEX IF NOT EXISTS idx_menu_days_status ON menu_days(status);

-- ============================================================================
-- MENU OPTIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS menu_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_day_id INTEGER NOT NULL REFERENCES menu_days(id) ON DELETE CASCADE,
  option_number INTEGER NOT NULL CHECK (option_number IN (1, 2)),
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(menu_day_id, option_number)
);

CREATE INDEX IF NOT EXISTS idx_menu_options_menu_day_id ON menu_options(menu_day_id);

-- ============================================================================
-- MENU COMPONENTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS menu_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_day_id INTEGER NOT NULL REFERENCES menu_days(id) ON DELETE CASCADE,
  component_type TEXT NOT NULL CHECK (component_type IN ('condiment', 'beverage', 'dessert', 'salad', 'soup', 'bread', 'other')),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_menu_components_menu_day_id ON menu_components(menu_day_id);
CREATE INDEX IF NOT EXISTS idx_menu_components_component_type ON menu_components(component_type);

-- ============================================================================
-- ROSTER ENTRIES TABLE (Shift employees only)
-- ============================================================================

CREATE TABLE IF NOT EXISTS roster_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,  -- YYYY-MM-DD format
  shift_value TEXT NOT NULL CHECK (shift_value IN ('day', 'night', 'off')),
  source TEXT NOT NULL CHECK (source IN ('import', 'manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,  -- Soft delete timestamp (NULL = active)
  UNIQUE(employee_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_roster_entries_employee_id ON roster_entries(employee_id);
CREATE INDEX IF NOT EXISTS idx_roster_entries_work_date ON roster_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_roster_entries_shift_value ON roster_entries(shift_value);
CREATE INDEX IF NOT EXISTS idx_roster_entries_deleted_at ON roster_entries(deleted_at);

-- ============================================================================
-- LUNCH SELECTIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS lunch_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  meal_date TEXT NOT NULL,  -- YYYY-MM-DD format
  choice TEXT NOT NULL CHECK (choice IN ('option_1', 'option_2', 'no_preference')),
  source TEXT NOT NULL CHECK (source IN ('employee', 'admin_override', 'system')),
  set_by INTEGER REFERENCES employees(id),  -- Admin who made override (NULL if employee self-selected)
  override_reason TEXT,  -- Required if source='admin_override'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(employee_id, meal_date)
);

CREATE INDEX IF NOT EXISTS idx_lunch_selections_employee_id ON lunch_selections(employee_id);
CREATE INDEX IF NOT EXISTS idx_lunch_selections_meal_date ON lunch_selections(meal_date);
CREATE INDEX IF NOT EXISTS idx_lunch_selections_choice ON lunch_selections(choice);

-- ============================================================================
-- LUNCH SELECTION HISTORY TABLE (Audit trail for selection changes)
-- ============================================================================

CREATE TABLE IF NOT EXISTS lunch_selection_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  meal_date TEXT NOT NULL,
  previous_choice TEXT CHECK (previous_choice IN ('option_1', 'option_2', 'no_preference')),
  new_choice TEXT NOT NULL CHECK (new_choice IN ('option_1', 'option_2', 'no_preference')),
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_by INTEGER REFERENCES employees(id),
  source TEXT NOT NULL CHECK (source IN ('employee', 'admin_override', 'system')),
  override_reason TEXT,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_lunch_history_employee_id ON lunch_selection_history(employee_id);
CREATE INDEX IF NOT EXISTS idx_lunch_history_meal_date ON lunch_selection_history(meal_date);
CREATE INDEX IF NOT EXISTS idx_lunch_history_changed_at ON lunch_selection_history(changed_at);

-- ============================================================================
-- IMPORT BATCHES TABLE (Track Excel imports)
-- ============================================================================

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type TEXT NOT NULL CHECK (import_type IN ('employees', 'roster', 'menu')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'validating', 'preview', 'confirmed', 'committed', 'failed')),
  original_filename TEXT NOT NULL,
  r2_object_key TEXT,  -- NULL if file not stored
  uploaded_by INTEGER NOT NULL REFERENCES employees(id),
  record_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  validation_errors TEXT,  -- JSON-encoded array of errors
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_import_batches_import_type ON import_batches(import_type);
CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS idx_import_batches_created_at ON import_batches(created_at);

-- ============================================================================
-- AUDIT LOG TABLE (Track admin actions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES employees(id),
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  before_json TEXT,  -- JSON snapshot before change
  after_json TEXT,   -- JSON snapshot after change
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_actor_id ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity_type ON audit_log(entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);

-- ============================================================================
-- SESSIONS TABLE (Server-side session storage)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_token_hash TEXT UNIQUE NOT NULL,  -- Hash of the opaque session token
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_employee_id ON sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- ============================================================================
-- LOGIN ATTEMPTS TABLE (Rate limiting for authentication)
-- ============================================================================

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL,  -- IP address or AMCO ID
  attempt_time TEXT NOT NULL DEFAULT (datetime('now')),
  success INTEGER NOT NULL CHECK (success IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier);
CREATE INDEX IF NOT EXISTS idx_login_attempts_attempt_time ON login_attempts(attempt_time);

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT TIMESTAMPS
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS update_employees_updated_at
AFTER UPDATE ON employees
BEGIN
  UPDATE employees SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_menu_days_updated_at
AFTER UPDATE ON menu_days
BEGIN
  UPDATE menu_days SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_roster_entries_updated_at
AFTER UPDATE ON roster_entries
BEGIN
  UPDATE roster_entries SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_lunch_selections_updated_at
AFTER UPDATE ON lunch_selections
BEGIN
  UPDATE lunch_selections SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================================
-- END OF MIGRATION
-- ============================================================================
