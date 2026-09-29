/**
 * Free Clay's MCP server (LOAM-PLAN.md phase 10; Clay's MCP page, teardown-v2 5.4): POST /mcp with a
 * Bearer API token, JSON-RPC 2.0, answered as plain JSON (Streamable HTTP allows a JSON answer).
 *
 * VERSIONS. The 2026-07-28 spec made Streamable HTTP stateless: no initialize handshake, no
 * Mcp-Session-Id, every request carries its protocol version, plus Mcp-Method and Mcp-Name headers
 * (blog.modelcontextprotocol.io/posts/2026-07-28, read 2026-09-28; references/loam-sources.md).
 * Clients on older versions still send initialize first, so both work here: initialize is answered
 * (with the client's version when we know it), server/discover is answered, and any request works
 * without either. Nothing is kept between requests, which is what a Worker wants.
 *
 * TOOLS read and write the same data as the app, through the same functions, so every limit and
 * check applies (budgets on runs, the row cap, the Audiences merge rules). Paid work only happens
 * through tools that say so and take a budget.
 */

import { parseJson } from './util.js';
import { HttpError } from './util.js';
import { catalog } from './functions/index.js';
import { createTable, createColumn, loadColumns, createRows, tableJson } from './tables.js';
import { mapHeaders } from './csv.js';
import { enqueueRun, processBatch } from './runner.js';
import { listRecords, upsertRecords } from './audiences.js';
import { listAgents, getAgent, runAgent } from './agents.js';
import { listWorkflows, runNow, processWorkflows } from './workflows.js';
import { listEvents, listSignals } from './signals.js';
import { wikidataCompanies, secCompanies } from './opendata/companies.js';
import { jobSearch } from './opendata/jobs.js';
import { geocode } from './opendata/osm.js';
import { searchOpenPlaces, checkOpenArea, parseTile, TILE_ROOT, OPEN_CATEGORIES } from '../public/js/open-places.js';
import { spendReport } from './spend.js';
import { peopleSearch } from './people.js';

export const SERVER_INFO = { name: 'free-clay', title: 'Free Clay', version: '1.0.0' };
export const PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];
const INSTRUCTIONS = 'Free Clay is a lead-research workspace: tables with enrichment columns, People and Companies databases, agents, workflows and signals. Prefer free tools. Tools that spend money say so and take a budget_usd.';

const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const int = (d) => ({ type: 'integer', description: d });
const s = (d) => ({ type: 'string', description: d });
const ro = { readOnlyHint: true, openWorldHint: false };
const MCP_TILE_CAP = 12;

/** name -> {title, description, inputSchema, annotations, run(args, env, deps)} */
export const TOOLS = {
  list_tables: { title: 'List tables', description: 'Every table with its row and column counts.', inputSchema: obj({}), annotations: ro,
    async run(a, env) {
      const { results } = await env.DB.prepare(`SELECT t.id, t.name, (SELECT count(*) FROM rows r WHERE r.table_id=t.id) AS rows,
        (SELECT count(*) FROM columns c WHERE c.table_id=t.id) AS columns FROM tables t WHERE t.deleted_at IS NULL ORDER BY t.id`).all();
      return results;
    } },
  get_rows: { title: 'Read rows', description: 'Columns and rows of a table (values keyed by column name). Up to 200 rows per call.',
    inputSchema: obj({ table_id: int('Table id'), limit: int('Rows, 1-200 (default 50)'), offset: int('Skip this many rows') }, ['table_id']), annotations: ro,
    async run(a, env) {
      const t = JSON.parse(await tableJson(env.DB, a.table_id));
      const lim = Math.min(200, Math.max(1, a.limit || 50)); const off = Math.max(0, a.offset || 0);
      const cols = t.columns.map((c) => ({ id: c.id, key: c.key, name: c.name, kind: c.kind, type: c.type }));
      return { table: t.table, columns: cols, total: t.rows.length,
        rows: t.rows.slice(off, off + lim).map((r) => ({ id: r.id, ...Object.fromEntries(cols.map((c) => [c.name, r.data[c.key] ?? null])) })) };
    } },
  create_table: { title: 'Create a table', description: 'A new table with named columns (types: text, number, currency, date, url, email, checkbox, select).',
    inputSchema: obj({ name: s('Table name'), columns: { type: 'array', items: obj({ name: s('Column name'), type: s('Column type') }, ['name']) } }, ['name']),
    async run(a, env) {
      const t = await createTable(env.DB, { name: a.name });
      const existing = await loadColumns(env.DB, t.id);
      for (const [i, c] of (a.columns || []).slice(0, 50).entries()) {
        if (i === 0 && existing[0]) { await env.DB.prepare('UPDATE columns SET name=?2 WHERE id=?1').bind(existing[0].id, String(c.name).slice(0, 80)).run(); continue; }
        await createColumn(env.DB, t.id, { name: c.name, type: c.type || 'text' });
      }
      return { id: t.id, name: t.name, columns: (await loadColumns(env.DB, t.id)).map((c) => ({ id: c.id, key: c.key, name: c.name, type: c.type })) };
    } },
  add_rows: { title: 'Add rows', description: 'Add up to 500 rows. Each row is an object keyed by column name (or key); unknown names are ignored.',
    inputSchema: obj({ table_id: int('Table id'), rows: { type: 'array', items: { type: 'object' } } }, ['table_id', 'rows']),
    async run(a, env) {
      const cols = await loadColumns(env.DB, a.table_id);
      const rows = (a.rows || []).slice(0, 500).map((r) => {
        const names = Object.keys(r || {});
        const keys = mapHeaders(names, cols);
        return Object.fromEntries(names.map((n, i) => [keys[i], r[n]]).filter(([k]) => k));
      });
      const out = await createRows(env.DB, a.table_id, { rows });
      return { added: out.added };
    } },
  list_functions: { title: 'List enrichment functions', description: 'Every enrichment a column can run: id, inputs, outputs, cost per row and the key it needs.', inputSchema: obj({}), annotations: ro,
    async run() { return catalog().map((f) => ({ id: f.id, name: f.name, inputs: f.inputs.map((i) => i.key), outputs: f.outputs.map((o) => o.key), cost_usd_per_row: f.costMicros / 1e6, needs_key: f.secret })); } },
  add_enrichment_column: { title: 'Add an enrichment column', description: 'A column that runs one function per row. inputs maps each function input to a template like "{{website}}" (column keys from get_rows). Nothing runs until run_column.',
    inputSchema: obj({ table_id: int('Table id'), name: s('Column name'), fn: s('Function id from list_functions'), inputs: { type: 'object' } }, ['table_id', 'fn', 'inputs']),
    async run(a, env) { const c = await createColumn(env.DB, a.table_id, { name: a.name || a.fn, kind: 'enrich', config: { fn: a.fn, inputs: a.inputs } }); return { id: c.id, key: c.key, name: c.name }; } },
  run_column: { title: 'Run a column', description: 'Queue a computed column to run on a table\'s rows (scope: empty, all or errored). Spends up to budget_usd; free functions cost 0. The queue keeps draining after this returns.',
    inputSchema: obj({ table_id: int('Table id'), column_id: int('Column id'), scope: { type: 'string', enum: ['empty', 'all', 'errored'] }, budget_usd: { type: 'number', description: 'Most this run may spend (default: your setting)' } }, ['table_id', 'column_id']),
    annotations: { openWorldHint: true },
    async run(a, env, deps) {
      const body = { column_id: a.column_id, scope: a.scope || 'empty' };
      if (Number.isFinite(a.budget_usd)) body.budget_micros = Math.max(0, Math.round(a.budget_usd * 1e6));
      const q = await enqueueRun(env.DB, a.table_id, body);
      const first = q.queued ? await processBatch(env, deps) : null;
      return { ...q, first_batch: first };
    } },
  search_people: { title: 'Search People', description: 'Search the People database by any text; returns up to 50.', inputSchema: obj({ query: s('Text to find'), limit: int('1-50') }), annotations: ro,
    async run(a, env) { const r = await listRecords(env.DB, 'people', { q: a.query || '', limit: Math.min(50, a.limit || 20) }); return { total: r.total, records: r.records.map((x) => ({ id: x.id, ...x.data })) }; } },
  search_companies: { title: 'Search Companies', description: 'Search the Companies database by any text; returns up to 50.', inputSchema: obj({ query: s('Text to find'), limit: int('1-50') }), annotations: ro,
    async run(a, env) { const r = await listRecords(env.DB, 'companies', { q: a.query || '', limit: Math.min(50, a.limit || 20) }); return { total: r.total, records: r.records.map((x) => ({ id: x.id, ...x.data })) }; } },
  save_people: { title: 'Save People', description: 'Add or update people (fields: full_name, first_name, last_name, email, phone, title, company, domain, city, state, country, notes). Same email = same person; blanks get filled, existing values stay.',
    inputSchema: obj({ records: { type: 'array', items: { type: 'object' } } }, ['records']),
    async run(a, env) { return upsertRecords(env.DB, 'people', (a.records || []).slice(0, 1000), 'MCP'); } },
  save_companies: { title: 'Save Companies', description: 'Add or update companies (fields: name, domain, website, phone, email, industry, employees, founded, description, address, city, state, country). Same domain = same company.',
    inputSchema: obj({ records: { type: 'array', items: { type: 'object' } } }, ['records']),
    async run(a, env) { return upsertRecords(env.DB, 'companies', (a.records || []).slice(0, 1000), 'MCP'); } },
  find_local_businesses: { title: 'Find local businesses', description: `Local US businesses near a place from free open data (Overture Maps). category is one of: ${Object.keys(OPEN_CATEGORIES).join(', ')}. radius_km up to 5 here.`,
    inputSchema: obj({ place: s('Town or address, like "Gainesville, FL"'), category: s('Category id'), radius_km: { type: 'number' } }, ['place', 'category']), annotations: { readOnlyHint: true, openWorldHint: true },
    async run(a, env, deps) {
      const g = await geocode(env.DB, deps, a.place);
      const area = checkOpenArea({ lat: g.lat, lon: g.lon, radius_m: Math.round(Math.min(5, Math.max(0.1, a.radius_km || 3)) * 1000), category: a.category });
      const origin = deps.origin || 'https://free-clay.local';
      const get = async (path) => { const r = await env.ASSETS.fetch(new Request(origin + path)); if (!r.ok) throw new Error('The open-data tiles are not deployed (run node dev/get-places.mjs, then deploy)'); return r.text(); };
      const index = JSON.parse(await get(`${TILE_ROOT}/index.json`));
      let n = 0;
      const { results } = await searchOpenPlaces(area, index, async (name) => { if (++n > MCP_TILE_CAP) throw new Error('That area is too dense for one call. Use a smaller radius_km.'); return parseTile(await get(`${TILE_ROOT}/${name}.json`)); });
      return { place: g.name || a.place, count: results.length, results: results.slice(0, 100).map(({ name, phone, website, email, address, category }) => ({ name, phone, website, email, address, category })) };
    } },
  find_people: { title: 'Find people (treg)', description: 'People by job title, company domain, location or keywords, through treg (your TREG_TOKEN). Paid: capped at max_usd (default $0.10) and cached 7 days. Business data only.',
    inputSchema: obj({ title: s('Job title, like "owner" or "head of marketing"'), company_domain: s('Company domain'), location: s('City, state or country'), keywords: { type: 'array', items: { type: 'string' } }, limit: int('1-50'), max_usd: { type: 'number' } }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(a, env, deps) { const r = await peopleSearch(env, deps, a); return { count: r.results.length, cost_usd: r.cost_micros / 1e6, cached: r.cached, results: r.results }; } },
  find_companies: { title: 'Find companies', description: 'Companies from open data: source "wikidata" (industry word, optional US state code) or "sec" (name or ticker of a public company).',
    inputSchema: obj({ source: { type: 'string', enum: ['wikidata', 'sec'] }, industry: s('Wikidata: an industry word, like roofing'), state: s('Wikidata: US state code, like FL'), q: s('SEC: name or ticker') }, ['source']),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(a, env, deps) {
      const r = a.source === 'sec' ? await secCompanies(env.DB, deps, { q: a.q }) : await wikidataCompanies(env.DB, deps, { industry: a.industry, state: a.state });
      return { count: r.results.length, results: r.results.slice(0, 100) };
    } },
  find_jobs: { title: 'Find open roles', description: 'Open roles from public Greenhouse, Lever and Ashby boards, for up to 10 companies (board names or domains), optional keyword.',
    inputSchema: obj({ companies: { type: 'array', items: { type: 'string' } }, keyword: s('Only roles containing this word') }, ['companies']), annotations: { readOnlyHint: true, openWorldHint: true },
    async run(a, env, deps) { const r = await jobSearch(env.DB, deps, a); return { boards: r.boards, count: r.results.length, results: r.results.slice(0, 200) }; } },
  list_agents: { title: 'List agents', description: 'Saved agents with their inputs and output fields.', inputSchema: obj({}), annotations: ro,
    async run(a, env) { return (await listAgents(env.DB)).map((x) => ({ id: x.id, name: x.name, inputs: x.inputs, fields: x.fields.map((f) => f.name), model: `${x.provider}/${x.model}`, budget_usd: x.budget_micros / 1e6 })); } },
  run_agent: { title: 'Run an agent', description: 'Run a saved agent once on inputs, like {"domain": "example.com"}. Spends up to the agent\'s budget on your AI key (0 on Groq\'s free tier).',
    inputSchema: obj({ agent_id: int('Agent id'), input: { type: 'object' } }, ['agent_id']), annotations: { openWorldHint: true },
    async run(a, env, deps) { const ag = await getAgent(env.DB, a.agent_id); const r = await runAgent(env, deps, ag, a.input || {}, { source: 'mcp', fetch_cap: 30 }); return { status: r.status, output: r.output, text: r.text, cost_usd: r.cost_micros / 1e6, error: r.error, steps: r.steps.length }; } },
  list_workflows: { title: 'List workflows', description: 'Workflows with their status and run counts.', inputSchema: obj({}), annotations: ro,
    async run(a, env) { return (await listWorkflows(env.DB)).map((w) => ({ id: w.id, name: w.name, status: w.status, trigger: w.graph.nodes.find((n) => n.type === 'trigger')?.config.type, runs: w.runs, errors: w.errors })); } },
  run_workflow: { title: 'Run a workflow', description: 'Start a workflow on one item (an object of values) or on a table\'s rows. Runs inside your budget setting.',
    inputSchema: obj({ workflow_id: int('Workflow id'), item: { type: 'object' }, table_id: int('Run once per row of this table instead') }, ['workflow_id']), annotations: { openWorldHint: true },
    async run(a, env, deps) { const q = await runNow(env.DB, a.workflow_id, a.table_id ? { table_id: a.table_id } : { item: a.item || {} }); return { ...q, first_drain: await processWorkflows(env, deps) }; } },
  signal_events: { title: 'Signal events', description: 'Recent events from your signals (new jobs, website changes, news, SEC filings).',
    inputSchema: obj({ signal_id: int('Only this signal'), limit: int('Up to 200') }), annotations: ro,
    async run(a, env) { return { signals: (await listSignals(env.DB)).map((x) => ({ id: x.id, name: x.name, type: x.type, status: x.status })), events: await listEvents(env.DB, { signal_id: a.signal_id, limit: Math.min(200, a.limit || 50) }) }; } },
  spend: { title: 'Spend this month', description: 'What paid providers have cost this month, by provider and by table.', inputSchema: obj({}), annotations: ro,
    async run(a, env) { return spendReport(env.DB); } },
};

export const toolList = () => Object.entries(TOOLS).map(([name, t]) => ({ name, title: t.title, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) }));

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

/** One JSON-RPC message. Returns the response object, or null for a notification. */
export async function handleRpc(msg, env, deps) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request');
  const { id, method, params = {} } = msg;
  if (id === undefined) return null;   // notifications (initialized, cancelled): nothing to answer
  const info = { protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
    capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
  if (method === 'initialize' || method === 'server/discover') return ok(id, info);
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: toolList() });
  if (method === 'tools/call') {
    const tool = TOOLS[params.name];
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(params.name).slice(0, 60)}`);
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    for (const k of tool.inputSchema.required || []) if (args[k] === undefined) return ok(id, { content: [{ type: 'text', text: `Missing argument: ${k}` }], isError: true });
    try {
      const result = await tool.run(args, env, deps);
      const text = JSON.stringify(result, null, 1);
      return ok(id, { content: [{ type: 'text', text: text.length > 200_000 ? text.slice(0, 200_000) + '\n…(cut)' : text }],
        ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result } : {}) });
    } catch (e) {
      // Tool failures go back to the model as a result it can read, not as a protocol error.
      const m = e instanceof HttpError ? e.message : /no such (table|column)/i.test(String(e?.message)) ? 'The database is missing an update. Run the migrations.' : String(e?.message || e);
      return ok(id, { content: [{ type: 'text', text: `Error: ${m.slice(0, 500)}` }], isError: true });
    }
  }
  if (method === 'resources/list') return ok(id, { resources: [] });
  if (method === 'prompts/list') return ok(id, { prompts: [] });
  return rpcError(id, -32601, `Method not found: ${method.slice(0, 60)}`);
}

/** POST /mcp. Auth is checked by the caller (a Bearer API token). */
export async function handleMcp(request, env, deps) {
  const headers = { 'content-type': 'application/json' };
  if (request.method === 'GET') return new Response(JSON.stringify({ error: 'This server answers POST only (no event stream).' }), { status: 405, headers: { ...headers, allow: 'POST' } });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const text = await request.text();
  if (text.length > 2_000_000) return new Response(JSON.stringify(rpcError(null, -32600, 'Request too large')), { status: 413, headers });
  const body = parseJson(text, undefined);
  if (body === undefined) return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error')), { status: 400, headers });
  const d = { ...deps, origin: new URL(request.url).origin };
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map((m) => handleRpc(m, env, d)))).filter(Boolean);
    return out.length ? new Response(JSON.stringify(out), { headers }) : new Response(null, { status: 202 });
  }
  const out = await handleRpc(body, env, d);
  return out ? new Response(JSON.stringify(out), { headers }) : new Response(null, { status: 202 });
}
