-- ============================================================================
-- Migration 0006 - the supervisor role
-- ============================================================================
--
-- A supervisor keeps their own employee portal and, in the admin area, may
-- only look after employees' details and read the lunch report. Everything
-- else - imports, menus, roster, settings, holidays, passwords, activation,
-- roles - stays with administrators. Which endpoints a supervisor may reach is
-- decided in the Worker (routes/admin.ts); this migration only makes the role
-- exist, so that employees.role_id = 4 satisfies its foreign key.
--
-- WHY roles IS REBUILT, AND WHY THIS WAY
--
-- roles.name carries a CHECK listing the permitted names, and SQLite cannot
-- alter a CHECK in place, so the table has to be recreated. That is awkward
-- because roles is a PARENT: every employee row references it, and D1 always
-- enforces foreign keys - they cannot be switched off for a migration.
--
-- The usual recipe (build roles_new, drop roles, rename roles_new into place)
-- does NOT work here, and was tried first. SQLite counts deferred foreign-key
-- violations: dropping roles adds one per employee left pointing at nothing,
-- and a RENAME never decrements that count, so the migration dies at commit.
-- What does decrement it is INSERTING a parent row that orphaned children are
-- waiting for. So roles is recreated under its OWN name and its rows are
-- re-inserted, which resolves every orphan before the transaction ends.
--
-- This relies on the whole file running as ONE transaction, which is how D1
-- applies a migration. Run statement by statement it fails at the DROP and
-- changes nothing but the scratch copy - it cannot leave employees orphaned.
--
-- Ids are preserved exactly (1 employee, 2 admin, 3 super_admin), and
-- supervisor is created as id 4 explicitly rather than by AUTOINCREMENT, because
-- the Worker maps role ids to names and must agree with this table.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE roles_backup AS
  SELECT id, name, description, created_at FROM roles;

DROP TABLE roles;

CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL CHECK (name IN ('employee', 'admin', 'super_admin', 'supervisor')),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO roles (id, name, description, created_at)
  SELECT id, name, description, created_at FROM roles_backup;

INSERT INTO roles (id, name, description) VALUES
  (4, 'supervisor', 'Own employee portal, plus editing employee details and reading the lunch report');

DROP TABLE roles_backup;
