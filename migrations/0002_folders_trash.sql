-- Phase 3 of LOAM-PLAN.md: folders on the home page and a trash you can restore from.
-- Deleting a table already only set tables.deleted_at; this adds the way back, and the cron purges
-- what has sat in the trash for 30 days (src/files.js, TRASH_DAYS).
CREATE TABLE IF NOT EXISTS folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
-- No REFERENCES clause: deleting a folder moves its tables to the top level in code (deleteFolder),
-- so nothing depends on D1's foreign-key enforcement.
ALTER TABLE tables ADD COLUMN folder_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_tables_deleted ON tables(deleted_at);
