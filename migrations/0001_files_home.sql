-- Loam v2, phase 2: the home page file list (favorites, recents) and the greeting name.
-- Applied by wrangler (`npx wrangler d1 migrations apply free-clay --remote`), which records it in
-- d1_migrations so it never runs twice. schema.sql stays the v1 base; every change after v1 lives
-- in a numbered file here.
ALTER TABLE tables ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tables ADD COLUMN last_opened_at TEXT;
INSERT OR IGNORE INTO settings (key, value) VALUES ('profile_name', '""');
