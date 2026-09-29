-- Message columns (src/kinds/message.js): 'message' joins the column kinds.
-- SQLite cannot change a CHECK constraint in place, so `columns` is rebuilt. cells_meta points at
-- columns(id) ON DELETE CASCADE, and DROP TABLE runs an implicit DELETE that fires that cascade,
-- so every cell's status and result is copied aside first and put back after
-- (test/migrations.test.mjs proves nothing is lost).
PRAGMA defer_foreign_keys = true;

CREATE TABLE cells_meta_keep AS SELECT * FROM cells_meta;

CREATE TABLE columns_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id    INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'data' CHECK (kind IN ('data', 'enrich', 'waterfall', 'formula', 'ai', 'http', 'message')),
  type        TEXT NOT NULL DEFAULT 'text',
  config      TEXT NOT NULL DEFAULT '{}',
  position    INTEGER NOT NULL DEFAULT 0,
  width       INTEGER,
  created_at  TEXT NOT NULL,
  description TEXT,
  color       TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (table_id, key)
);
INSERT INTO columns_new (id, table_id, key, name, kind, type, config, position, width, created_at, description, color, pinned)
  SELECT id, table_id, key, name, kind, type, config, position, width, created_at, description, color, pinned FROM columns;

DROP TABLE columns;
ALTER TABLE columns_new RENAME TO columns;
CREATE INDEX IF NOT EXISTS idx_columns_table ON columns(table_id, position);

INSERT OR REPLACE INTO cells_meta SELECT * FROM cells_meta_keep;
DROP TABLE cells_meta_keep;

PRAGMA defer_foreign_keys = false;
