/**
 * "Try on 5 rows" (Clay has it on AI columns): run a column's settings on the first few rows
 * WITHOUT saving the column or writing any cell, so a prompt or a message can be judged before a
 * whole table runs. Paid calls are real, so they are capped and ledgered like any run:
 *   - rows: up to 5, fewer if the worst case would pass your budget per run, or the fetches one
 *     Worker invocation may make (runner.js MAX_FETCHES);
 *   - every call goes in the ledger with note "try", so Spend shows it.
 * Agent columns are left out: one agent run can take 20 requests (kinds/ai.js AGENT_COLUMN).
 */

import { fail, nowIso, parseJson } from './util.js';
import { CONFIG_CHECKS, loadColumns, hooks, uniqueKey } from './tables.js';
import { EXECUTORS, MAX_FETCHES, secretValue } from './runner.js';

const TRY_KINDS = ['enrich', 'waterfall', 'ai', 'http', 'message'];

export async function tryColumn(env, deps, tableId, body) {
  const db = env.DB;
  const kind = String(body?.kind || '');
  if (!TRY_KINDS.includes(kind)) fail(400, 'Try works on enrichment, waterfall, AI, HTTP and Message columns');
  const config = body.config && typeof body.config === 'object' ? body.config : fail(400, 'Send the column settings');
  if (kind === 'ai' && config.agent_id) fail(400, 'Agent columns cannot be tried here: run the agent on the Agents page');
  CONFIG_CHECKS[kind]?.(config);
  const cols = await loadColumns(db, tableId);
  // The key the column has (editing) or will get (new): spintax picks by row and key, so Try shows
  // the same choice the saved column will write.
  const key = /^[a-z0-9_]{1,40}$/.test(String(body.key || '')) ? body.key : String(body.name || '').trim() ? await uniqueKey(db, tableId, String(body.name).slice(0, 80)) : '__try';
  const col = { id: 0, key, name: String(body.name || 'Try').slice(0, 80), kind, type: body.type || 'text', config };
  const settings = Object.fromEntries((await db.prepare(`SELECT key, value FROM settings WHERE key IN ('default_budget_micros','cost_overrides')`).all())
    .results.map((r) => [r.key, parseJson(r.value, null)]));
  const overrides = settings.cost_overrides || {};
  const budget = settings.default_budget_micros ?? 1_000_000;
  const est = EXECUTORS[kind].estimate(col, overrides);
  let n = Math.min(5, Math.max(1, Number.parseInt(body.limit, 10) || 5));
  n = Math.min(n, Math.max(1, Math.floor(MAX_FETCHES / Math.max(1, est.subreq))));
  if (est.micros > 0) n = Math.min(n, Math.floor(budget / est.micros));
  if (n < 1) fail(400, `One row could cost $${(est.micros / 1e6).toFixed(4)}, over your budget per run of $${(budget / 1e6).toFixed(2)}. Raise it in Settings.`);
  const { results: rows } = await db.prepare('SELECT id, data FROM rows WHERE table_id=?1 ORDER BY id LIMIT ?2').bind(tableId, n).all();
  if (!rows.length) fail(400, 'Add a row first');

  const fetch = deps.fetch || globalThis.fetch.bind(globalThis);   // bound: Workers refuse ctx.fetch(...) on the raw global
  const secret = (name) => secretValue(env, name);
  const now = deps.now || new Date();
  const out = await Promise.all(rows.map(async (r) => {
    const row = { id: r.id, data: parseJson(r.data, {}) };
    const data = hooks.computeRow(row, cols);
    let o;
    try { o = await EXECUTORS[kind].run(col, data, { fetch, secret, overrides, cols, now, row, env }); }
    catch (e) { o = { status: 'error', error: String(e?.message || e).slice(0, 500), calls: [] }; }
    return { row_id: r.id, o };
  }));

  const ts = nowIso(); const ledger = [];
  for (const { row_id, o } of out) for (const c of o.calls || []) {
    ledger.push(db.prepare(`INSERT INTO ledger (ts, table_id, row_id, provider, cost_micros, outcome, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(ts, tableId, row_id, c.provider, c.cost || 0, c.outcome || o.status, `try: ${String(c.note || '').slice(0, 280)}`));
  }
  if (ledger.length) await db.batch(ledger);
  const results = out.map(({ row_id, o }) => ({ row_id, status: o.status, value: o.value ?? null, outputs: o.outputs || {}, error: o.error || null,
    result: o.result || null, cost_micros: (o.calls || []).reduce((a, c) => a + (c.cost || 0), 0) }));
  return { tried: results.length, est_micros: est.micros * results.length, cost_micros: results.reduce((a, r) => a + r.cost_micros, 0), results };
}
