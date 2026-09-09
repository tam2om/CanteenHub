-- ============================================================================
-- CanteenHub — PROPOSED D1 schema
-- ============================================================================
--
--   *** THIS IS A PROPOSAL DOCUMENT. IT IS NOT A MIGRATION. ***
--
--   Nothing here has been applied. No tables have been created. This file
--   lives in docs/ (not migrations/) deliberately, so that it cannot be
--   picked up by `wrangler d1 migrations apply`.
--
--   It exists so the architecture in docs/ARCHITECTURE.md can be reviewed
--   concretely rather than in prose. On approval, it becomes the basis of
--   migrations/0001_initial_schema.sql.
--
--   REVISED 2026-09-09 against the real source files. See
--   docs/SOURCE-DATA-FINDINGS.md. Three changes came out of that review:
--     * meal_type ('lunch'/'dinner') added to menus and selections, because a
--       dinner service exists in the source data that the requirements never
--       mentioned. Modelled now, feature deliberately not built (see §4.1 of
--       the findings). lunch_selections is therefore named meal_selections.
--     * menu_components gains 'side' and 'accompaniment'; the real lunch menu
--       has FIVE component columns, not the three the requirements named.
--     * menu_days is keyed on (meal_date, meal_type), not meal_date alone.
--
--   Conventions (rationale in ARCHITECTURE.md §3):
--     * Calendar dates  -> TEXT 'YYYY-MM-DD', always an Asia/Amman date
--     * Timestamps      -> TEXT ISO-8601 UTC, e.g. '2026-09-09T07:15:00Z'
--     * Booleans        -> INTEGER 0/1
--     * Enums           -> TEXT + CHECK constraint (self-documenting in a dump)
--     * Deletes         -> RESTRICT by default; operational data is never
--                          hard-deleted (soft flags and status columns instead)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. EMPLOYEES & ACCESS
-- ---------------------------------------------------------------------------

CREATE TABLE employees (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  amco_id              TEXT    NOT NULL UNIQUE,          -- business key from HR
  full_name            TEXT    NOT NULL,
  -- Free text from the workbook. The source data contains stray leading and
  -- trailing whitespace ("Maintenance  ", " Fleet &Transportation  "), so the
  -- importer must trim and collapse whitespace or GROUP BY department will
  -- produce duplicate-looking report rows.
  department           TEXT,
  section              TEXT,

  -- The single discriminator for meal eligibility (ARCHITECTURE.md §12).
  -- NOTE: 'amman_hq' is a ROSTER TYPE, not a department. Eligibility must
  -- never be derived from the department column.
  roster_type          TEXT    NOT NULL
                       CHECK (roster_type IN ('regular','shift','amman_hq')),

  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),

  -- Credentials. NULL password_hash = no password issued yet; login impossible.
  password_hash        TEXT,                             -- 'pbkdf2$sha256$100000$<salt>$<hash>'
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0,1)),
  password_changed_at  TEXT,
  last_login_at        TEXT,
  failed_login_count   INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,                             -- ISO-8601 UTC

  import_batch_id      INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  created_by           INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  updated_by           INTEGER REFERENCES employees(id) ON DELETE RESTRICT
);

CREATE INDEX idx_employees_roster_type ON employees (roster_type, is_active);
CREATE INDEX idx_employees_department  ON employees (department);
CREATE INDEX idx_employees_active      ON employees (is_active);
-- Supports admin search without a full scan on a growing table.
CREATE INDEX idx_employees_name        ON employees (full_name);

-- Roles are a table, not a column, so a fourth role (e.g. a read-only
-- kitchen-display account) needs no schema change.
CREATE TABLE roles (
  code        TEXT PRIMARY KEY CHECK (code IN ('employee','admin','super_admin')),
  description TEXT NOT NULL
);

CREATE TABLE employee_roles (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  role_code   TEXT    NOT NULL REFERENCES roles(code)   ON DELETE RESTRICT,
  granted_at  TEXT    NOT NULL,
  granted_by  INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  PRIMARY KEY (employee_id, role_code)
);

-- Opaque server-side sessions (ARCHITECTURE.md §4). The token itself is never
-- stored; only SHA-256(token), so a leaked backup yields no live sessions.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,                          -- SHA-256 of the cookie value
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT
);

CREATE INDEX idx_sessions_employee ON sessions (employee_id);
CREATE INDEX idx_sessions_expires  ON sessions (expires_at);   -- nightly purge

-- ---------------------------------------------------------------------------
-- 2. MENU  (ARCHITECTURE.md §7)
-- ---------------------------------------------------------------------------

CREATE TABLE menu_days (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  meal_date    TEXT    NOT NULL,                         -- 'YYYY-MM-DD'
  -- Dinner is modelled but NOT built in phase 1. Every row written by the
  -- lunch feature is 'lunch'. See docs/SOURCE-DATA-FINDINGS.md §4.1 for why
  -- the dimension is added now rather than migrated in later.
  meal_type    TEXT    NOT NULL DEFAULT 'lunch'
               CHECK (meal_type IN ('lunch','dinner')),
  status       TEXT    NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','published')),
  published_at TEXT,
  published_by INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  notes        TEXT,
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  created_by   INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  updated_by   INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  UNIQUE (meal_date, meal_type)
);

CREATE INDEX idx_menu_days_date_status ON menu_days (meal_date, meal_type, status);

-- Exactly two options per day, enforced by the database rather than by hope.
CREATE TABLE menu_options (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_day_id   INTEGER NOT NULL REFERENCES menu_days(id) ON DELETE CASCADE,
  option_number INTEGER NOT NULL CHECK (option_number IN (1,2)),
  name          TEXT    NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (menu_day_id, option_number)
);

-- Informational accompaniments. These are NOT employee choices.
--
-- The real lunch menu has FIVE such columns:
--   'Option Meal 1'    -> 'salad'         (Tahina Salad, Rocca & Onions, ...)
--   'Option Meal 2'    -> 'side'          (Youghurt / Yoghurt)
--   'Condiment'        -> 'condiment'     (Pickles, Dagoos)
--   'Beverage'         -> 'beverage'      (Cola or Juice or Water)
--   'Dessert / Fruits' -> 'dessert'       (Seasonal fruit, Warbat, Arabic Sweet)
--
-- WARNING: despite their names, 'Option Meal 1' and 'Option Meal 2' are NOT
-- selectable options. They are accompaniments served with whichever main the
-- employee chose. The employee's choice is Option 1 vs Option 2 only.
--
-- The dinner menu contributes 'accompaniment' and 'beverage'.
--
-- Normalizing this (rather than one wide column per component) is what let the
-- discovery of two extra component types land as data instead of a migration.
CREATE TABLE menu_components (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  menu_day_id    INTEGER NOT NULL REFERENCES menu_days(id) ON DELETE CASCADE,
  component_type TEXT    NOT NULL
                 CHECK (component_type IN ('salad','side','condiment','beverage',
                                           'dessert','accompaniment','soup',
                                           'bread','other')),
  name           TEXT    NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_menu_components_day ON menu_components (menu_day_id, sort_order);

-- ---------------------------------------------------------------------------
-- 3. ROSTER  (ARCHITECTURE.md §9)
-- ---------------------------------------------------------------------------
-- One row per SHIFT employee per day. Long form, not the wide month layout of
-- the source workbook — the pivot happens in the browser at import time.
--
-- The source sheet is 'Shifts roster': code | month | year | 1 | 2 | ... | 31
-- so work_date is COMPOSED from (year, month, day-column-index) rather than
-- parsed from a header. There are always 31 day columns regardless of month
-- length; a populated day-31 cell in a 30-day month is a validation error.
--
-- CRITICAL: the ABSENCE of a row means "roster not published for this date",
-- NOT "off". These are different outcomes and are reported differently.

CREATE TABLE roster_entries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date       TEXT    NOT NULL,                      -- 'YYYY-MM-DD'
  shift_value     TEXT    NOT NULL
                  CHECK (shift_value IN ('day','night','off')),
  source          TEXT    NOT NULL DEFAULT 'import'
                  CHECK (source IN ('import','manual')),
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  updated_by      INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  UNIQUE (employee_id, work_date)
);

CREATE INDEX idx_roster_date     ON roster_entries (work_date);
CREATE INDEX idx_roster_emp_date ON roster_entries (employee_id, work_date);

-- Append-only. Answers "who changed this shift, when, and from what?"
CREATE TABLE roster_entry_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  work_date       TEXT    NOT NULL,
  previous_value  TEXT,                                  -- NULL on first entry
  new_value       TEXT    NOT NULL,
  changed_at      TEXT    NOT NULL,
  changed_by      INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  source          TEXT    NOT NULL CHECK (source IN ('import','manual')),
  import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL
);

CREATE INDEX idx_roster_hist_emp_date ON roster_entry_history (employee_id, work_date);

-- ---------------------------------------------------------------------------
-- 4. HOLIDAYS
-- ---------------------------------------------------------------------------
-- A table rather than a setting: these are dated records with descriptions
-- that admins manage individually and that reports join against.

CREATE TABLE holidays (
  holiday_date TEXT PRIMARY KEY,                         -- 'YYYY-MM-DD'
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  created_by   INTEGER REFERENCES employees(id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------------
-- 5. MEAL SELECTIONS  (ARCHITECTURE.md §10)
-- ---------------------------------------------------------------------------
-- NOTE THE ABSENCE OF ANY FOREIGN KEY TO menu_days / menu_options.
-- A selection references the SLOT ('option_1' / 'option_2' / 'no_preference'),
-- never a menu row. This is what makes "a menu re-import cannot destroy
-- selections" true by construction rather than by careful coding.

CREATE TABLE meal_selections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  meal_date       TEXT    NOT NULL,                      -- 'YYYY-MM-DD'
  meal_type       TEXT    NOT NULL DEFAULT 'lunch'
                  CHECK (meal_type IN ('lunch','dinner')),
  choice          TEXT    NOT NULL
                  CHECK (choice IN ('option_1','option_2','no_preference')),
  selected_at     TEXT    NOT NULL,
  source          TEXT    NOT NULL DEFAULT 'employee'
                  CHECK (source IN ('employee','admin_override','system')),
  set_by          INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  override_reason TEXT,                                  -- required when source='admin_override'
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (employee_id, meal_date, meal_type),
  CHECK (source <> 'admin_override' OR override_reason IS NOT NULL)
);

-- Drives the daily portion counts; without this the report is a full scan.
CREATE INDEX idx_selections_date        ON meal_selections (meal_date, meal_type);
CREATE INDEX idx_selections_date_choice ON meal_selections (meal_date, meal_type, choice);
CREATE INDEX idx_selections_emp_date    ON meal_selections (employee_id, meal_date);

-- Append-only. Written in the SAME batch() as the selection change, so the
-- two can never diverge.
CREATE TABLE meal_selection_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  meal_date       TEXT    NOT NULL,
  meal_type       TEXT    NOT NULL DEFAULT 'lunch'
                  CHECK (meal_type IN ('lunch','dinner')),
  previous_choice TEXT,                                  -- NULL on first selection
  new_choice      TEXT    NOT NULL,
  changed_at      TEXT    NOT NULL,
  changed_by      INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  source          TEXT    NOT NULL
                  CHECK (source IN ('employee','admin_override','system')),
  override_reason TEXT,
  ip_address      TEXT
);

CREATE INDEX idx_sel_hist_emp_date ON meal_selection_history (employee_id, meal_date);
CREATE INDEX idx_sel_hist_date     ON meal_selection_history (meal_date, changed_at);

-- ---------------------------------------------------------------------------
-- 6. SETTINGS  (ARCHITECTURE.md §18)
-- ---------------------------------------------------------------------------
-- Operational config lives here, not in environment variables, so changing
-- the cutoff time is an audited admin action rather than a deployment.

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,                             -- JSON-encoded
  value_type  TEXT NOT NULL CHECK (value_type IN ('string','number','boolean','json','time')),
  description TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  INTEGER REFERENCES employees(id) ON DELETE RESTRICT
);

-- Proposed seed values (see ARCHITECTURE.md §18.3):
--   lunch_cutoff_time      '"10:00"'        time     Amman local, on the meal date
--   timezone               '"Asia/Amman"'   string   resolved via Intl, not a fixed offset
--   working_days           '[0,1,2,3,4]'    json     Sun-Thu, for roster_type='regular'
--   upcoming_menu_days     '7'              number   how far ahead employees see menus
--   lookahead_days         '14'             number   horizon for nextEligibleDate
--   session_ttl_hours      '12'             number   ('8' for admin sessions)
--   allow_future_selection 'true'           boolean  see Open Question 2
--   import_row_retention_days '30'          number   staged import row purge

-- ---------------------------------------------------------------------------
-- 7. IMPORTS  (ARCHITECTURE.md §11 and §13)
-- ---------------------------------------------------------------------------

CREATE TABLE import_batches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  import_type         TEXT NOT NULL CHECK (import_type IN ('employees','roster','menu')),
  status              TEXT NOT NULL DEFAULT 'uploaded'
                      CHECK (status IN ('uploaded','validated','previewed','committing',
                                        'committed','partially_committed','failed','cancelled')),

  original_filename   TEXT NOT NULL,
  r2_object_key       TEXT,                              -- 'imports/{id}/{filename}'
  file_sha256         TEXT,                              -- integrity of the archived artifact
  file_size_bytes     INTEGER,

  uploaded_by         INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  uploaded_at         TEXT NOT NULL,

  row_count           INTEGER NOT NULL DEFAULT 0,
  new_count           INTEGER NOT NULL DEFAULT 0,
  updated_count       INTEGER NOT NULL DEFAULT 0,
  unchanged_count     INTEGER NOT NULL DEFAULT 0,
  error_count         INTEGER NOT NULL DEFAULT 0,
  conflict_count      INTEGER NOT NULL DEFAULT 0,

  committed_by        INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  committed_at        TEXT,
  committed_row_count INTEGER NOT NULL DEFAULT 0,        -- resumable chunked commit

  summary_json        TEXT,                              -- incl. impact analysis
  error_json          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX idx_import_batches_type_status ON import_batches (import_type, status);
CREATE INDEX idx_import_batches_uploaded    ON import_batches (uploaded_at DESC);

-- Staging. Holds exactly what will be written, so the preview the admin
-- approves is the thing that actually lands. Purged after retention; the
-- original file in R2 and the batch summary are the permanent record.
CREATE TABLE import_batch_rows (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id  INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number       INTEGER NOT NULL,                     -- 1-based, as in the sheet
  raw_json         TEXT NOT NULL,                        -- exactly what the sheet said
  normalized_json  TEXT,                                 -- what we will write
  action           TEXT NOT NULL
                   CHECK (action IN ('create','update','unchanged','error','conflict')),
  messages_json    TEXT,                                 -- per-row errors / warnings
  target_entity_id INTEGER,                              -- resolved existing row, if any
  is_committed     INTEGER NOT NULL DEFAULT 0 CHECK (is_committed IN (0,1)),
  UNIQUE (import_batch_id, row_number)
);

CREATE INDEX idx_import_rows_batch_action ON import_batch_rows (import_batch_id, action);

-- ---------------------------------------------------------------------------
-- 8. AUDIT LOG  (ARCHITECTURE.md §11)
-- ---------------------------------------------------------------------------
-- Append-only; written in the SAME batch() as the change it records, so an
-- audited action cannot succeed without its audit row.
--
-- Deliberately NOT logged here: employee self-service selections (they have
-- their own richer history table) and read operations.

CREATE TABLE audit_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_employee_id  INTEGER REFERENCES employees(id) ON DELETE RESTRICT,
  actor_role         TEXT,
  action             TEXT NOT NULL,                      -- 'employee.deactivate', 'menu.publish', ...
  entity_type        TEXT NOT NULL,                      -- 'employee' | 'menu_day' | 'roster_entry' | ...
  entity_id          TEXT,
  before_json        TEXT,
  after_json         TEXT,
  ip_address         TEXT,
  user_agent         TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX idx_audit_entity  ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_actor   ON audit_log (actor_employee_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 9. DAILY REPORT SNAPSHOTS  (ARCHITECTURE.md §14.3)
-- ---------------------------------------------------------------------------
-- Freezes what a day ACTUALLY was. Without this, a later roster correction or
-- employee deactivation would silently rewrite the historical report the
-- caterer was paid against.

CREATE TABLE daily_report_snapshots (
  meal_date              TEXT NOT NULL,                  -- 'YYYY-MM-DD'
  meal_type              TEXT NOT NULL DEFAULT 'lunch'
                         CHECK (meal_type IN ('lunch','dinner')),
  option_1_count         INTEGER NOT NULL,
  option_2_count         INTEGER NOT NULL,
  no_preference_count    INTEGER NOT NULL,
  eligible_not_selected  INTEGER NOT NULL,
  not_eligible_count     INTEGER NOT NULL,
  admin_override_count   INTEGER NOT NULL DEFAULT 0,
  not_eligible_breakdown TEXT NOT NULL,                  -- JSON keyed by denial reason
  department_breakdown   TEXT,                           -- JSON
  menu_snapshot          TEXT,                           -- JSON: option + component text as published
  generated_at           TEXT NOT NULL,
  generated_by           TEXT NOT NULL DEFAULT 'cron',
  PRIMARY KEY (meal_date, meal_type)
);

-- ============================================================================
-- END OF PROPOSAL — nothing above has been applied.
-- ============================================================================
