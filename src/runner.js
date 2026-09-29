/**
 * The run queue. Clicking Run inserts one cell_jobs row per cell; a drain claims a batch, runs it
 * and writes the results. Drains come from the cron (once a minute) and from the open table
 * (POST /api/run-batch in a loop), so runs move while you watch and finish with the tab closed.
 *
 * LIMITS THAT SHAPE THIS FILE (Cloudflare free plan, developers.cloudflare.com/workers/platform/
 * limits and /d1/platform/limits, read 2026-09-27):
 *   - 50 external subrequests per invocation   -> a batch plans at most MAX_FETCHES fetches, using
 *                                                 each column's worst case (a waterfall = its steps)
 *   - 50 D1 queries per invocation             -> writes are grouped (one statement for all meta,
 *                                                 one for all ledger rows); a job costs ~1 query
 *   - 10 ms CPU per invocation                 -> jobs that parse HTML are capped per batch
 *   Waiting on a fetch is not CPU time, so network-bound work fits.
 *
 * CLAIM TOKEN. Pattern from automations/consent-worker/src/outbox.js: a drain writes a random
 * token onto the rows it takes (only where status is still 'queued') and then reads back by that
 * token, so two drains running at once never run the same cell.
 *
 * BUDGET. Each run has a cap. Before a batch runs, the worst-case cost of its jobs is reserved on
 * the run row with a conditional UPDATE (spent + cost <= budget). Jobs that do not fit are
 * cancelled and the run is marked over_budget. After the calls, the reservation is corrected to
 * the actual cost. Spending can never pass the cap by more than one batch's estimate error.
 */

import { nowIso, parseJson, fail } from './util.js';
import { loadColumns, setValuesStmt, hooks, getColumn, getTableRow } from './tables.js';
import { coerce } from '../public/js/types.js';

export const MAX_FETCHES = 40;       // of 50, leaving room for a waterfall step that retries
export const MAX_JOBS = 25;          // ~1 D1 query each, plus ~12 fixed per batch, under 50
export const MAX_HEAVY = 4;          // HTML parsing jobs per batch (CPU)
const STALE_MIN = 5;                 // a 'running' job older than this was lost with its Worker

/**
 * kind -> { estimate(col, overrides) -> {subreq, micros, heavy}, run(col, data, ctx) -> Outcome }
 * Outcome: { status: done|no_result|skipped|error, value, outputs: {field: v}, provider, error,
 *            calls: [{provider, cost, outcome, note}], result }
 * Each column kind registers itself (src/kinds/*.js).
 */
export const EXECUTORS = {};

async function getOverrides(db) {
  const r = await db.prepare(`SELECT value FROM settings WHERE key='cost_overrides'`).first();
  return parseJson(r?.value, {}) || {};
}

/* ---------------------------------------------------------------- enqueue */

/**
 * scope: 'empty' (default: rows with no value yet), 'all' (re-run everything), 'errored',
 * 'selected' (row_ids). Rows that already have a queued job for this column are skipped.
 */
export async function enqueueRun(db, tableId, body) {
  await getTableRow(db, tableId);
  const col = await getColumn(db, Number(body?.column_id));
  if (col.table_id !== tableId) fail(400, 'That column is not in this table');
  const ex = EXECUTORS[col.kind];
  if (!ex) fail(400, 'Only enrichment, waterfall, AI and HTTP columns run');
  const scope = body.scope || 'empty';
  const settings = await db.prepare(`SELECT key, value FROM settings WHERE key IN ('default_budget_micros','cost_overrides')`).all();
  const s = Object.fromEntries(settings.results.map((r) => [r.key, parseJson(r.value, null)]));
  const budget = body.budget_micros ?? s.default_budget_micros ?? 1_000_000;
  if (!Number.isInteger(budget) || budget < 0) fail(400, 'budget_micros must be a whole number of micro-dollars');
  const est = ex.estimate(col, s.cost_overrides || {});

  let where;
  const args = [tableId, col.id];
  if (scope === 'all') where = '1=1';
  else if (scope === 'empty') { where = `json_extract(r.data, ?3) IS NULL`; args.push(`$."${col.key}"`); }
  else if (scope === 'errored') where = `EXISTS (SELECT 1 FROM cells_meta m WHERE m.row_id=r.id AND m.column_id=?2 AND m.status='error')`;
  else if (scope === 'selected') {
    if (!Array.isArray(body.row_ids) || !body.row_ids.every(Number.isInteger)) fail(400, 'row_ids must be a list of row ids');
    where = `r.id IN (SELECT value FROM json_each(?3))`; args.push(JSON.stringify(body.row_ids));
  } else fail(400, `Unknown scope: ${scope}`);

  const now = nowIso();
  const [runRes] = await db.batch([db.prepare(`INSERT INTO runs (table_id, column_id, label, budget_micros, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`).bind(tableId, col.id, `${col.name}: ${scope}`, budget, now)]);
  const runId = runRes.results[0].id;
  const n = args.length;
  await db.batch([
    db.prepare(`INSERT INTO cell_jobs (run_id, table_id, row_id, column_id, subreq, est_micros, created_at)
      SELECT ?${n + 1}, r.table_id, r.id, ?2, ?${n + 2}, ?${n + 3}, ?${n + 4} FROM rows r
       WHERE r.table_id=?1 AND ${where}
         AND NOT EXISTS (SELECT 1 FROM cell_jobs j WHERE j.row_id=r.id AND j.column_id=?2 AND j.status IN ('queued','running'))
       ORDER BY r.id`).bind(...args, runId, est.subreq, est.micros, now),
    db.prepare(`INSERT INTO cells_meta (row_id, column_id, status, updated_at)
      SELECT row_id, column_id, 'queued', ?2 FROM cell_jobs WHERE run_id=?1 AND true
      ON CONFLICT(row_id, column_id) DO UPDATE SET status='queued', error=NULL, updated_at=excluded.updated_at`).bind(runId, now),
  ]);
  const count = (await db.prepare('SELECT count(*) AS n FROM cell_jobs WHERE run_id=?1').bind(runId).first()).n;
  if (!count) await db.prepare(`UPDATE runs SET status='done', finished_at=?2 WHERE id=?1`).bind(runId, now).run();
  return { run_id: runId, queued: count, est_micros: count * est.micros, budget_micros: budget, per_cell_micros: est.micros };
}

export async function stopRun(db, runId) {
  const run = await db.prepare('SELECT * FROM runs WHERE id=?1').bind(runId).first();
  if (!run) fail(404, 'No such run');
  await cancelQueued(db, runId, null, 'stopped');
  return { ok: true };
}

/** Cancel a run's queued jobs; their cells go back to how they looked before (no status). */
async function cancelQueued(db, runId, reason, status, keepIds = []) {
  const now = nowIso();
  await db.batch([
    db.prepare(`UPDATE cell_jobs SET status='cancelled', error=?2 WHERE run_id=?1 AND status='queued'
        AND id NOT IN (SELECT value FROM json_each(?3))`).bind(runId, reason, JSON.stringify(keepIds)),
    reason
      ? db.prepare(`UPDATE cells_meta SET status='skipped', error=?2, updated_at=?3 WHERE status='queued'
          AND EXISTS (SELECT 1 FROM cell_jobs j WHERE j.run_id=?1 AND j.status='cancelled' AND j.row_id=cells_meta.row_id AND j.column_id=cells_meta.column_id)`).bind(runId, reason, now)
      : db.prepare(`DELETE FROM cells_meta WHERE status='queued'
          AND EXISTS (SELECT 1 FROM cell_jobs j WHERE j.run_id=?1 AND j.status='cancelled' AND j.row_id=cells_meta.row_id AND j.column_id=cells_meta.column_id)`).bind(runId),
    db.prepare(`UPDATE runs SET status=?2, finished_at=?3 WHERE id=?1 AND status='running'`).bind(runId, status, now),
  ]);
}

/* ---------------------------------------------------------------- drain */

/**
 * Claim and run one batch. deps: {fetch, now}. Returns a summary the browser uses to decide
 * whether to call again: {claimed, done, no_result, skipped, error, over_budget, remaining}.
 */
export async function processBatch(env, deps = {}) {
  const db = env.DB;
  const fetch = deps.fetch || globalThis.fetch;
  const now = deps.now || new Date();
  const ts = now.toISOString();
  const report = { claimed: 0, done: 0, no_result: 0, skipped: 0, error: 0, over_budget: 0, remaining: 0 };

  // Jobs whose Worker died mid-run go back on the queue.
  await db.prepare(`UPDATE cell_jobs SET status='queued', claim=NULL WHERE status='running' AND claimed_at < ?1`)
    .bind(new Date(now.getTime() - STALE_MIN * 60000).toISOString()).run();

  const { results: cands } = await db.prepare(`SELECT j.id, j.run_id, j.subreq, j.est_micros, c.kind, c.config
      FROM cell_jobs j JOIN columns c ON c.id=j.column_id WHERE j.status='queued' ORDER BY j.id LIMIT 80`).all();
  if (!cands.length) return report;

  // Plan the batch inside the fetch, job and CPU budgets. Always take at least one job.
  const plan = []; let fetches = 0; let heavy = 0;
  for (const j of cands) {
    const isHeavy = EXECUTORS[j.kind]?.heavy?.({ config: parseJson(j.config, {}) }) || false;
    if (plan.length && (fetches + j.subreq > MAX_FETCHES || plan.length >= MAX_JOBS || (isHeavy && heavy >= MAX_HEAVY))) continue;
    plan.push(j); fetches += j.subreq; if (isHeavy) heavy++;
  }

  // Reserve worst-case spend per run; whatever does not fit is cancelled and the run stops.
  const byRun = new Map();
  for (const j of plan) { if (!byRun.has(j.run_id)) byRun.set(j.run_id, []); byRun.get(j.run_id).push(j); }
  const take = [];
  for (const [runId, jobs] of byRun) {
    const total = jobs.reduce((a, j) => a + j.est_micros, 0);
    if (await reserve(db, runId, total)) { take.push(...jobs); continue; }
    const run = await db.prepare('SELECT budget_micros, spent_micros, status FROM runs WHERE id=?1').bind(runId).first();
    if (!run || run.status !== 'running') continue;
    let room = run.budget_micros - run.spent_micros; const fit = [];
    for (const j of jobs) { if (j.est_micros <= room) { fit.push(j); room -= j.est_micros; } else break; }
    const fitTotal = fit.reduce((a, j) => a + j.est_micros, 0);
    if (fit.length && await reserve(db, runId, fitTotal)) take.push(...fit);
    else fit.length = 0;
    if (fit.length < jobs.length) {
      report.over_budget += jobs.length - fit.length;
      await cancelQueued(db, runId, `Stopped: this run reached its $${(run.budget_micros / 1e6).toFixed(2)} budget`, 'over_budget', fit.map((j) => j.id));
    }
  }
  if (!take.length) { report.remaining = await remaining(db); return report; }

  const claim = crypto.randomUUID();
  await db.prepare(`UPDATE cell_jobs SET status='running', claim=?1, attempts=attempts+1, claimed_at=?2
      WHERE status='queued' AND id IN (SELECT value FROM json_each(?3))`).bind(claim, ts, JSON.stringify(take.map((j) => j.id))).run();
  const { results: jobs } = await db.prepare(`SELECT j.id, j.run_id, j.row_id, j.column_id, j.table_id, j.est_micros, r.data
      FROM cell_jobs j JOIN rows r ON r.id=j.row_id WHERE j.claim=?1 AND j.status='running' ORDER BY j.id`).bind(claim).all();
  report.claimed = jobs.length;
  // A job reserved but lost to another drain between plan and claim: give its reservation back.
  const lost = take.filter((t) => !jobs.some((j) => j.id === t.id));
  const refund = new Map();
  for (const t of lost) refund.set(t.run_id, (refund.get(t.run_id) || 0) - t.est_micros);
  if (!jobs.length) { await adjustRuns(db, refund); return report; }

  await db.prepare(`UPDATE cells_meta SET status='running', updated_at=?2 WHERE status='queued'
      AND EXISTS (SELECT 1 FROM cell_jobs j WHERE j.claim=?1 AND j.row_id=cells_meta.row_id AND j.column_id=cells_meta.column_id)`).bind(claim, ts).run();

  const tableIds = [...new Set(jobs.map((j) => j.table_id))];
  const colsByTable = new Map();
  for (const t of tableIds) colsByTable.set(t, await loadColumns(db, t));
  const overrides = await getOverrides(db);
  const secret = (name) => secretValue(env, name);

  // Run the claimed jobs concurrently: they are network-bound and the fetch plan already fits.
  const outcomes = await Promise.all(jobs.map(async (j) => {
    const cols = colsByTable.get(j.table_id);
    const col = cols.find((c) => c.id === j.column_id);
    if (!col || !EXECUTORS[col.kind]) return { job: j, col, out: { status: 'error', error: 'This column no longer runs', calls: [] } };
    const row = { id: j.row_id, data: parseJson(j.data, {}) };
    const data = hooks.computeRow(row, cols);
    let out;
    try {
      out = await EXECUTORS[col.kind].run(col, data, { fetch, secret, overrides, cols, now, row, env });
    } catch (e) {
      out = { status: 'error', error: String(e?.message || e).slice(0, 500), calls: [] };
    }
    return { job: j, col, cols, out };
  }));

  /* ---------- write everything back in as few statements as possible */
  const stmts = []; const metas = []; const ledger = []; const doneIds = []; const failIds = [];
  for (const { job, col, cols, out } of outcomes) {
    report[out.status] = (report[out.status] || 0) + 1;
    const cost = (out.calls || []).reduce((a, c) => a + (c.cost || 0), 0);
    refund.set(job.run_id, (refund.get(job.run_id) || 0) + cost - job.est_micros);
    for (const c of out.calls || []) {
      ledger.push({ table_id: job.table_id, row_id: job.row_id, column_id: job.column_id, run_id: job.run_id,
        provider: c.provider, cost_micros: c.cost || 0, outcome: c.outcome || out.status, note: c.note ? String(c.note).slice(0, 300) : null });
    }
    if (col && (out.status === 'done' || out.status === 'no_result')) {
      const values = { [col.key]: out.status === 'done' ? coerce(col.type, out.value ?? null) : null };
      const byKey = new Map((cols || []).map((c) => [c.key, c]));
      for (const [k, v] of Object.entries(out.outputs || {})) {
        const target = byKey.get(k);
        if (target && target.kind === 'data') values[k] = coerce(target.type, v ?? null);
      }
      stmts.push(setValuesStmt(db, job.row_id, values, ts));
    }
    metas.push({ row_id: job.row_id, column_id: job.column_id, status: out.status, provider: out.provider || null,
      cost_micros: cost, error: out.error ? String(out.error).slice(0, 500) : null,
      result: out.result ? JSON.stringify(out.result).slice(0, 20_000) : null });
    (out.status === 'error' ? failIds : doneIds).push(job.id);
  }
  stmts.push(db.prepare(`INSERT INTO cells_meta (row_id, column_id, status, provider, cost_micros, error, result, updated_at)
      SELECT json_extract(value,'$.row_id'), json_extract(value,'$.column_id'), json_extract(value,'$.status'),
             json_extract(value,'$.provider'), json_extract(value,'$.cost_micros'), json_extract(value,'$.error'),
             json_extract(value,'$.result'), ?2 FROM json_each(?1) WHERE true
      ON CONFLICT(row_id, column_id) DO UPDATE SET status=excluded.status, provider=excluded.provider,
        cost_micros=excluded.cost_micros, error=excluded.error, result=COALESCE(excluded.result, cells_meta.result),
        updated_at=excluded.updated_at`).bind(JSON.stringify(metas), ts));
  if (ledger.length) {
    stmts.push(db.prepare(`INSERT INTO ledger (ts, table_id, row_id, column_id, run_id, provider, cost_micros, outcome, note)
        SELECT ?2, json_extract(value,'$.table_id'), json_extract(value,'$.row_id'), json_extract(value,'$.column_id'),
               json_extract(value,'$.run_id'), json_extract(value,'$.provider'), json_extract(value,'$.cost_micros'),
               json_extract(value,'$.outcome'), json_extract(value,'$.note') FROM json_each(?1)`).bind(JSON.stringify(ledger), ts));
  }
  stmts.push(db.prepare(`UPDATE cell_jobs SET status='done', claim=NULL WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(doneIds)));
  if (failIds.length) stmts.push(db.prepare(`UPDATE cell_jobs SET status='failed', claim=NULL WHERE id IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(failIds)));
  await db.batch(stmts);
  await adjustRuns(db, refund, ts);
  report.remaining = await remaining(db);
  return report;
}

/** Atomically add `micros` to a run's spend, only if it stays within budget. */
async function reserve(db, runId, micros) {
  const [r] = await db.batch([db.prepare(`UPDATE runs SET spent_micros = spent_micros + ?2
      WHERE id=?1 AND status='running' AND spent_micros + ?2 <= budget_micros RETURNING id`).bind(runId, micros)]);
  return r.results.length > 0;
}

/** Correct each run's reservation to actual spend, then close runs with nothing left to do. */
async function adjustRuns(db, deltas, ts = nowIso()) {
  const stmts = [];
  for (const [runId, delta] of deltas) {
    if (delta) stmts.push(db.prepare('UPDATE runs SET spent_micros = MAX(0, spent_micros + ?2) WHERE id=?1').bind(runId, delta));
    stmts.push(db.prepare(`UPDATE runs SET status='done', finished_at=?2 WHERE id=?1 AND status='running'
        AND NOT EXISTS (SELECT 1 FROM cell_jobs WHERE run_id=?1 AND status IN ('queued','running'))`).bind(runId, ts));
  }
  if (stmts.length) await db.batch(stmts);
}

const remaining = async (db) => (await db.prepare(`SELECT count(*) AS n FROM cell_jobs WHERE status IN ('queued','running')`).first()).n;

/**
 * A secret's value, by name, for functions and HTTP columns. The app password and bindings are
 * never readable, whatever a column config says.
 */
export function secretValue(env, name) {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name) || ['APP_PASSWORD', 'DB', 'ASSETS'].includes(name)) throw new Error(`${name} cannot be used as a key`);
  const v = env[name];
  if (typeof v !== 'string' || !v) throw new Error(`${name} is not set. Run: npx wrangler secret put ${name}`);
  return v;
}

/** Everything that changed in a table since a timestamp: the open grid polls this during a run. */
export async function changesSince(db, tableId, since) {
  const s = String(since || '1970');
  const [rows, meta, runs] = await Promise.all([
    db.prepare(`SELECT json_group_array(json_object('id', id, 'data', json(data), 'updated_at', updated_at)) AS j
                  FROM rows WHERE table_id=?1 AND updated_at >= ?2`).bind(tableId, s).first(),
    db.prepare(`SELECT json_group_array(json_object('row_id', m.row_id, 'column_id', m.column_id, 'status', m.status,
                  'provider', m.provider, 'cost_micros', m.cost_micros, 'error', m.error)) AS j
                  FROM cells_meta m JOIN rows r ON r.id=m.row_id WHERE r.table_id=?1 AND m.updated_at >= ?2`).bind(tableId, s).first(),
    db.prepare(`SELECT id, column_id, label, budget_micros, spent_micros, status, created_at, finished_at FROM runs
                 WHERE table_id=?1 AND (status='running' OR finished_at >= ?2) ORDER BY id`).bind(tableId, s).all(),
  ]);
  return `{"now":${JSON.stringify(nowIso())},"rows":${rows?.j || '[]'},"meta":${meta?.j || '[]'},"runs":${JSON.stringify(runs.results)}}`;
}
