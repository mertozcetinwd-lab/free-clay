-- Phases 9 to 11 of LOAM-PLAN.md: agents, workflows, signals, API tokens and the exports list.
-- Configs are JSON, like columns.config, so new settings never need a migration.

-- Agents (src/agents.js). config: prompt, instructions, provider, model, tools, fields, limits.
CREATE TABLE IF NOT EXISTS agents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  config      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
-- One row per run, with every step. The cron keeps the last 200 per agent.
CREATE TABLE IF NOT EXISTS agent_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL,
  source       TEXT NOT NULL,          -- test, column, workflow, mcp
  status       TEXT NOT NULL,          -- done, error, over_budget, max_steps, limit
  input        TEXT NOT NULL DEFAULT '{}',
  output       TEXT,
  steps        TEXT NOT NULL DEFAULT '[]',
  cost_micros  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs ON agent_runs(agent_id, id);

-- Workflows (src/workflows.js). graph: {nodes, edges}. state: trigger bookkeeping (row cursor,
-- next scheduled time). webhook_token: the secret part of the webhook trigger's URL.
CREATE TABLE IF NOT EXISTS workflows (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'off',
  graph          TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT '{}',
  webhook_token  TEXT,
  last_run_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
-- status: queued, running, waiting (a Delay step), done, error, over_budget.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id  INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  trigger      TEXT,
  item         TEXT NOT NULL DEFAULT '{}',
  queue        TEXT NOT NULL DEFAULT '[]',
  log          TEXT NOT NULL DEFAULT '[]',
  cost_micros  INTEGER NOT NULL DEFAULT 0,
  claim        TEXT,
  claimed_at   TEXT,
  resume_at    TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_wf_runs_status ON workflow_runs(status, id);
CREATE INDEX IF NOT EXISTS idx_wf_runs_wf ON workflow_runs(workflow_id, id);

-- Signals (src/signals.js). config: type, targets, keyword, forms, every_hours, table_id.
CREATE TABLE IF NOT EXISTS signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'off',
  config      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
-- What each target looked like at the last check (seen job links, the page's hash).
CREATE TABLE IF NOT EXISTS signal_state (
  signal_id   INTEGER NOT NULL,
  target      TEXT NOT NULL,
  state       TEXT,
  error       TEXT,
  checked_at  TEXT NOT NULL,
  PRIMARY KEY (signal_id, target)
);
CREATE TABLE IF NOT EXISTS signal_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   INTEGER NOT NULL,
  target      TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT,
  detail      TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_events ON signal_events(signal_id, id);

-- API tokens (src/tokens.js): only the SHA-256 is kept.
CREATE TABLE IF NOT EXISTS api_tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  hash          TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  revoked_at    TEXT
);

-- Every CSV download, kept 30 days so it can be downloaded again as it was (src/exports.js).
CREATE TABLE IF NOT EXISTS exports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  table_id    INTEGER,
  name        TEXT NOT NULL,
  rows        INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  csv         TEXT,                     -- NULL when over 1.5 MB (D1 rows stay under 2 MB)
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exports_created ON exports(created_at);

INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_context', '""');
