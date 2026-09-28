-- ============================================================================
-- Migration 0005 - the healthy meal, and the end of "no preference"
-- ============================================================================
--
-- TWO changes to what a lunch choice can be:
--
--   'no_preference' is REMOVED. It let an employee decline to choose while the
--   kitchen still had to cook something, so it became a third pile of portions
--   nobody had actually asked for. Not choosing now means Option 1, counted at
--   report time; existing 'no_preference' rows are converted to 'option_1'
--   below, which is the same meal those employees would be served today.
--
--   'healthy' is ADDED. It is not an option anybody picks from the menu: an
--   administrator marks a person as being on the healthy meal
--   (employees.meal_preference) and from then on that is what they get, every
--   day, and they cannot change it themselves.
--
-- SQLite cannot alter a CHECK constraint in place, so lunch_selections and
-- lunch_selection_history are rebuilt column for column. Nothing references
-- either table by foreign key, so the rebuild touches no other row. Both
-- rebuilds preserve every id, so history, audit JSON and exported reports
-- continue to name the same records.

-- --- employees ---------------------------------------------------------------
-- Defaulted to 'standard': everybody keeps eating from the menu until an
-- administrator says otherwise, which is what they are doing today.
ALTER TABLE employees ADD COLUMN meal_preference TEXT NOT NULL
  DEFAULT 'standard'
  CHECK (meal_preference IN ('standard', 'healthy'));

-- --- lunch_selections --------------------------------------------------------
CREATE TABLE lunch_selections_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  meal_date TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('option_1', 'option_2', 'healthy')),
  source TEXT NOT NULL CHECK (source IN ('employee', 'admin_override', 'system')),
  set_by INTEGER REFERENCES employees(id),
  override_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  pickup_location TEXT CHECK (pickup_location IN ('amco_canteen', 'omco_canteen', 'whc_canteen')),
  UNIQUE(employee_id, meal_date)
);

INSERT INTO lunch_selections_new
  (id, employee_id, meal_date, choice, source, set_by, override_reason,
   created_at, updated_at, pickup_location)
SELECT
  id, employee_id, meal_date,
  CASE choice WHEN 'no_preference' THEN 'option_1' ELSE choice END,
  source, set_by, override_reason, created_at, updated_at, pickup_location
FROM lunch_selections;

DROP TABLE lunch_selections;
ALTER TABLE lunch_selections_new RENAME TO lunch_selections;

CREATE INDEX IF NOT EXISTS idx_lunch_selections_employee_id ON lunch_selections(employee_id);
CREATE INDEX IF NOT EXISTS idx_lunch_selections_meal_date ON lunch_selections(meal_date);
CREATE INDEX IF NOT EXISTS idx_lunch_selections_choice ON lunch_selections(choice);
CREATE INDEX IF NOT EXISTS idx_lunch_selections_date_location
  ON lunch_selections(meal_date, pickup_location);

-- Dropping the table dropped its trigger with it.
CREATE TRIGGER IF NOT EXISTS update_lunch_selections_updated_at
AFTER UPDATE ON lunch_selections
BEGIN
  UPDATE lunch_selections SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- --- lunch_selection_history -------------------------------------------------
-- The record of what changed. Past rows that said "no preference" are converted
-- the same way the selections were, so a history entry never names a choice the
-- system can no longer express.
CREATE TABLE lunch_selection_history_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL,
  meal_date TEXT NOT NULL,
  previous_choice TEXT CHECK (previous_choice IN ('option_1', 'option_2', 'healthy')),
  new_choice TEXT NOT NULL CHECK (new_choice IN ('option_1', 'option_2', 'healthy')),
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  changed_by INTEGER REFERENCES employees(id),
  source TEXT NOT NULL CHECK (source IN ('employee', 'admin_override', 'system')),
  override_reason TEXT,
  ip_address TEXT,
  previous_location TEXT CHECK (previous_location IN ('amco_canteen', 'omco_canteen', 'whc_canteen')),
  new_location TEXT CHECK (new_location IN ('amco_canteen', 'omco_canteen', 'whc_canteen'))
);

INSERT INTO lunch_selection_history_new
  (id, employee_id, meal_date, previous_choice, new_choice, changed_at, changed_by,
   source, override_reason, ip_address, previous_location, new_location)
SELECT
  id, employee_id, meal_date,
  CASE previous_choice WHEN 'no_preference' THEN 'option_1' ELSE previous_choice END,
  CASE new_choice WHEN 'no_preference' THEN 'option_1' ELSE new_choice END,
  changed_at, changed_by, source, override_reason, ip_address,
  previous_location, new_location
FROM lunch_selection_history;

DROP TABLE lunch_selection_history;
ALTER TABLE lunch_selection_history_new RENAME TO lunch_selection_history;

CREATE INDEX IF NOT EXISTS idx_lunch_history_employee_id ON lunch_selection_history(employee_id);
CREATE INDEX IF NOT EXISTS idx_lunch_history_meal_date ON lunch_selection_history(meal_date);
CREATE INDEX IF NOT EXISTS idx_lunch_history_changed_at ON lunch_selection_history(changed_at);
