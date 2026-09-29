import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch, html, dns } from './helpers.mjs';
import { handle, scheduled } from '../src/index.js';
import { parseRss, addedSentences } from '../src/signals.js';
import { flatItem } from '../src/workflows.js';

const G = (nodes, edges = []) => ({ nodes, edges });
const trig = (config = { type: 'manual' }) => ({ id: 'n1', type: 'trigger', config });

test('workflows: graphs are checked; a trigger is required; switching on needs every step set up', async () => {
  const env = fakeEnv(); const api = await client(env);
  const wf = (await api.post('/api/workflows', { name: 'Test' })).body;
  assert.equal(wf.status, 'off');
  assert.equal((await api.patch(`/api/workflows/${wf.id}`, { graph: G([]) })).status, 400);
  assert.equal((await api.patch(`/api/workflows/${wf.id}`, { graph: G([trig(), trig()]) })).status, 400);
  assert.equal((await api.patch(`/api/workflows/${wf.id}`, { graph: G([trig(), { id: 'n2', type: 'teleport' }]) })).status, 400);
  assert.equal((await api.patch(`/api/workflows/${wf.id}`, { graph: G([trig()], [{ from: 'n1', to: 'n9' }]) })).status, 400);
  // A half-built step saves (you build in steps) but will not switch on.
  const saved = await api.patch(`/api/workflows/${wf.id}`, { graph: G([trig(), { id: 'n2', type: 'function', config: {} }], [{ from: 'n1', to: 'n2' }]) });
  assert.equal(saved.status, 200);
  const on = await api.patch(`/api/workflows/${wf.id}`, { status: 'on' });
  assert.equal(on.status, 400);
  assert.match(on.body.error, /Run a function: Pick a function/);
});

test('a manual run carries an item through a function, a condition and a save to People', async () => {
  const env = fakeEnv();
  const f = fakeFetch({ 'cloudflare-dns.com': () => dns([[15, '1 aspmx.l.google.com.']]), 'dns.google': () => dns([[15, '1 aspmx.l.google.com.']]) });
  const api = await client(env, { fetch: f });
  const graph = G([
    trig(),
    { id: 'n2', type: 'function', config: { fn: 'email_provider', inputs: { domain: '{{domain}}' }, save_as: 'mail' } },
    { id: 'n3', type: 'condition', config: { formula: '{{mail}} = "Google Workspace"' } },
    { id: 'n4', type: 'upsert', config: { kind: 'companies', values: { name: '{{company}}', domain: '{{domain}}', notes: 'Uses {{mail}}' } } },
    { id: 'n5', type: 'set', config: { values: { skipped: 'yes' } } },
  ], [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }, { from: 'n3', to: 'n4', port: 'true' }, { from: 'n3', to: 'n5', port: 'false' }]);
  const wf = (await api.post('/api/workflows', { name: 'Tag Google shops', graph })).body;
  const q = await api.post(`/api/workflows/${wf.id}/run`, { item: { company: 'Example Roofing', domain: 'example.com' } });
  assert.equal(q.body.queued, 1, JSON.stringify(q.body));
  const rep = (await api.post('/api/workflows/drain')).body;
  assert.equal(rep.done, 1, JSON.stringify(rep));
  const run = (await api.get(`/api/workflows/${wf.id}/runs`)).body[0];
  assert.deepEqual(run.log.map((l) => l.node), ['n2', 'n3', 'n4']);
  assert.equal(run.item.mail, 'Google Workspace');
  const co = (await api.get('/api/audiences/companies')).body.records[0];
  assert.equal(co.data.notes, 'Uses Google Workspace');
  assert.equal(co.sources.name.source, 'Workflow Tag Google shops');
});

test('a delay parks a run until its time; the cron picks it up', async () => {
  const env = fakeEnv(); const api = await client(env);
  const graph = G([trig(), { id: 'n2', type: 'delay', config: { minutes: 10 } }, { id: 'n3', type: 'set', config: { values: { after: 'done' } } }],
    [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n3' }]);
  const wf = (await api.post('/api/workflows', { name: 'Wait', graph })).body;
  await api.post(`/api/workflows/${wf.id}/run`, { item: {} });
  await api.post('/api/workflows/drain');
  let run = (await api.get(`/api/workflows/${wf.id}/runs`)).body[0];
  assert.equal(run.status, 'waiting');
  await scheduled({}, env, {}, { now: new Date(Date.now() + 5 * 60000) });
  assert.equal((await api.get(`/api/workflows/${wf.id}/runs`)).body[0].status, 'waiting');
  for (let i = 0; i < 3; i++) await scheduled({}, env, {}, { now: new Date(Date.now() + 11 * 60000 + i * 60000) });
  run = (await api.get(`/api/workflows/${wf.id}/runs`)).body[0];
  assert.equal(run.status, 'done');
  assert.equal(run.item.after, 'done');
});

test('a new-row trigger runs only for rows added after it was switched on', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = (await api.post('/api/tables', { name: 'Inbound', csv: 'Name\nOld row\n' })).body;
  const graph = G([trig({ type: 'row_added', table_id: t.id }), { id: 'n2', type: 'set', config: { values: { seen: '{{name}}' } } }], [{ from: 'n1', to: 'n2' }]);
  const wf = (await api.post('/api/workflows', { name: 'On new row', graph })).body;
  assert.equal((await api.patch(`/api/workflows/${wf.id}`, { status: 'on' })).status, 200);
  await api.post(`/api/tables/${t.id}/rows`, { rows: [{ name: 'New row' }] });
  for (let i = 0; i < 3; i++) await scheduled({}, env, {}, { now: new Date(Date.now() + i * 60000) });
  const runs = (await api.get(`/api/workflows/${wf.id}/runs`)).body;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].item.seen, 'New row');
});

test('the webhook trigger needs its secret URL and the workflow on', async () => {
  const env = fakeEnv(); const api = await client(env);
  const graph = G([trig({ type: 'webhook' }), { id: 'n2', type: 'set', config: { values: { got: '{{email}}' } } }], [{ from: 'n1', to: 'n2' }]);
  const wf = (await api.post('/api/workflows', { name: 'Hook', graph })).body;
  const { url } = (await api.post(`/api/workflows/${wf.id}/webhook`, {})).body;
  const post = (u, body) => handle(new Request(u, { method: 'POST', body: JSON.stringify(body) }), env);
  assert.equal((await post(url, { email: 'a@example.com' })).status, 409);   // off
  await api.patch(`/api/workflows/${wf.id}`, { status: 'on' });
  assert.equal((await post(url.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')), {})).status, 404);   // wrong token
  const r = await post(url, { email: 'a@example.com', nested: { x: 1 } });
  assert.equal(r.status, 202);
  await api.post('/api/workflows/drain');
  const run = (await api.get(`/api/workflows/${wf.id}/runs`)).body[0];
  assert.equal(run.item.got, 'a@example.com');
  assert.equal(run.item.nested, '{"x":1}');
});

test('a run stops at the budget before a paid step', async () => {
  const env = fakeEnv(); env.EXA_API_KEY = 'k';
  const f = fakeFetch({ 'api.exa.ai': () => ({ results: [] }) });
  const api = await client(env, { fetch: f });
  await api.patch('/api/settings', { default_budget_micros: 1000 });   // $0.001; an Exa search is ~$0.007
  const graph = G([trig(), { id: 'n2', type: 'function', config: { fn: 'exa_search', inputs: { query: 'roofers' } } }], [{ from: 'n1', to: 'n2' }]);
  const wf = (await api.post('/api/workflows', { name: 'Paid', graph })).body;
  await api.post(`/api/workflows/${wf.id}/run`, { item: {} });
  await api.post('/api/workflows/drain');
  const run = (await api.get(`/api/workflows/${wf.id}/runs`)).body[0];
  assert.equal(run.status, 'over_budget');
  assert.equal(f.calls.length, 0);
});

test('flat items: nested values become JSON text, keys are cleaned', () => {
  assert.deepEqual(flatItem({ 'First Name': 'Ana', n: 2, deep: { a: [1] }, '': 'x' }), { first_name: 'Ana', n: 2, deep: '{"a":[1]}' });
});

/* ---------------------------------------------------------------- signals */

test('RSS and page-change helpers', () => {
  const xml = '<rss><channel><item><title><![CDATA[Acme raises $5M]]></title><link>https://news.example.com/a</link><pubDate>Mon</pubDate><source>Paper</source></item><item><title>bad</title><link>javascript:alert(1)</link></item></channel></rss>';
  assert.deepEqual(parseRss(xml), [{ title: 'Acme raises $5M', url: 'https://news.example.com/a', published: 'Mon', source: 'Paper' }]);
  assert.deepEqual(addedSentences('We fix roofs in Gainesville. Call us today for a quote.', 'We fix roofs in Gainesville. Now hiring two roofing crew members!'), ['Now hiring two roofing crew members!']);
});

test('a jobs signal saves a baseline first, then records only new roles, adds rows and fires workflows', async () => {
  const env = fakeEnv();
  let jobs = [{ title: 'Roofer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Tampa' } }];
  let now = Date.now();
  const f = fakeFetch({ 'greenhouse.io': () => ({ jobs }), 'lever.co': () => new Response('[]', { status: 404 }), 'ashbyhq.com': () => new Response('{}', { status: 404 }) });
  const api = await client(env, { fetch: f, get nowMs() { return now; } });
  const t = (await api.post('/api/tables', { name: 'Hiring' })).body;
  const s = (await api.post('/api/signals', { name: 'Acme hiring', type: 'jobs', targets: 'acme', table_id: t.id })).body;
  const wf = (await api.post('/api/workflows', { name: 'On hire', graph: G([trig({ type: 'signal', signal_id: s.id }), { id: 'n2', type: 'set', config: { values: { role: '{{title}}' } } }], [{ from: 'n1', to: 'n2' }]) })).body;
  await api.patch(`/api/workflows/${wf.id}`, { status: 'on' });
  let r = (await api.post(`/api/signals/${s.id}/check`)).body;
  assert.equal(r.events, 0);   // baseline
  jobs = [...jobs, { title: 'Estimator', absolute_url: 'https://boards.greenhouse.io/acme/jobs/2', location: { name: 'Tampa' } }];
  now += 2 * 86400_000;        // past the one-day board cache
  r = (await api.post(`/api/signals/${s.id}/check`)).body;
  assert.equal(r.events, 1, JSON.stringify(r));
  const ev = (await api.get('/api/signals/events')).body;
  assert.equal(ev[0].title, 'Estimator (Tampa)');
  const rows = (await api.get(`/api/tables/${t.id}`)).body.rows;
  assert.equal(rows.length, 1);
  await api.post('/api/workflows/drain');
  assert.equal((await api.get(`/api/workflows/${wf.id}/runs`)).body[0].item.role, 'Estimator (Tampa)');
  assert.equal((await api.get('/api/signals')).body[0].events, 1);
});

test('a website signal notices a change and says what was added', async () => {
  const env = fakeEnv();
  let page = '<p>We fix roofs in Gainesville and nearby towns.</p>';
  const api = await client(env, { fetch: fakeFetch({ 'acme.example.com': () => html(page) }) });
  const s = (await api.post('/api/signals', { name: 'Acme site', type: 'website', targets: ['acme.example.com'] })).body;
  await api.post(`/api/signals/${s.id}/check`);
  await api.post(`/api/signals/${s.id}/check`);
  assert.equal((await api.get('/api/signals/events')).body.length, 0);   // unchanged
  page += '<p>Now offering solar panel installation across Florida.</p>';
  await api.post(`/api/signals/${s.id}/check`);
  const ev = (await api.get('/api/signals/events')).body;
  assert.equal(ev.length, 1);
  assert.match(ev[0].title, /solar panel/);
  assert.equal((await api.post('/api/signals', { name: 'x', type: 'weather', targets: 'a' })).status, 400);
  assert.equal((await api.post('/api/signals', { name: 'x', type: 'news', targets: [] })).status, 400);
});

/* ---------------------------------------------------------------- tokens, REST, MCP, exports */

test('API tokens: shown once, stored hashed, work on /api/v1, revoke at once, cannot make tokens', async () => {
  const env = fakeEnv(); const api = await client(env);
  const tok = (await api.post('/api/tokens', { name: 'CLI' })).body;
  assert.match(tok.token, /^fc_[A-Za-z0-9_-]{32}$/);
  assert.ok(!JSON.stringify(env.sql.prepare('SELECT * FROM api_tokens').all()).includes(tok.token));
  const call = (path, init = {}) => handle(new Request('https://x.test' + path, { ...init, headers: { authorization: `Bearer ${tok.token}`, ...(init.headers || {}) } }), env);
  assert.equal((await call('/api/v1/bootstrap')).status, 200);
  assert.equal((await call('/api/v1/tokens', { method: 'POST', body: '{"name":"more"}' })).status, 403);
  assert.equal((await handle(new Request('https://x.test/api/v1/bootstrap', { headers: { authorization: 'Bearer fc_notarealtokenatallnotarealtoken' } }), env)).status, 401);
  assert.equal((await api.get('/api/tokens')).body[0].prefix, tok.token.slice(0, 9));
  await api.del(`/api/tokens/${tok.id}`);
  assert.equal((await call('/api/v1/bootstrap')).status, 401);
});

test('MCP: old and new clients, tools list, tool calls, errors as results, auth', async () => {
  const env = fakeEnv(); const api = await client(env);
  const { token } = (await api.post('/api/tokens', { name: 'Claude' })).body;
  const rpc = async (msg, auth = token) => {
    const r = await handle(new Request('https://x.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(msg) }), env);
    return { status: r.status, body: r.status === 202 ? null : await r.json() };
  };
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'fc_wrongwrongwrongwrongwrongwrongwr')).status, 401);
  let r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } } });
  assert.equal(r.body.result.protocolVersion, '2025-06-18');
  assert.equal(r.body.result.serverInfo.name, 'free-clay');
  assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });   // a stateless 2026-07-28 client starts here
  const names = r.body.result.tools.map((t) => t.name);
  for (const n of ['list_tables', 'create_table', 'add_rows', 'run_column', 'search_people', 'run_agent', 'find_local_businesses']) assert.ok(names.includes(n), n);
  r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_table', arguments: { name: 'From Claude', columns: [{ name: 'Company' }, { name: 'Website', type: 'url' }] } } });
  const t = r.body.result.structuredContent;
  assert.deepEqual(t.columns.map((c) => c.name), ['Company', 'Website']);
  r = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'add_rows', arguments: { table_id: t.id, rows: [{ Company: 'Acme', Website: 'https://acme.example.com', Junk: 1 }] } } });
  assert.equal(r.body.result.structuredContent.added, 1);
  r = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_rows', arguments: { table_id: t.id } } });
  assert.equal(r.body.result.structuredContent.rows[0].Company, 'Acme');
  r = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_rows', arguments: { table_id: 999 } } });
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /No such table/);
  r = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'save_people', arguments: { records: [{ email: 'ana@example.com', full_name: 'Ana' }] } } });
  assert.equal(r.body.result.structuredContent.added, 1);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 8, method: 'nope' })).body.error.code, -32601);
  // save_people with no records would quietly add nothing: the missing argument must be named.
  const missing = (await rpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'save_people', arguments: {} } })).body.result;
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Missing argument: records/);
  const get = await handle(new Request('https://x.test/mcp', { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(get.status, 405);
});

test('exports are listed and download again as they were', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = (await api.post('/api/tables', { name: 'Leads', csv: 'Name\nAcme\n' })).body;
  const first = (await api.get(`/api/tables/${t.id}/export.csv`)).body;
  await api.post(`/api/tables/${t.id}/rows`, { rows: [{ name: 'Later' }] });
  const list = (await api.get('/api/exports')).body.exports;
  assert.equal(list.length, 1);
  assert.equal(list[0].rows, 1);
  assert.equal(list[0].kept, true);
  assert.equal((await api.get(`/api/exports/${list[0].id}/download`)).body, first);   // not the new row
  await scheduled({}, env, {}, { now: new Date(Date.now() + 31 * 86400_000) });
  assert.equal((await api.get('/api/exports')).body.exports.length, 0);
});

test('/mcp in a browser is the MCP page; everything else is the server', async () => {
  const env = fakeEnv();
  env.ASSETS = { fetch: async () => new Response('<!doctype html><title>Free Clay</title>', { headers: { 'content-type': 'text/html' } }) };
  const page = await handle(new Request('https://x.test/mcp', { headers: { accept: 'text/html,application/xhtml+xml' } }), env);
  assert.match(await page.text(), /<title>Free Clay/);
  const server = await handle(new Request('https://x.test/mcp', { method: 'POST', body: '{}' }), env);
  assert.equal(server.status, 401);
});
