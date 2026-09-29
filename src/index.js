/**
 * free-clay: one Cloudflare Worker + one D1 database. $0/month on Cloudflare's free plan; you pay
 * only the providers whose keys you plug in.
 *
 * The Worker answers /api/* itself; every other path is the app in /public (a single-page app, so
 * unknown paths fall back to index.html, see wrangler.toml). A cron drains the run queue once a
 * minute (scheduled() below), and the open table drains it faster through /api/run-batch.
 */

import { json, readJson, fail, HttpError, nowIso, intId } from './util.js';
import { sameText, makeSession, validSession, readCookie, sessionCookie, CLEAR_COOKIE } from './auth.js';
import { bootstrap, patchSettings, addSecret, removeSecret } from './meta.js';
import {
  tableJson, createTable, patchTable, deleteTable, createColumn, patchColumn, deleteColumn, reorderColumns,
  createRows, patchRow, deleteRows, importCsv, createView, patchView, deleteView, dedupeTable, patchRows, duplicateColumn,
} from './tables.js';
import { enqueueRun, stopRun, processBatch, changesSince } from './runner.js';
import { catalog } from './functions/index.js';
import { addOutputColumn } from './outputs.js';
import { placesSource } from './sources.js';
import { setWebhook, getWebhook, receiveHook } from './webhooks.js';
import { tableCosts, spendReport } from './spend.js';
import { createSample } from './sample.js';
import { planTable, buildPlan, draftFormula } from './assist.js';
import { runProbe } from './opendata/probe.js';
import { geocode, localBusinesses, nominatimBusinesses, LOCAL_CATEGORIES } from './opendata/osm.js';
import { importLocal, googleLocal, openBusinesses, importCompanies, importJobs, localToCompanies, companiesToAudience, importPeople } from './find.js';
import { wikidataCompanies, secCompanies, secDetails, US_STATES } from './opendata/companies.js';
import { jobSearch } from './opendata/jobs.js';
import { sweepCache } from './opendata/cache.js';
import { createFolder, patchFolder, deleteFolder, listTrash, restoreTable, purgeTable, purgeExpired } from './files.js';
import {
  listRecords, getRecord, patchRecord, deleteRecords, upsertRecords, audienceStats, listSegments, createSegment, patchSegment,
  deleteSegment, fromTable, toTable, importAudienceCsv, checkKind,
} from './audiences.js';
import { listAgents, getAgent, createAgent, patchAgent, deleteAgent, listAgentRuns, runAgent, pruneAgentRuns, AGENT_PROVIDERS, AGENT_TOOLS } from './agents.js';
import {
  listWorkflows, getWorkflow, createWorkflow, patchWorkflow, deleteWorkflow, listRuns, runNow, processWorkflows, fireTriggers, webhookUrl,
  receiveWorkflowHook, TRIGGERS, NODE_TYPES,
} from './workflows.js';
import { listSignals, getSignal, createSignal, patchSignal, deleteSignal, listEvents, checkSignalNow, checkDueSignals, SIGNAL_TYPES } from './signals.js';
import { listTokens, createToken, revokeToken, tokenFrom } from './tokens.js';
import { handleMcp, toolList } from './mcp.js';
import { lookalikes } from './lookalikes.js';
import { peopleSearch, peopleToAudience } from './people.js';
import { exportAndRecord, listExports, downloadExport, deleteExport, purgeExports } from './exports.js';
import './auto.js';
import './kinds/enrich.js';
import './kinds/waterfall.js';
import './kinds/formula.js';
import './kinds/ai.js';
import './kinds/http.js';

export { makeSession, validSession } from './auth.js';

const MAX_FAILURES = 10;            // wrong passwords per IP ...
const FAILURE_WINDOW_MIN = 15;      // ... per 15 minutes, then a cool-down

async function login(request, env, url) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const since = new Date(Date.now() - FAILURE_WINDOW_MIN * 60000).toISOString();
  const recent = await env.DB.prepare('SELECT count(*) AS n FROM login_failures WHERE ip=?1 AND at>?2').bind(ip, since).first();
  if ((recent?.n || 0) >= MAX_FAILURES) return json({ error: `Too many attempts. Try again in ${FAILURE_WINDOW_MIN} minutes.` }, 429);
  const { password } = await readJson(request);
  if (!sameText(password || '', env.APP_PASSWORD)) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO login_failures (ip, at) VALUES (?1, ?2)').bind(ip, nowIso()),
      env.DB.prepare('DELETE FROM login_failures WHERE at < ?1').bind(since),
    ]);
    return json({ error: 'Wrong password' }, 401);
  }
  return json({ ok: true }, 200, { 'set-cookie': sessionCookie(await makeSession(env.APP_PASSWORD), url.protocol === 'https:') });
}

async function route(request, env, url, deps) {
  const db = env.DB;
  const m = request.method;
  const [a, b, c, d] = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const body = () => readJson(request);

  if (a === 'bootstrap' && m === 'GET') return json(await bootstrap(db, env));
  if (a === 'settings' && m === 'PATCH') return json(await patchSettings(db, await body()));
  if (a === 'secrets' && !b && m === 'POST') return json(await addSecret(db, await body()), 201);
  if (a === 'secrets' && b && m === 'DELETE') return json(await removeSecret(db, b));

  if (a === 'functions' && m === 'GET') return json(catalog());
  if (a === 'spend' && m === 'GET') return json(await spendReport(db));
  if (a === 'admin' && b === 'probe' && m === 'POST') return json(await runProbe(env, deps));
  if (a === 'find' && b === 'categories' && m === 'GET') return json(Object.entries(LOCAL_CATEGORIES).map(([id, [label, tag]]) => ({ id, label, tag })));
  if (a === 'find' && b === 'geocode' && m === 'POST') return json(await geocode(db, deps, (await body()).q));
  if (a === 'find' && b === 'local' && !c && m === 'POST') return json(await localBusinesses(db, deps, await body()));
  if (a === 'find' && b === 'local' && c === 'google' && m === 'POST') return json(await googleLocal(env, { ...deps }, await body()));
  if (a === 'find' && b === 'companies' && c === 'wikidata' && m === 'POST') return json(await wikidataCompanies(db, deps, await body()));
  if (a === 'find' && b === 'companies' && c === 'sec' && m === 'POST') return json(await secCompanies(db, deps, await body()));
  if (a === 'find' && b === 'companies' && c === 'sec-details' && m === 'POST') return json(await secDetails(db, deps, await body()));
  if (a === 'find' && b === 'companies' && c === 'import' && m === 'POST') return json(await importCompanies(db, deps, await body()), 201);
  if (a === 'find' && b === 'companies' && c === 'states' && m === 'GET') return json(US_STATES);
  if (a === 'find' && b === 'people' && !c && m === 'POST') return json(await peopleSearch(env, deps, await body()));
  if (a === 'find' && b === 'people' && c === 'import' && m === 'POST') return json(await importPeople(db, deps, await body()), 201);
  if (a === 'find' && b === 'people' && c === 'to-people' && m === 'POST') return json(await peopleToAudience(db, deps, await body()));
  if (a === 'find' && b === 'lookalikes' && m === 'POST') return json(await lookalikes(env, deps, await body()));
  if (a === 'find' && b === 'jobs' && !c && m === 'POST') return json(await jobSearch(db, deps, await body()));
  if (a === 'find' && b === 'jobs' && c === 'import' && m === 'POST') return json(await importJobs(db, deps, await body()), 201);
  if (a === 'find' && b === 'local' && c === 'open' && m === 'POST') return json(await openBusinesses(db, deps, await body()));
  if (a === 'find' && b === 'local' && c === 'nominatim' && m === 'POST') return json(await nominatimBusinesses(db, deps, await body()));
  if (a === 'find' && b === 'local' && c === 'to-companies' && m === 'POST') return json(await localToCompanies(db, deps, await body()));
  if (a === 'find' && b === 'companies' && c === 'to-companies' && m === 'POST') return json(await companiesToAudience(db, deps, await body()));
  if (a === 'find' && b === 'local' && c === 'import' && m === 'POST') return json(await importLocal(db, deps, await body()), 201);
  if (a === 'assist' && b === 'plan' && m === 'POST') return json(await planTable(env, await body(), deps));
  if (a === 'assist' && b === 'formula' && m === 'POST') return json(await draftFormula(env, await body(), deps));
  if (a === 'assist' && b === 'build' && m === 'POST') return json(await buildPlan(db, await body()), 201);
  if (a === 'run-batch' && m === 'POST') return json(await processBatch(env, deps));
  if (a === 'runs' && b && c === 'stop' && m === 'POST') return json(await stopRun(db, intId(b)));

  if (a === 'audiences') {
    if (b === 'stats' && m === 'GET') return json(await audienceStats(db));
    const kind = checkKind(b);
    if (!c && m === 'GET') {
      const p = url.searchParams;
      const num = (k) => (p.get(k) !== null && p.get(k) !== '' ? Number(p.get(k)) : undefined);
      let filters;
      try { filters = p.get('filters') ? JSON.parse(p.get('filters')) : undefined; } catch { fail(400, 'filters must be JSON'); }
      return json(await listRecords(db, kind, { q: p.get('q') || '', filters, segment_id: num('segment'), sort: p.get('sort'), dir: p.get('dir'), limit: num('limit'), offset: num('offset') }));
    }
    if (c === 'query' && m === 'POST') return json(await listRecords(db, kind, await body()));
    if (c === 'upsert' && m === 'POST') { const x = await body(); return json(await upsertRecords(db, kind, x.records, x.source || 'API', { overwrite: !!x.overwrite })); }
    if (c === 'from-table' && m === 'POST') return json(await fromTable(db, kind, await body()));
    if (c === 'to-table' && m === 'POST') return json(await toTable(db, kind, await body()), 201);
    if (c === 'delete' && m === 'POST') return json(await deleteRecords(db, kind, await body()));
    if (c === 'import' && m === 'POST') {
      const text = await request.text();
      if (text.length > 10_000_000) fail(413, 'That file is over 10 MB');
      return json(await importAudienceCsv(db, kind, text, url.searchParams.get('name') || 'CSV'));
    }
    if (c && !d && m === 'GET') return json(await getRecord(db, kind, intId(c)));
    if (c && !d && m === 'PATCH') return json(await patchRecord(db, kind, intId(c), await body()));
  }
  if (a === 'agents') {
    if (b === 'meta' && m === 'GET') return json({ providers: AGENT_PROVIDERS, tools: Object.fromEntries(Object.entries(AGENT_TOOLS).map(([k, t]) => [k, { label: t.label, secret: t.secret || null }])) });
    if (!b && m === 'GET') return json(await listAgents(db));
    if (!b && m === 'POST') return json(await createAgent(db, await body()), 201);
    const id = b && intId(b);
    if (id && !c && m === 'GET') return json(await getAgent(db, id));
    if (id && !c && m === 'PATCH') return json(await patchAgent(db, id, await body()));
    if (id && !c && m === 'DELETE') return json(await deleteAgent(db, id));
    if (id && c === 'runs' && m === 'GET') return json(await listAgentRuns(db, id));
    if (id && c === 'run' && m === 'POST') { const x = await body(); return json(await runAgent(env, deps, await getAgent(db, id), x.input || {}, { source: 'test' })); }
  }
  if (a === 'workflows') {
    if (b === 'meta' && m === 'GET') return json({ triggers: TRIGGERS, nodes: NODE_TYPES });
    if (b === 'drain' && m === 'POST') return json(await processWorkflows(env, deps));
    if (!b && m === 'GET') return json(await listWorkflows(db));
    if (!b && m === 'POST') return json(await createWorkflow(db, await body()), 201);
    const id = b && intId(b);
    if (id && !c && m === 'GET') return json(await getWorkflow(db, id));
    if (id && !c && m === 'PATCH') return json(await patchWorkflow(db, id, await body()));
    if (id && !c && m === 'DELETE') return json(await deleteWorkflow(db, id));
    if (id && c === 'runs' && m === 'GET') return json(await listRuns(db, id));
    if (id && c === 'run' && m === 'POST') return json(await runNow(db, id, await body()), 201);
    if (id && c === 'webhook' && m === 'POST') return json(await webhookUrl(db, id, url.origin, !!(await body()).rotate));
  }
  if (a === 'signals') {
    if (b === 'meta' && m === 'GET') return json(SIGNAL_TYPES);
    if (b === 'events' && m === 'GET') return json(await listEvents(db, { signal_id: Number(url.searchParams.get('signal')) || null, limit: Number(url.searchParams.get('limit')) || 100 }));
    if (!b && m === 'GET') return json(await listSignals(db));
    if (!b && m === 'POST') return json(await createSignal(db, await body()), 201);
    const id = b && intId(b);
    if (id && !c && m === 'GET') return json(await getSignal(db, id));
    if (id && !c && m === 'PATCH') return json(await patchSignal(db, id, await body()));
    if (id && !c && m === 'DELETE') return json(await deleteSignal(db, id));
    if (id && c === 'check' && m === 'POST') return json(await checkSignalNow(env, deps, id));
  }
  if (a === 'exports' && !b && m === 'GET') return json(await listExports(db));
  if (a === 'exports' && b && c === 'download' && m === 'GET') { const { csv, name } = await downloadExport(db, intId(b)); return csvResponse(csv, name); }
  if (a === 'exports' && b && !c && m === 'DELETE') return json(await deleteExport(db, intId(b)));
  if (a === 'mcp-tools' && m === 'GET') return json(toolList());
  if (a === 'tokens') {
    if (deps.viaToken) fail(403, 'API tokens cannot manage tokens. Use the app.');
    if (!b && m === 'GET') return json(await listTokens(db));
    if (!b && m === 'POST') return json(await createToken(db, await body()), 201);
    if (b && m === 'DELETE') return json(await revokeToken(db, intId(b)));
  }

  if (a === 'segments' && !b && m === 'GET') return json(await listSegments(db));
  if (a === 'segments' && !b && m === 'POST') return json(await createSegment(db, await body()), 201);
  if (a === 'segments' && b && m === 'PATCH') return json(await patchSegment(db, intId(b), await body()));
  if (a === 'segments' && b && m === 'DELETE') return json(await deleteSegment(db, intId(b)));

  if (a === 'folders' && !b && m === 'POST') return json(await createFolder(db, await body()), 201);
  if (a === 'folders' && b && !c && m === 'PATCH') return json(await patchFolder(db, intId(b), await body()));
  if (a === 'folders' && b && !c && m === 'DELETE') return json(await deleteFolder(db, intId(b)));
  if (a === 'trash' && !b && m === 'GET') return json(await listTrash(db));
  if (a === 'trash' && b && c === 'restore' && m === 'POST') return json(await restoreTable(db, intId(b)));
  if (a === 'trash' && b && !c && m === 'DELETE') return json(await purgeTable(db, intId(b)));

  if (a === 'tables') {
    if (!b && m === 'POST') return json(await createTable(db, await body()), 201);
    if (b === 'sample' && !c && m === 'POST') return json(await createSample(db), 201);
    const tid = b && intId(b, 'table id');
    if (tid && !c) {
      if (m === 'GET') return new Response(await tableJson(db, tid), { headers: { 'content-type': 'application/json' } });
      if (m === 'PATCH') return json(await patchTable(db, tid, await body()));
      if (m === 'DELETE') return json(await deleteTable(db, tid));
    }
    if (c === 'columns' && !d && m === 'POST') return json(await createColumn(db, tid, await body()), 201);
    if (c === 'columns' && d === 'order' && m === 'PUT') return json(await reorderColumns(db, tid, (await body()).ids));
    if (c === 'rows' && !d && m === 'POST') return json(await createRows(db, tid, await body()), 201);
    if (c === 'dedupe' && m === 'POST') return json(await dedupeTable(db, tid, await body()));
    if (c === 'rows' && d === 'bulk' && m === 'PATCH') return json(await patchRows(db, tid, await body()));
    if (c === 'rows' && d === 'delete' && m === 'POST') return json(await deleteRows(db, tid, await body()));
    if (c === 'source' && d === 'places' && m === 'POST') return json(await placesSource(env, tid, await body(), deps));
    if (c === 'costs' && m === 'GET') return json(await tableCosts(db, tid));
    if (c === 'webhook' && m === 'GET') return json(await getWebhook(db, tid));
    if (c === 'webhook' && m === 'POST') return json(await setWebhook(db, tid, await body()));
    if (c === 'run' && m === 'POST') return json(await enqueueRun(db, tid, await body()), 201);
    if (c === 'changes' && m === 'GET') return new Response(await changesSince(db, tid, url.searchParams.get('since')), { headers: { 'content-type': 'application/json' } });
    if (c === 'views' && m === 'POST') return json(await createView(db, tid, await body()), 201);
    if (c === 'import' && m === 'POST') {
      const text = await request.text();
      if (text.length > 10_000_000) fail(413, 'That file is over 10 MB');
      return json(await importCsv(db, tid, text));
    }
    if (c === 'export.csv' && m === 'GET') {
      const { csv, name } = await exportAndRecord(db, tid);
      return csvResponse(csv, name);
    }
  }
  if (a === 'columns' && b && c === 'duplicate' && m === 'POST') return json(await duplicateColumn(db, intId(b)), 201);
  if (a === 'columns' && b && c === 'outputs' && m === 'POST') return json(await addOutputColumn(db, intId(b), await body()), 201);
  if (a === 'columns' && b && !c) {
    if (m === 'PATCH') return json(await patchColumn(db, intId(b), await body()));
    if (m === 'DELETE') return json(await deleteColumn(db, intId(b)));
  }
  if (a === 'rows' && b && m === 'PATCH') return json(await patchRow(db, intId(b), await body()));
  if (a === 'views' && b) {
    if (m === 'PATCH') return json(await patchView(db, intId(b), await body()));
    if (m === 'DELETE') return json(await deleteView(db, intId(b)));
  }
  return json({ error: 'Not found' }, 404);
}

const csvResponse = (csv, name) => new Response(csv, { headers: {
  'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name.replace(/"/g, '')}"` } });

/** deps: {fetch, now}. Production passes nothing; the tests pass a fake fetch. */
export async function handle(request, env, ctx, deps = {}) {
  const url = new URL(request.url);
  // /mcp is both the MCP page (a browser asking for HTML) and the MCP server (everything else).
  if (url.pathname === '/mcp' && !(request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html'))) {
    // MCP clients (Claude, ChatGPT, Cursor) send an API token as a Bearer header.
    try {
      if (!(await tokenFrom(env.DB, request))) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Send an API token: Authorization: Bearer fc_... (make one on the MCP page)' } }, 401, { 'www-authenticate': 'Bearer' });
      return await handleMcp(request, env, deps);
    } catch (e) {
      if (/no such table/i.test(String(e?.message))) return json({ error: 'Run the migrations: npx wrangler d1 migrations apply free-clay --remote' }, 500);
      return json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e?.message || e).slice(0, 200) } }, 500);
    }
  }
  if (!url.pathname.startsWith('/api/')) {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  }
  if (!env.APP_PASSWORD) return json({ error: 'APP_PASSWORD is not set. Run: npx wrangler secret put APP_PASSWORD' }, 500);
  try {
    if (url.pathname === '/api/login' && request.method === 'POST') return await login(request, env, url);
    const hook = url.pathname.match(/^\/api\/hook\/(\d+)$/);
    if (hook && request.method === 'POST') return await receiveHook(request, env, Number(hook[1]));
    const wfHook = url.pathname.match(/^\/api\/wf\/(\d+)\/([A-Za-z0-9_-]{10,64})$/);
    if (wfHook && request.method === 'POST') return await receiveWorkflowHook(request, env, Number(wfHook[1]), wfHook[2]);
    if (url.pathname === '/api/logout' && request.method === 'POST') return json({ ok: true }, 200, { 'set-cookie': CLEAR_COOKIE });
    // The app signs in with the password cookie; the REST API, the CLI and scripts send a token.
    let viaToken = false;
    if (!(await validSession(env.APP_PASSWORD, readCookie(request, 'fc_session')))) {
      viaToken = !!(await tokenFrom(env.DB, request));
      if (!viaToken) return json({ error: 'Login required' }, 401);
    }
    if (url.pathname === '/api/me') return json({ ok: true });
    // /api/v1/... is the documented, versioned path for the same routes (public/openapi.json).
    const routed = url.pathname.startsWith('/api/v1/') ? new URL(url.href.replace('/api/v1/', '/api/')) : url;
    return await route(request, env, routed, { ...deps, viaToken });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    // A deploy without its database update: say exactly what to run instead of a raw SQL error.
    if (/no such (table|column)/i.test(String(e?.message))) return json({ error: 'The database is missing an update this version needs. In the free-clay folder run: npx wrangler d1 migrations apply free-clay --remote' }, 500);
    return json({ error: 'Server error: ' + String(e?.message || e).slice(0, 200) }, 500);
  }
}

/**
 * The cron, once a minute. The free plan allows 50 outbound requests per invocation, so the three
 * queues that fetch (table cells, workflow runs, signal checks) take turns: each minute starts
 * with a different one and moves on to the next only when that one had nothing to do. Clean-up
 * and trigger bookkeeping (no outbound requests) run every time.
 */
export async function scheduled(event, env, ctx, deps = {}) {
  const now = deps.now || new Date(event?.scheduledTime || Date.now());
  const d = { ...deps, now };
  const out = {};
  const safe = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = { error: String(e?.message || e).slice(0, 200) }; } return out[k]; };
  await safe('triggers', () => fireTriggers(env.DB, now));
  const queues = [
    ['cells', () => processBatch(env, d), (r) => r.claimed > 0],
    ['workflows', () => processWorkflows(env, d), (r) => r.claimed > 0],
    ['signals', () => checkDueSignals(env, d), (r) => r.checked > 0],
  ];
  const start = Math.floor(now.getTime() / 60000) % queues.length;
  for (let i = 0; i < queues.length; i++) {
    const [k, run, busy] = queues[(start + i) % queues.length];
    const r = await safe(k, run);
    if (r && !r.error && busy(r)) break;
  }
  await safe('trash', () => purgeExpired(env.DB, now.getTime()));
  await safe('cache', () => sweepCache(env.DB, now.getTime()));
  await safe('agent_runs', () => pruneAgentRuns(env.DB));
  await safe('exports', () => purgeExports(env.DB, now.getTime()));
  return out;
}

export default { fetch: handle, scheduled };
