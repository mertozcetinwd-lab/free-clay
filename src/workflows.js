/**
 * Workflows (LOAM-PLAN.md phase 9; Clay's Workflows beta, teardown-v2 5.3): a trigger, then steps
 * joined by arrows. Each run carries one item (a row, a webhook body, a segment record, a signal
 * event) through the steps; each step reads the item with {{slots}} and adds its results to it.
 *
 * GRAPH (stored as JSON, drawn with Drawflow in the browser):
 *   { nodes: [{ id: 'n1', type: 'trigger' | 'function' | 'agent' | 'condition' | 'delay' |
 *                'add_row' | 'upsert' | 'http' | 'set', config: {...}, x, y }],
 *     edges: [{ from: 'n1', to: 'n2', port: 'out' | 'true' | 'false' }] }
 *
 * RUNS are rows in workflow_runs with the item, the queue of nodes still to do and a log. A drain
 * (the cron each minute, or the open page) claims runs with a token, like the table queue
 * (src/runner.js), and works through them inside the free plan's limits: FETCH_CAP outbound
 * requests per invocation shared by every run it touches; a run that would not fit pauses and the
 * next drain carries on. A Delay step parks the run until its time. Every paid call is priced
 * before it happens against the run's budget, and ledgered after.
 */

import { fail, nowIso, parseJson } from './util.js';
import { EXECUTORS, secretValue } from './runner.js';
import { CONFIG_CHECKS, getTableRow, loadColumns, insertRows, hooks } from './tables.js';
import { getFunction, costOf } from './functions/index.js';
import { callFunction, checkInputs } from './kinds/enrich.js';
import { fill } from '../public/js/template.js';
import { checkFormula, conditionTrue } from '../public/js/formula.js';
import { upsertRecords, listRecords } from './audiences.js';
import { fieldKeys } from '../public/js/audience-fields.js';
import { getAgent, runAgent, agentEstimate } from './agents.js';
import { getSettings } from './meta.js';

export const FETCH_CAP = 40;
export const MAX_NODES = 40;
export const MAX_STEPS_PER_RUN = 60;       // node executions: stops loops
export const MAX_RUNS_PER_TRIGGER = 200;   // rows or records per scheduled or manual batch
const MAX_DELAY_MIN = 7 * 24 * 60;
const STALE_MIN = 5;

export const TRIGGERS = {
  manual: 'Run by hand', row_added: 'A row is added to a table', segment_new: 'A new record joins a segment', schedule: 'On a schedule', webhook: 'A webhook is called', signal: 'A signal fires',
};
export const NODE_TYPES = {
  function: 'Run a function', agent: 'Run an agent', condition: 'Condition', delay: 'Delay', add_row: 'Add a row to a table',
  upsert: 'Save to People or Companies', http: 'Call an API', set: 'Set values',
};

const ID_RE = /^n[0-9]{1,6}$/;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

/* ---------------------------------------------------------------- checking a graph */

function checkTemplates(obj, what) {
  if (obj === undefined) return {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(400, `${what} must be an object`);
  if (Object.keys(obj).length > 40) fail(400, `${what}: up to 40 entries`);
  for (const v of Object.values(obj)) if (typeof v !== 'string' || v.length > 5000) fail(400, `${what}: each value is a template up to 5,000 characters`);
  return obj;
}

const CHECKS = {
  trigger(c) {
    if (!TRIGGERS[c.type]) fail(400, 'Pick what starts the workflow');
    if (c.type === 'row_added' && !Number.isInteger(c.table_id)) fail(400, 'Pick the table whose new rows start the workflow');
    if (c.type === 'schedule') {
      if (!(Number.isInteger(c.every_minutes) && c.every_minutes >= 15 && c.every_minutes <= 43200)) fail(400, 'A schedule runs every 15 minutes to every 30 days');
      if (!['none', 'table', 'segment'].includes(c.source || 'none')) fail(400, 'A schedule runs once, or once per row of a table, or once per record of a segment');
      if (c.source === 'table' && !Number.isInteger(c.table_id)) fail(400, 'Pick the table');
      if (c.source === 'segment' && !Number.isInteger(c.segment_id)) fail(400, 'Pick the segment');
    }
    if (c.type === 'signal' && !Number.isInteger(c.signal_id)) fail(400, 'Pick the signal');
    if (c.type === 'segment_new' && !Number.isInteger(c.segment_id)) fail(400, 'Pick the segment');
  },
  function(c) {
    const fn = getFunction(c.fn);
    if (!fn || fn.id.startsWith('test_')) fail(400, 'Pick a function');
    checkInputs(fn, checkTemplates(c.inputs, 'Inputs'));
  },
  agent(c) { if (!Number.isInteger(c.agent_id)) fail(400, 'Pick an agent'); checkTemplates(c.inputs, 'Inputs'); },
  condition(c) { const e = checkFormula(c.formula || ''); if (e) fail(400, `Condition: ${e}`); },
  delay(c) { if (!(Number.isInteger(c.minutes) && c.minutes >= 1 && c.minutes <= MAX_DELAY_MIN)) fail(400, 'A delay is 1 minute to 7 days'); },
  add_row(c) { if (!Number.isInteger(c.table_id)) fail(400, 'Pick a table'); checkTemplates(c.values, 'Values'); },
  upsert(c) {
    if (!['people', 'companies'].includes(c.kind)) fail(400, 'Save to People or Companies');
    const v = checkTemplates(c.values, 'Values');
    for (const k of Object.keys(v)) if (!fieldKeys(c.kind).includes(k)) fail(400, `Unknown field: ${k.slice(0, 40)}`);
  },
  http(c) { CONFIG_CHECKS.http(c); },
  set(c) { for (const k of Object.keys(checkTemplates(c.values, 'Values'))) if (!KEY_RE.test(k)) fail(400, 'Value names: lowercase letters, digits, _'); },
};

export function checkGraph(g) {
  if (!g || typeof g !== 'object') fail(400, 'graph must be an object');
  const nodes = Array.isArray(g.nodes) ? g.nodes : fail(400, 'graph.nodes must be a list');
  const edges = Array.isArray(g.edges) ? g.edges : [];
  if (nodes.length > MAX_NODES) fail(400, `Up to ${MAX_NODES} steps`);
  if (JSON.stringify(g).length > 200_000) fail(400, 'The workflow is too large');
  const ids = new Set();
  let triggers = 0;
  const clean = nodes.map((n) => {
    if (!ID_RE.test(n?.id || '') || ids.has(n.id)) fail(400, 'Each step needs its own id');
    ids.add(n.id);
    if (n.type !== 'trigger' && !NODE_TYPES[n.type]) fail(400, `Unknown step: ${String(n.type).slice(0, 30)}`);
    if (n.type === 'trigger') triggers++;
    const config = n.config && typeof n.config === 'object' ? n.config : {};
    if (config.save_as !== undefined && config.save_as !== '' && !KEY_RE.test(config.save_as)) fail(400, 'Save as: lowercase letters, digits, _');
    return { id: n.id, type: n.type, config, x: Number(n.x) || 0, y: Number(n.y) || 0 };
  });
  if (triggers !== 1) fail(400, 'A workflow has exactly one trigger');
  const cleanEdges = edges.map((e) => {
    if (!ids.has(e?.from) || !ids.has(e?.to) || e.from === e.to) fail(400, 'An arrow joins two different steps');
    const port = ['out', 'true', 'false'].includes(e.port) ? e.port : 'out';
    return { from: e.from, to: e.to, port };
  });
  return { nodes: clean, edges: cleanEdges };
}

/** Full checks, run when a workflow is switched on or run: every step must be set up. */
export async function checkReady(db, graph) {
  for (const n of graph.nodes) {
    try { CHECKS[n.type](n.config); }
    catch (e) { fail(400, `${n.type === 'trigger' ? 'Trigger' : NODE_TYPES[n.type]}: ${e.message}`); }
    if (n.type === 'agent') await getAgent(db, n.config.agent_id);
    if (n.type === 'add_row' || (n.type === 'trigger' && n.config.table_id)) await getTableRow(db, n.config.table_id);
  }
}

const DEFAULT_GRAPH = { nodes: [{ id: 'n1', type: 'trigger', config: { type: 'manual' }, x: 60, y: 160 }], edges: [] };

/* ---------------------------------------------------------------- CRUD */

const wfOut = (r) => ({ id: r.id, name: r.name, status: r.status, graph: parseJson(r.graph, DEFAULT_GRAPH), state: parseJson(r.state, {}),
  created_at: r.created_at, updated_at: r.updated_at, last_run_at: r.last_run_at, has_webhook: !!r.webhook_token });

export async function listWorkflows(db) {
  const { results } = await db.prepare(`SELECT w.*, (SELECT count(*) FROM workflow_runs r WHERE r.workflow_id=w.id) AS runs,
      (SELECT count(*) FROM workflow_runs r WHERE r.workflow_id=w.id AND r.status='error') AS errors,
      (SELECT COALESCE(sum(cost_micros), 0) FROM workflow_runs r WHERE r.workflow_id=w.id) AS spent FROM workflows w ORDER BY w.updated_at DESC`).all();
  return results.map((r) => ({ ...wfOut(r), runs: r.runs, errors: r.errors, spent_micros: r.spent }));
}

export async function getWorkflow(db, id) {
  const r = await db.prepare('SELECT * FROM workflows WHERE id=?1').bind(id).first();
  if (!r) fail(404, 'No such workflow');
  return wfOut(r);
}

export async function createWorkflow(db, body) {
  const name = String(body?.name || 'Untitled workflow').trim().slice(0, 80) || 'Untitled workflow';
  const graph = body?.graph ? checkGraph(body.graph) : DEFAULT_GRAPH;
  const n = (await db.prepare('SELECT count(*) AS n FROM workflows').first()).n;
  if (n >= 100) fail(400, 'Up to 100 workflows');
  const at = nowIso();
  const [r] = await db.batch([db.prepare(`INSERT INTO workflows (name, status, graph, state, created_at, updated_at) VALUES (?1, 'off', ?2, '{}', ?3, ?3) RETURNING id`)
    .bind(name, JSON.stringify(graph), at)]);
  return getWorkflow(db, r.results[0].id);
}

/** body: {name?, graph?, status?: 'on'|'off'}. Switching on checks every step first. */
export async function patchWorkflow(db, id, body) {
  const wf = await getWorkflow(db, id);
  const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : wf.name;
  if (!name) fail(400, 'Name the workflow');
  const graph = body.graph !== undefined ? checkGraph(body.graph) : wf.graph;
  let status = wf.status; const state = { ...wf.state };
  if (body.status !== undefined) {
    if (!['on', 'off'].includes(body.status)) fail(400, 'status is on or off');
    status = body.status;
  }
  if (status === 'on') {
    await checkReady(db, graph);
    const trig = graph.nodes.find((n) => n.type === 'trigger').config;
    // A new-row trigger starts from the rows added AFTER it is switched on, not the whole table.
    if (trig.type === 'row_added' && (wf.status !== 'on' || state.table_id !== trig.table_id)) {
      state.table_id = trig.table_id;
      state.cursor = (await db.prepare('SELECT COALESCE(max(id), 0) AS m FROM rows WHERE table_id=?1').bind(trig.table_id).first()).m;
    }
    if (trig.type === 'schedule' && wf.status !== 'on') state.next_at = nowIso();
    // A new-member trigger starts from records added after it is switched on (Clay's "New member in segment").
    if (trig.type === 'segment_new' && (wf.status !== 'on' || state.segment_id !== trig.segment_id)) {
      state.segment_id = trig.segment_id;
      state.cursor = (await db.prepare('SELECT COALESCE(max(id), 0) AS m FROM audience_records').first()).m;
    }
  }
  await db.prepare('UPDATE workflows SET name=?2, graph=?3, status=?4, state=?5, updated_at=?6 WHERE id=?1')
    .bind(id, name, JSON.stringify(graph), status, JSON.stringify(state), nowIso()).run();
  return getWorkflow(db, id);
}

export async function deleteWorkflow(db, id) {
  await getWorkflow(db, id);
  await db.batch([db.prepare('DELETE FROM workflow_runs WHERE workflow_id=?1').bind(id), db.prepare('DELETE FROM workflows WHERE id=?1').bind(id)]);
  return { ok: true };
}

export async function listRuns(db, id, limit = 50) {
  const { results } = await db.prepare('SELECT * FROM workflow_runs WHERE workflow_id=?1 ORDER BY id DESC LIMIT ?2').bind(id, Math.min(200, limit)).all();
  return results.map((r) => ({ id: r.id, status: r.status, trigger: r.trigger, item: parseJson(r.item, {}), log: parseJson(r.log, []), cost_micros: r.cost_micros,
    error: r.error, created_at: r.created_at, finished_at: r.finished_at, resume_at: r.resume_at }));
}

/** A secret URL for the webhook trigger; made on first ask, rotated on request. */
export async function webhookUrl(db, id, origin, rotate = false) {
  const wf = await db.prepare('SELECT webhook_token FROM workflows WHERE id=?1').bind(id).first();
  if (!wf) fail(404, 'No such workflow');
  let token = wf.webhook_token;
  if (!token || rotate) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    token = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
    await db.prepare('UPDATE workflows SET webhook_token=?2 WHERE id=?1').bind(id, token).run();
  }
  return { url: `${origin}/api/wf/${id}/${token}` };
}

/* ---------------------------------------------------------------- starting runs */

/** Keep an item flat and small: top-level scalars, everything else as JSON text. */
export function flatItem(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj).slice(0, 100)) {
    const key = String(k).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (!key || v === undefined) continue;
    out[key] = v === null || ['string', 'number', 'boolean'].includes(typeof v) ? (typeof v === 'string' ? v.slice(0, 5000) : v) : JSON.stringify(v).slice(0, 5000);
  }
  return out;
}

export async function enqueue(db, wfId, items, trigger) {
  if (!items.length) return 0;
  const at = nowIso();
  const wf = await getWorkflow(db, wfId);
  const start = wf.graph.nodes.find((n) => n.type === 'trigger').id;
  const payload = items.slice(0, MAX_RUNS_PER_TRIGGER).map((it) => ({ item: flatItem(it), queue: next(wf.graph, start, 'out') }));
  await db.prepare(`INSERT INTO workflow_runs (workflow_id, status, trigger, item, queue, log, created_at)
      SELECT ?1, 'queued', ?2, json_extract(value, '$.item'), json_extract(value, '$.queue'), '[]', ?3 FROM json_each(?4)`)
    .bind(wfId, trigger, at, JSON.stringify(payload)).run();
  await db.prepare('UPDATE workflows SET last_run_at=?2 WHERE id=?1').bind(wfId, at).run();
  return payload.length;
}

/** The rows of a table as items: every column, formulas computed, plus row_id and table_id. */
async function tableItems(db, tableId, rowIds) {
  const cols = await loadColumns(db, tableId);
  let sql = 'SELECT id, data FROM rows WHERE table_id=?1'; const args = [tableId];
  if (Array.isArray(rowIds)) { sql += ' AND id IN (SELECT value FROM json_each(?2))'; args.push(JSON.stringify(rowIds)); }
  const { results } = await db.prepare(`${sql} ORDER BY id LIMIT ${MAX_RUNS_PER_TRIGGER}`).bind(...args).all();
  return results.map((r) => ({ ...hooks.computeRow({ id: r.id, data: parseJson(r.data, {}) }, cols), row_id: r.id, table_id: tableId }));
}

/** body: {item?} | {table_id, row_ids?} | {segment_id}. Manual runs work while the workflow is off. */
export async function runNow(db, id, body) {
  const wf = await getWorkflow(db, id);
  await checkReady(db, wf.graph);
  let items;
  if (body?.table_id) { await getTableRow(db, body.table_id); items = await tableItems(db, body.table_id, body.row_ids); }
  else if (body?.segment_id) items = (await listRecords(db, (await segKind(db, body.segment_id)), { segment_id: body.segment_id, limit: MAX_RUNS_PER_TRIGGER }, { max: MAX_RUNS_PER_TRIGGER })).records.map((r) => ({ ...r.data, record_id: r.id }));
  else items = [body?.item && typeof body.item === 'object' ? body.item : {}];
  if (!items.length) fail(400, 'Nothing to run on');
  return { queued: await enqueue(db, id, items, 'manual') };
}

async function segKind(db, id) {
  const s = await db.prepare('SELECT kind FROM segments WHERE id=?1').bind(id).first();
  if (!s) fail(404, 'No such segment');
  return s.kind;
}

/** Public: POST /api/wf/<id>/<token>. The body becomes the item. */
export async function receiveWorkflowHook(request, env, id, token) {
  const db = env.DB;
  const wf = await db.prepare('SELECT id, status, webhook_token, graph FROM workflows WHERE id=?1').bind(id).first();
  const good = wf?.webhook_token && token && wf.webhook_token.length === token.length
    && [...token].reduce((d, ch, i) => d | (ch.charCodeAt(0) ^ wf.webhook_token.charCodeAt(i)), 0) === 0;
  if (!good) return new Response(JSON.stringify({ error: 'Unknown webhook' }), { status: 404, headers: { 'content-type': 'application/json' } });
  const trig = parseJson(wf.graph, DEFAULT_GRAPH).nodes.find((n) => n.type === 'trigger')?.config;
  if (wf.status !== 'on' || trig?.type !== 'webhook') return new Response(JSON.stringify({ error: 'This workflow is off' }), { status: 409, headers: { 'content-type': 'application/json' } });
  const text = await request.text();
  if (text.length > 100_000) return new Response(JSON.stringify({ error: 'Body over 100 KB' }), { status: 413, headers: { 'content-type': 'application/json' } });
  const body = parseJson(text, null);
  const list = Array.isArray(body) ? body.slice(0, 50) : [body && typeof body === 'object' ? body : { body: text }];
  const n = await enqueue(db, id, list, 'webhook');
  return new Response(JSON.stringify({ queued: n }), { status: 202, headers: { 'content-type': 'application/json' } });
}

/** Called by the signals engine for each new event. */
export async function fireSignal(db, signalId, events) {
  const { results } = await db.prepare(`SELECT id, graph FROM workflows WHERE status='on'`).all();
  let n = 0;
  for (const w of results) {
    const t = parseJson(w.graph, DEFAULT_GRAPH).nodes.find((x) => x.type === 'trigger')?.config;
    if (t?.type === 'signal' && t.signal_id === signalId) n += await enqueue(db, w.id, events, 'signal');
  }
  return n;
}

/** The cron: new rows and schedules become runs. */
export async function fireTriggers(db, now = new Date()) {
  const { results } = await db.prepare(`SELECT * FROM workflows WHERE status='on'`).all();
  let fired = 0;
  for (const r of results) {
    const wf = wfOut(r);
    const t = wf.graph.nodes.find((n) => n.type === 'trigger')?.config;
    const state = { ...wf.state };
    if (t?.type === 'row_added') {
      const cols = await loadColumns(db, t.table_id);
      const { results: rows } = await db.prepare(`SELECT id, data FROM rows WHERE table_id=?1 AND id > ?2 ORDER BY id LIMIT 50`).bind(t.table_id, state.cursor || 0).all();
      if (!rows.length) continue;
      fired += await enqueue(db, wf.id, rows.map((x) => ({ ...hooks.computeRow({ id: x.id, data: parseJson(x.data, {}) }, cols), row_id: x.id, table_id: t.table_id })), 'row_added');
      state.cursor = rows[rows.length - 1].id;
    } else if (t?.type === 'segment_new') {
      const kind = await segKind(db, t.segment_id);
      const { records } = await listRecords(db, kind, { segment_id: t.segment_id, limit: 500, sort: null, dir: 'asc' }, { max: 500 });
      const fresh = records.filter((x) => x.id > (state.cursor || 0)).sort((a, b) => a.id - b.id).slice(0, 50);
      const top = (await db.prepare('SELECT COALESCE(max(id), 0) AS m FROM audience_records').first()).m;
      if (fresh.length) fired += await enqueue(db, wf.id, fresh.map((x) => ({ ...x.data, record_id: x.id })), 'segment_new');
      // Past the newest record seen: records that are new but do not match stay behind the cursor.
      state.cursor = fresh.length === 50 ? fresh[49].id : top;
      if (!fresh.length && state.cursor === (wf.state.cursor || 0)) continue;
    } else if (t?.type === 'schedule') {
      if (state.next_at && Date.parse(state.next_at) > now.getTime()) continue;
      let items = [{ scheduled_at: now.toISOString() }];
      if (t.source === 'table') items = await tableItems(db, t.table_id);
      if (t.source === 'segment') items = (await listRecords(db, await segKind(db, t.segment_id), { segment_id: t.segment_id, limit: MAX_RUNS_PER_TRIGGER }, { max: MAX_RUNS_PER_TRIGGER })).records.map((x) => ({ ...x.data, record_id: x.id }));
      fired += await enqueue(db, wf.id, items, 'schedule');
      state.next_at = new Date(now.getTime() + t.every_minutes * 60000).toISOString();
    } else continue;
    await db.prepare('UPDATE workflows SET state=?2 WHERE id=?1').bind(wf.id, JSON.stringify(state)).run();
  }
  return fired;
}

/* ---------------------------------------------------------------- running */

function next(graph, id, port) { return graph.edges.filter((e) => e.from === id && e.port === port).map((e) => e.to); }

class Pause extends Error {}

/** Worst-case {fetches, micros} of one step, checked before it runs. */
async function estimateNode(db, node, overrides, agents) {
  const c = node.config;
  if (node.type === 'function') { const fn = getFunction(c.fn); return { fetches: Math.max(1, fn?.subrequests ?? 1), micros: fn ? costOf(fn, overrides) : 0 }; }
  if (node.type === 'agent') {
    if (!agents.has(c.agent_id)) agents.set(c.agent_id, await getAgent(db, c.agent_id));
    const e = agentEstimate(agents.get(c.agent_id)); return { fetches: e.subreq, micros: e.micros };
  }
  if (node.type === 'http') return { fetches: 1, micros: c.cost_micros || 0 };
  return { fetches: 0, micros: 0 };
}

const fillAll = (templates, item) => Object.fromEntries(Object.entries(templates || {}).map(([k, t]) => [k, fill(t, item, { encode: fill.raw })]));

/** Merge a step's results into the item: save_as = the main value, save_as_<field> = each field. */
function saveInto(item, saveAs, main, fields = {}) {
  if (!saveAs) return;
  item[saveAs] = main ?? null;
  for (const [k, v] of Object.entries(fields || {})) {
    const key = `${saveAs}_${String(k).toLowerCase().replace(/[^a-z0-9_]+/g, '_')}`.slice(0, 60);
    item[key] = v === null || ['string', 'number', 'boolean'].includes(typeof v) ? v : JSON.stringify(v).slice(0, 5000);
  }
}

async function runNode(env, deps, node, item, ctx) {
  const c = node.config; const db = env.DB;
  if (node.type === 'condition') { const ok = conditionTrue(c.formula, item); return { port: ok ? 'true' : 'false', note: ok ? 'true' : 'false' }; }
  if (node.type === 'set') { Object.assign(item, flatItem(fillAll(c.values, item))); return { note: Object.keys(c.values || {}).join(', ') }; }
  if (node.type === 'delay') return { delay: c.minutes };
  if (node.type === 'function') {
    const fn = getFunction(c.fn);
    const r = await callFunction(fn, c.inputs, item, { fetch: ctx.fetch, secret: ctx.secret, overrides: ctx.overrides, now: ctx.now });
    const cost = (r.calls || []).reduce((a, x) => a + (x.cost || 0), 0);
    if (r.status === 'error') throw Object.assign(new Error(r.error), { cost });
    saveInto(item, c.save_as || fn.id, r.value, r.data);
    return { cost, note: r.status === 'done' ? String(r.value ?? 'done').slice(0, 200) : r.status === 'skipped' ? r.error : 'no result', ledger: r.calls };
  }
  if (node.type === 'agent') {
    const agent = ctx.agents.get(c.agent_id) || await getAgent(db, c.agent_id);
    const run = await runAgent(env, { ...deps, fetch: ctx.fetch }, agent, fillAll(c.inputs, item), { source: 'workflow', fetch_cap: 1e9 });
    if (run.status !== 'done') throw Object.assign(new Error(run.error || run.status), { cost: run.cost_micros, ledgered: true });
    const out = run.output || {};
    saveInto(item, c.save_as || 'agent', agent.fields.length ? out[agent.fields[0].name] : run.text, agent.fields.length ? out : {});
    return { cost: run.cost_micros, note: String(run.text || '').slice(0, 200), ledgered: true };
  }
  if (node.type === 'http') {
    const out = await EXECUTORS.http.run({ config: c }, item, { fetch: ctx.fetch, secret: ctx.secret, cols: [] });
    const cost = (out.calls || []).reduce((a, x) => a + (x.cost || 0), 0);
    if (out.status === 'error') throw Object.assign(new Error(out.error), { cost });
    saveInto(item, c.save_as || 'http', out.value, out.result && typeof out.result === 'object' && !Array.isArray(out.result) ? out.result : {});
    return { cost, note: String(out.value ?? out.status).slice(0, 200), ledger: out.calls };
  }
  if (node.type === 'add_row') {
    const cols = await loadColumns(db, c.table_id);
    const values = fillAll(c.values, item);
    const keys = new Set(cols.map((x) => x.key));
    const row = Object.fromEntries(Object.entries(values).filter(([k]) => keys.has(k)));
    await insertRows(db, c.table_id, [row], cols);
    await hooks.afterWrite(db, c.table_id, { newRows: true });
    return { note: `added a row to table ${c.table_id}` };
  }
  if (node.type === 'upsert') {
    const r = await upsertRecords(db, c.kind, [fillAll(c.values, item)], `Workflow ${ctx.wf.name}`.slice(0, 120));
    return { note: r.added ? `added to ${c.kind}` : r.updated ? `updated in ${c.kind}` : 'skipped: not enough to identify it' };
  }
  throw new Error(`Unknown step ${node.type}`);
}

/**
 * Drain: claim queued runs (and waiting runs whose time has come) and work through them.
 * Returns {claimed, done, waiting, error, paused, remaining}.
 */
export async function processWorkflows(env, deps = {}) {
  const db = env.DB;
  const now = deps.now || new Date();
  const ts = now.toISOString();
  const report = { claimed: 0, done: 0, waiting: 0, error: 0, paused: 0, over_budget: 0, remaining: 0 };
  await db.prepare(`UPDATE workflow_runs SET status='queued', claim=NULL WHERE status='running' AND claimed_at < ?1`)
    .bind(new Date(now.getTime() - STALE_MIN * 60000).toISOString()).run();
  const claim = crypto.randomUUID();
  await db.prepare(`UPDATE workflow_runs SET status='running', claim=?1, claimed_at=?2 WHERE id IN (
      SELECT id FROM workflow_runs WHERE status='queued' OR (status='waiting' AND resume_at <= ?2) ORDER BY id LIMIT 10) AND status IN ('queued','waiting')`).bind(claim, ts).run();
  const { results: runs } = await db.prepare(`SELECT r.*, w.graph, w.name FROM workflow_runs r JOIN workflows w ON w.id=r.workflow_id WHERE r.claim=?1 ORDER BY r.id`).bind(claim).all();
  report.claimed = runs.length;
  if (!runs.length) { report.remaining = await wfRemaining(db, ts); return report; }

  let fetches = 0;
  const base = deps.fetch || globalThis.fetch;
  const fetch = (...a) => { fetches++; return base(...a); };
  const settings = await getSettings(db);
  const overrides = settings.cost_overrides || {};
  const budget = settings.default_budget_micros ?? 1_000_000;
  const agents = new Map();

  for (const r of runs) {
    const graph = parseJson(r.graph, DEFAULT_GRAPH);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const item = parseJson(r.item, {});
    const queue = parseJson(r.queue, []);
    const log = parseJson(r.log, []);
    let cost = r.cost_micros || 0; let status = 'done'; let error = null; let resumeAt = null;
    const ledger = [];
    const ctx = { fetch, secret: (n) => secretValue(env, n), overrides, now, agents, wf: { id: r.workflow_id, name: r.name } };
    try {
      while (queue.length) {
        if (log.length >= MAX_STEPS_PER_RUN) throw new Error(`Stopped after ${MAX_STEPS_PER_RUN} steps. Check the arrows for a loop.`);
        const node = byId.get(queue[0]);
        if (!node) { queue.shift(); continue; }
        const est = await estimateNode(db, node, overrides, agents);
        if (fetches + est.fetches > FETCH_CAP) throw new Pause();
        if (cost + est.micros > budget) { status = 'over_budget'; throw new Error(`Stopped: the next step could cost up to $${(est.micros / 1e6).toFixed(4)} and this run has $${((budget - cost) / 1e6).toFixed(4)} of its budget left.`); }
        queue.shift();
        const t = Date.now();
        let res;
        try { res = await runNode(env, deps, node, item, ctx); }
        catch (e) {
          cost += e.cost || 0;
          log.push({ node: node.id, type: node.type, ok: false, ms: Date.now() - t, cost: e.cost || 0, note: String(e.message).slice(0, 300) });
          throw e;
        }
        cost += res.cost || 0;
        if (!res.ledgered && res.ledger) ledger.push(...res.ledger.filter((x) => x.cost));
        log.push({ node: node.id, type: node.type, ok: true, ms: Date.now() - t, cost: res.cost || 0, note: res.note || '' });
        if (res.delay) {
          queue.unshift(...next(graph, node.id, 'out'));
          resumeAt = new Date(now.getTime() + res.delay * 60000).toISOString();
          status = 'waiting';
          break;
        }
        queue.unshift(...next(graph, node.id, res.port || 'out'));
      }
    } catch (e) {
      if (e instanceof Pause) status = 'queued';
      else { if (status !== 'over_budget') status = 'error'; error = String(e.message || e).slice(0, 500); }
    }
    report[status === 'queued' ? 'paused' : status] = (report[status === 'queued' ? 'paused' : status] || 0) + 1;
    const stmts = [db.prepare(`UPDATE workflow_runs SET status=?2, claim=NULL, item=?3, queue=?4, log=?5, cost_micros=?6, error=?7, resume_at=?8, finished_at=?9 WHERE id=?1`)
      .bind(r.id, status, JSON.stringify(item).slice(0, 100_000), JSON.stringify(queue), JSON.stringify(log).slice(0, 100_000), cost, error, resumeAt,
        ['done', 'error', 'over_budget'].includes(status) ? nowIso() : null)];
    if (ledger.length) {
      stmts.push(db.prepare(`INSERT INTO ledger (ts, provider, cost_micros, outcome, note) SELECT ?1, json_extract(value,'$.provider'), json_extract(value,'$.cost'), json_extract(value,'$.outcome'), ?2 FROM json_each(?3)`)
        .bind(nowIso(), `workflow ${r.workflow_id} run ${r.id}`, JSON.stringify(ledger)));
    }
    await db.batch(stmts);
  }
  report.remaining = await wfRemaining(db, ts);
  return report;
}

const wfRemaining = async (db, ts) => (await db.prepare(`SELECT count(*) AS n FROM workflow_runs WHERE status IN ('queued','running') OR (status='waiting' AND resume_at <= ?1)`).bind(ts).first()).n;
