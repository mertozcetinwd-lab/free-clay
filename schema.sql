-- free-clay schema (Cloudflare D1 / SQLite). Safe to run more than once.
-- Apply locally:  npx wrangler d1 execute free-clay --local  --file schema.sql
-- Apply live:     npx wrangler d1 execute free-clay --remote --file schema.sql
--
-- Design notes
-- * A row's cell values live in one JSON object (rows.data), keyed by column key. Adding a column
--   never needs a migration, the same trick as the CRM's `extra`.
-- * Money is integer micro-dollars (1,000,000 = $1). An Exa call is ~$0.007 and an LLM row can be a
--   fraction of a cent, so cents are too coarse and floats drift when summed.
-- * Timestamps are ISO-8601 UTC strings.
-- * Keys never live here. secrets_index holds the NAMES of Worker secrets the user has set with
--   `wrangler secret put`, so an HTTP column can reference one without the value touching D1.

CREATE TABLE IF NOT EXISTS tables (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  position        INTEGER NOT NULL DEFAULT 0,
  webhook_secret  TEXT,                         -- signs POSTs to /api/hook/<id>; NULL = webhook off
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);

-- kind: data (you type or import it), enrich (one function), waterfall (ordered functions),
-- formula (computed on read, never stored), ai (a prompt on your key), http (any API).
-- type: how the value is shown and sorted (text, number, currency, date, url, email, checkbox,
-- select, multi_select, json).
-- config: JSON. For computed columns: fn / steps / inputs / outputs / condition / auto.
CREATE TABLE IF NOT EXISTS columns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id    INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'data' CHECK (kind IN ('data', 'enrich', 'waterfall', 'formula', 'ai', 'http')),
  type        TEXT NOT NULL DEFAULT 'text',
  config      TEXT NOT NULL DEFAULT '{}',
  position    INTEGER NOT NULL DEFAULT 0,
  width       INTEGER,
  created_at  TEXT NOT NULL,
  UNIQUE (table_id, key)
);
CREATE INDEX IF NOT EXISTS idx_columns_table ON columns(table_id, position);

CREATE TABLE IF NOT EXISTS rows (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id    INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  data        TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rows_table ON rows(table_id, id);

-- One row per computed cell that has ever been queued or run. No row = "empty" (never run).
-- status: queued, running, done, no_result, error, skipped (run condition false or inputs missing).
CREATE TABLE IF NOT EXISTS cells_meta (
  row_id       INTEGER NOT NULL REFERENCES rows(id) ON DELETE CASCADE,
  column_id    INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  status       TEXT NOT NULL,
  provider     TEXT,              -- which function answered (the waterfall winner)
  cost_micros  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,              -- the provider's own message, shown on hover
  result       TEXT,              -- full JSON the function returned, for "add as column" later
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (row_id, column_id)
);

-- A click on Run makes one `runs` row (the budget cap lives here) and one cell_jobs row per cell.
CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id       INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  column_id      INTEGER,
  label          TEXT,
  budget_micros  INTEGER NOT NULL DEFAULT 0,       -- 0 = the run may spend nothing metered
  spent_micros   INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'running',  -- running, done, stopped, over_budget
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_table ON runs(table_id, id);

-- The queue. Claimed with a random token so two drains (cron + the browser) never run a cell twice:
-- the pattern proven in automations/consent-worker/src/outbox.js.
-- status: queued, running, done, failed, cancelled
CREATE TABLE IF NOT EXISTS cell_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  table_id    INTEGER NOT NULL,
  row_id      INTEGER NOT NULL,
  column_id   INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  claim       TEXT,
  subreq      INTEGER NOT NULL DEFAULT 1,     -- worst-case fetches this cell can make
  est_micros  INTEGER NOT NULL DEFAULT 0,     -- worst-case cost, checked against the run budget
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  created_at  TEXT NOT NULL,
  claimed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON cell_jobs(status, id);
CREATE INDEX IF NOT EXISTS idx_jobs_run ON cell_jobs(run_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_cell ON cell_jobs(row_id, column_id, status);

-- Every provider call, free ones included (cost 0), so spend is never a guess.
CREATE TABLE IF NOT EXISTS ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  table_id     INTEGER,
  row_id       INTEGER,
  column_id    INTEGER,
  run_id       INTEGER,
  provider     TEXT NOT NULL,     -- function id, e.g. hunter_email_finder
  cost_micros  INTEGER NOT NULL DEFAULT 0,
  outcome      TEXT NOT NULL,     -- done, no_result, error
  note         TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_ts ON ledger(ts);
CREATE INDEX IF NOT EXISTS idx_ledger_table ON ledger(table_id, ts);
CREATE INDEX IF NOT EXISTS idx_ledger_run ON ledger(run_id);

CREATE TABLE IF NOT EXISTS secrets_index (
  name        TEXT PRIMARY KEY,   -- e.g. HUNTER_API_KEY; the value is a Worker secret, never here
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS views (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id  INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  config    TEXT NOT NULL DEFAULT '{}',   -- filters, sort, hidden columns, widths
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- Wrong-password attempts per IP, so the one password cannot be guessed at speed.
CREATE TABLE IF NOT EXISTS login_failures (
  ip  TEXT NOT NULL,
  at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(ip, at);

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('theme', '"system"'),
  ('auto_run', 'false'),                 -- Clay has auto-run on; here nothing runs until you click
  ('default_budget_micros', '1000000'),  -- $1.00 cap per run unless you raise it
  ('cost_overrides', '{}');              -- your own per-call prices, by function id
