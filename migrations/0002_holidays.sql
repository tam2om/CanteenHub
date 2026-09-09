-- ============================================================================
-- Migration 0002 - Company holidays
-- ============================================================================
--
-- Phase 3 Slice 1.
--
-- Scope note: this migration adds ONE table and nothing else. The indexes that
-- Slice 1 might otherwise have called for already exist in 0001 and are
-- deliberately NOT duplicated here:
--
--   lunch_selections(meal_date) -> idx_lunch_selections_meal_date
--   roster_entries(work_date)   -> idx_roster_entries_work_date
--   employees(roster_type)      -> idx_employees_roster_type
--
-- No password_reset_tokens table is created. CanteenHub has no self-service
-- password recovery by design: an administrator sets the password directly and
-- communicates it to the employee outside the application.
-- ============================================================================

CREATE TABLE IF NOT EXISTS holidays (
  -- The business date (Asia/Amman calendar day) in YYYY-MM-DD form. Used as the
  -- primary key because a date can only be a holiday once; this also gives the
  -- lookup index for free, so no separate CREATE INDEX is needed.
  holiday_date TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  created_by   INTEGER REFERENCES employees(id)
);
