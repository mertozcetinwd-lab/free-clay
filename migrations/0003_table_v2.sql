-- Phase 4 of LOAM-PLAN.md: table settings and column extras from Clay's table (teardown 5.4, 5.5).
-- dedupe_key: a column key; when set, rows added later whose value in that column (trimmed, any
-- case) matches an older row are removed, keeping the oldest (src/tables.js, dedupeRows).
ALTER TABLE tables ADD COLUMN description TEXT;
ALTER TABLE tables ADD COLUMN dedupe_key TEXT;
ALTER TABLE columns ADD COLUMN description TEXT;
ALTER TABLE columns ADD COLUMN color TEXT;
ALTER TABLE columns ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
