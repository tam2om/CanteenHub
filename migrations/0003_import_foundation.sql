-- ============================================================================
-- Migration 0003 - Import foundation
-- ============================================================================
--
-- Phase 4 Slice 1.
--
-- `import_batches` already existed in 0001 but was never referenced by any
-- code. This migration reshapes it for the actual upload -> validate ->
-- preview -> commit lifecycle and adds the row-level staging table that 0001
-- anticipated but never created.
--
-- Rebuilding rather than ALTERing because SQLite cannot modify a CHECK
-- constraint in place, and the status set genuinely needs to grow: the original
-- enum could not distinguish a validation failure from a commit failure, and
-- had no in-flight `committing` state to make double-commit protection an
-- atomic compare-and-swap.
--
-- The rebuild is written to preserve any existing rows even though the table is
-- empty in every environment today - a migration must be safe regardless.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- IMPORT BATCHES
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS import_batches_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,

  import_type       TEXT NOT NULL CHECK (import_type IN ('employees', 'roster', 'menu')),

  -- Lifecycle. Every transition is server-side and one-way except the
  -- retryable failure states.
  --
  --   pending           uploaded, file archived, nothing validated yet
  --   validating        validation in flight
  --   validation_failed validation ran and rejected the file (retryable)
  --   preview           validated; awaiting an explicit administrator commit
  --   committing        a commit is in flight - claimed atomically, so a
  --                     second concurrent request cannot also claim it
  --   committed         production data was actually written (terminal)
  --   commit_failed     the commit was attempted and did not succeed (retryable)
  --   cancelled         abandoned by an administrator (terminal)
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'validating', 'validation_failed',
                                      'preview', 'committing', 'committed',
                                      'commit_failed', 'cancelled')),

  -- Display metadata only. NEVER used to build the storage key: an uploaded
  -- filename is untrusted input and must not steer where bytes are written.
  original_filename TEXT NOT NULL,
  file_size_bytes   INTEGER,
  content_sha256    TEXT,   -- metadata for spotting accidental re-uploads;
                            -- deliberately NOT unique, since re-uploading the
                            -- same workbook can be a legitimate new attempt

  -- Deterministic key derived from the batch id, not from user input.
  r2_object_key     TEXT,

  uploaded_by       INTEGER NOT NULL REFERENCES employees(id),
  committed_by      INTEGER REFERENCES employees(id),

  total_rows        INTEGER NOT NULL DEFAULT 0,
  valid_rows        INTEGER NOT NULL DEFAULT 0,
  invalid_rows      INTEGER NOT NULL DEFAULT 0,
  warning_rows      INTEGER NOT NULL DEFAULT 0,

  -- Operator-facing explanation of a failure. Never contains file contents.
  failure_reason    TEXT,
  validation_summary TEXT,  -- JSON: aggregate counts and file-level messages

  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  validated_at      TEXT,
  committed_at      TEXT
);

-- Carry over anything already present, mapping the old status values onto the
-- new set. 'confirmed' and 'preview' both mean "validated, awaiting commit".
INSERT INTO import_batches_new (
  id, import_type, status, original_filename, r2_object_key,
  uploaded_by, total_rows, invalid_rows, validation_summary, created_at, committed_at
)
SELECT
  id,
  import_type,
  CASE status
    WHEN 'pending'    THEN 'pending'
    WHEN 'validating' THEN 'validating'
    WHEN 'preview'    THEN 'preview'
    WHEN 'confirmed'  THEN 'preview'
    WHEN 'committed'  THEN 'committed'
    WHEN 'failed'     THEN 'validation_failed'
    ELSE 'pending'
  END,
  original_filename,
  r2_object_key,
  uploaded_by,
  record_count,
  error_count,
  validation_errors,
  created_at,
  completed_at
FROM import_batches;

DROP TABLE import_batches;
ALTER TABLE import_batches_new RENAME TO import_batches;

CREATE INDEX IF NOT EXISTS idx_import_batches_import_type ON import_batches(import_type);
CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS idx_import_batches_created_at ON import_batches(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_import_batches_uploaded_by ON import_batches(uploaded_by);

-- ---------------------------------------------------------------------------
-- IMPORT BATCH ROWS (staging)
-- ---------------------------------------------------------------------------
--
-- One row per spreadsheet row, written once during validation and read back for
-- the preview. Deliberately narrow: the per-domain shapes for employees, roster
-- and menu belong to their own slices, so this stores a normalized preview
-- payload rather than columns for business fields that do not exist yet.

CREATE TABLE IF NOT EXISTS import_batch_rows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,

  -- 1-based, matching what the administrator sees in the spreadsheet.
  row_number      INTEGER NOT NULL,

  status          TEXT NOT NULL CHECK (status IN ('valid', 'warning', 'invalid')),

  -- Human-readable messages for this row. JSON array of strings.
  messages        TEXT,

  -- Normalized preview of what this row would write, as JSON. Populated by the
  -- per-type validator; NULL when the row could not be parsed at all.
  preview_json    TEXT,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE (import_batch_id, row_number)
);

-- The preview reads a batch's rows ordered by row number, and the counts query
-- groups by status; this index serves both without a scan.
CREATE INDEX IF NOT EXISTS idx_import_batch_rows_batch
  ON import_batch_rows(import_batch_id, row_number);
CREATE INDEX IF NOT EXISTS idx_import_batch_rows_status
  ON import_batch_rows(import_batch_id, status);
