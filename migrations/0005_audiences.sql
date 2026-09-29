-- Phase 7 of LOAM-PLAN.md: Audiences, one People and one Companies database across all tables.
-- One table for both kinds: a record is a JSON object of fields (public/js/audience-fields.js),
-- like rows.data, so a new field never needs a migration.
-- key: what makes two records the same one. People: the email, lower case; without an email, the
-- name plus the company or domain. Companies: the domain; without one, the name plus the city.
-- sources: {field: {source, at}}, where each value came from and when (Clay shows the same).
CREATE TABLE IF NOT EXISTS audience_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('people', 'companies')),
  key         TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  sources     TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (kind, key)
);
CREATE INDEX IF NOT EXISTS idx_audience_kind ON audience_records(kind, id);

-- Saved filters over one kind. They are re-run on open, so a segment is always current.
CREATE TABLE IF NOT EXISTS segments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL CHECK (kind IN ('people', 'companies')),
  name        TEXT NOT NULL,
  filters     TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
