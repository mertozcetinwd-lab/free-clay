import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch } from './helpers.mjs';
import { hunter_email_finder, hunter_email_verifier, prospeo_enrich_person, exa_find_similar, exa_search, places_lookup } from '../src/functions/byok.js';
import { buildPrompt, parseFields, worstCaseMicros } from '../src/kinds/ai.js';
import { buildRequest } from '../src/kinds/http.js';
import { getPath } from '../public/js/jsonpath.js';

const secret = (n) => `KEY_${n}`;
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/* ---------------------------------------------------------------- BYO-key functions */

test('Hunter finder: sends the key only to Hunter, flags catch-all, 404 is a miss', async () => {
  const f = fakeFetch({ 'api.hunter.io/v2/email-finder': { data: { email: 'ann@acme.example.com', score: 91, accept_all: true, verification: { status: null }, position: 'Owner' } } });
  const r = await hunter_email_finder.run({ first_name: 'Ann', last_name: 'Lee', domain: 'https://www.acme.example.com' }, { fetch: f, secret });
  assert.deepEqual(r.data, { email: 'ann@acme.example.com', score: 91, status: 'accept_all', position: 'Owner' });
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('domain'), 'acme.example.com');
  assert.equal(u.searchParams.get('api_key'), 'KEY_HUNTER_API_KEY');
  const miss = fakeFetch({ 'hunter.io': () => json({ errors: [] }, 404) });
  assert.equal((await hunter_email_finder.run({ first_name: 'a', last_name: 'b', domain: 'acme.com' }, { fetch: miss, secret })).status, 'no_result');
  const out = fakeFetch({ 'hunter.io': () => json({ errors: [{ details: 'quota' }] }, 429) });
  await assert.rejects(hunter_email_finder.run({ first_name: 'a', last_name: 'b', domain: 'acme.com' }, { fetch: out, secret }), /HTTP 429 \(rate limit or out of credits\)/);
});

test('Hunter verifier passes only deliverable mailboxes', async () => {
  const f = fakeFetch({ 'email-verifier': (req) => ({ data: { status: new URL(req.url).searchParams.get('email').startsWith('ok') ? 'valid' : 'accept_all', score: 70 } }) });
  assert.equal((await hunter_email_verifier.run({ email: 'ok@a.com' }, { fetch: f, secret })).data.valid, true);
  assert.equal((await hunter_email_verifier.run({ email: 'x@a.com' }, { fetch: f, secret })).data.valid, false);
});

test('Prospeo: nested body, X-KEY header, NO_MATCH is a miss, email as string or object', async () => {
  const f = fakeFetch({ 'prospeo.io': { response: { email: { email: 'ann@acme.example.com', email_status: 'VERIFIED' }, job_title: 'CEO' } } });
  const r = await prospeo_enrich_person.run({ full_name: 'Ann Lee', domain: 'acme.example.com' }, { fetch: f, secret });
  assert.deepEqual(r.data, { email: 'ann@acme.example.com', status: 'verified', title: 'CEO' });
  assert.equal(f.calls[0].headers.get('x-key'), 'KEY_PROSPEO_API_KEY');
  assert.deepEqual(JSON.parse(f.calls[0].body), { only_verified_email: false, data: { full_name: 'Ann Lee', company_website: 'acme.example.com' } });
  const miss = fakeFetch({ 'prospeo.io': () => json({ error: true, error_code: 'NO_MATCH' }, 400) });
  assert.equal((await prospeo_enrich_person.run({ full_name: 'A B', domain: 'x.com' }, { fetch: miss, secret })).status, 'no_result');
  const s = fakeFetch({ 'prospeo.io': { response: { email: 'b@x.com' } } });
  assert.equal((await prospeo_enrich_person.run({ full_name: 'A B', domain: 'x.com' }, { fetch: s, secret })).data.email, 'b@x.com');
});

test('Exa: real cost comes back from the API and drops the source site', async () => {
  const f = fakeFetch({ 'api.exa.ai/findSimilar': { results: [{ url: 'https://www.acme.example.com/about' }, { url: 'https://beta.example.com/' }, { url: 'https://cato.example.com/x' }], costDollars: { total: 0.0061 } } });
  const r = await exa_find_similar.run({ url: 'acme.example.com' }, { fetch: f, secret });
  assert.equal(r.data.similar, 'beta.example.com, cato.example.com');
  assert.equal(r.cost_micros, 6100);
  assert.equal(f.calls[0].headers.get('x-api-key'), 'KEY_EXA_API_KEY');
  const s = fakeFetch({ 'api.exa.ai/search': { results: [] } });
  assert.equal((await exa_search.run({ query: 'x' }, { fetch: s, secret })).status, 'no_result');
});

test('Places lookup asks for a field mask and maps the first place', async () => {
  const f = fakeFetch({ 'places.googleapis.com': { places: [{ id: 'p1', displayName: { text: 'Acme Roofing' }, websiteUri: 'https://acme.example.com', rating: 4.8, userRatingCount: 31, googleMapsUri: 'https://maps.google.com/?cid=1' }] } });
  const r = await places_lookup.run({ query: 'Acme Roofing Gainesville' }, { fetch: f, secret });
  assert.equal(r.data.website, 'https://acme.example.com');
  assert.equal(r.data.reviews, 31);
  assert.match(f.calls[0].headers.get('x-goog-fieldmask'), /places\.websiteUri/);
});

/* ---------------------------------------------------------------- AI column */

test('AI prompt: fields become a JSON instruction; replies parse leniently', () => {
  const cfg = { prompt: 'Is {{company}} a roofer?', fields: [{ name: 'is_roofer', type: 'checkbox' }, { name: 'reason', type: 'text' }] };
  const p = buildPrompt(cfg, { company: 'Acme Roofing' });
  assert.equal(p.user, 'Is Acme Roofing a roofer?');
  assert.match(p.system, /"is_roofer": true or false, "reason": a short string/);
  assert.deepEqual(parseFields('Sure! ```json\n{"is_roofer": true, "reason": "name", "extra": 1}\n```', cfg.fields), { is_roofer: true, reason: 'name' });
  assert.throws(() => parseFields('no json here', cfg.fields), /did not return JSON/);
});

test('AI worst case = prompt tokens at input price + all max_tokens at output price', () => {
  assert.equal(worstCaseMicros({ provider: 'anthropic', model: 'claude-haiku-4-5', est_input_tokens: 800, max_tokens: 500 }), 800 * 1 + 500 * 5);
  assert.equal(worstCaseMicros({ provider: 'groq', model: 'qwen/qwen3.8-27b', est_input_tokens: 800 }), 0);
  assert.equal(worstCaseMicros({ provider: 'openai', model: 'some-model', price_in: 0.5, price_out: 2, est_input_tokens: 1000, max_tokens: 100 }), 700);
});

async function tableWith(fetch) {
  const env = fakeEnv(); const api = await client(env, { fetch });
  const t = (await api.post('/api/tables', { name: 'AI' })).body;
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Company' });
  await api.post(`/api/tables/${t.id}/rows`, { data: { company: 'Acme Roofing' } });
  return { env, api, t };
}

test('AI column end to end on Anthropic: headers, fallback, effort, usage-based cost, outputs', async () => {
  const f = fakeFetch({ 'api.anthropic.com/v1/messages': { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"is_roofer": true, "reason": "Roofing in the name"}' }], usage: { input_tokens: 120, output_tokens: 40 } } });
  const { env, api, t } = await tableWith(f);
  env.ANTHROPIC_API_KEY = 'sk-test';
  const reason = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Reason' })).body;
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Roofer?', kind: 'ai', type: 'checkbox', config: {
    provider: 'anthropic', model: 'claude-opus-5', prompt: 'Is {{company}} a roofer?', max_tokens: 400,
    fields: [{ name: 'is_roofer', type: 'checkbox' }, { name: 'reason', type: 'text' }], outputs: [{ field: 'reason', column: reason.key }] } })).body;
  const run = (await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, budget_micros: 100_000 })).body;
  assert.ok(run.per_cell_micros > 0);
  await api.post('/api/run-batch');
  const row = (await api.get(`/api/tables/${t.id}`)).body.rows[0].data;
  assert.equal(row.roofer, true);
  assert.equal(row.reason, 'Roofing in the name');
  const req = f.calls[0];
  assert.equal(req.headers.get('x-api-key'), 'sk-test');
  assert.equal(req.headers.get('anthropic-version'), '2023-06-01');
  assert.equal(req.headers.get('anthropic-beta'), 'server-side-fallback-2026-07-01');
  const body = JSON.parse(req.body);
  assert.equal(body.fallbacks, 'default');
  assert.deepEqual(body.output_config, { effort: 'low' });
  assert.equal(body.messages[0].content, 'Is Acme Roofing a roofer?');
  const l = env.sql.prepare('SELECT provider, cost_micros, note FROM ledger').get();
  assert.deepEqual([l.provider, l.cost_micros, l.note], ['ai:claude-opus-5', 120 * 5 + 40 * 25, '120 in / 40 out tokens']);
});

test('AI refusals and token exhaustion are errors with a reason, still ledgered', async () => {
  const f = fakeFetch({ 'api.anthropic.com': { model: 'claude-haiku-4-5', stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: { input_tokens: 10, output_tokens: 0 } } });
  const { env, api, t } = await tableWith(f);
  env.ANTHROPIC_API_KEY = 'k';
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Out', kind: 'ai', config: { provider: 'anthropic', model: 'claude-haiku-4-5', prompt: '{{company}}' } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const m = (await api.get(`/api/tables/${t.id}`)).body.meta[0];
  assert.equal(m.status, 'error'); assert.match(m.error, /Declined \(cyber\)/);
  assert.equal(JSON.parse(f.calls[0].body).output_config, undefined);   // Haiku 4.5 takes no effort
  assert.equal(env.sql.prepare('SELECT cost_micros FROM ledger').get().cost_micros, 10);
});

test('AI on Groq uses the OpenAI-style API, strips <think>, costs $0', async () => {
  const f = fakeFetch({ 'api.groq.com': { model: 'qwen/qwen3.8-27b', choices: [{ message: { content: '<think>hmm</think> Roofing contractor' } }], usage: { prompt_tokens: 50, completion_tokens: 9 } } });
  const { env, api, t } = await tableWith(f);
  env.GROQ_API_KEY = 'gk';
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Category', kind: 'ai', config: { provider: 'groq', model: 'qwen/qwen3.8-27b', prompt: 'Category of {{company}}?' } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, budget_micros: 0 });
  await api.post('/api/run-batch');
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.rows[0].data.category, 'Roofing contractor');
  assert.equal(f.calls[0].headers.get('authorization'), 'Bearer gk');
});

test('AI config: an unknown model needs a price, so the budget cap can never be blind', async () => {
  const { api, t } = await tableWith(fakeFetch({}));
  const bad = await api.post(`/api/tables/${t.id}/columns`, { name: 'X', kind: 'ai', config: { provider: 'openai', model: 'gpt-something', prompt: 'hi' } });
  assert.equal(bad.status, 400); assert.match(bad.body.error, /No price known/);
  const ok = await api.post(`/api/tables/${t.id}/columns`, { name: 'X', kind: 'ai', config: { provider: 'openai', model: 'gpt-something', prompt: 'hi', price_in: 1, price_out: 4 } });
  assert.equal(ok.status, 201);
});

/* ---------------------------------------------------------------- HTTP column */

test('HTTP request building: values encoded for where they land, secrets filled once', () => {
  const cfg = { method: 'POST', url: 'https://api.example.com/v1/find?d={{domain}}&key={{secret:EX_KEY}}',
    headers: [{ name: 'Authorization', value: 'Bearer {{secret:EX_KEY}}' }, { name: 'X-Note', value: '{{note}}' }],
    body: '{"company": "{{company}}"}' };
  const data = { domain: 'a.com&admin=1', company: 'Acme "Roofing"\n', note: 'x\r\nX-Evil: 1', sneaky: '{{secret:EX_KEY}}' };
  const { url, init } = buildRequest({ ...cfg, body: '{"company": "{{company}}", "s": "{{sneaky}}"}' }, data, secret);
  assert.equal(new URL(url).searchParams.get('d'), 'a.com&admin=1');
  assert.equal(new URL(url).searchParams.get('key'), 'KEY_EX_KEY');
  assert.equal(init.headers.Authorization, 'Bearer KEY_EX_KEY');
  assert.equal(init.headers['X-Note'], 'x X-Evil: 1');
  assert.deepEqual(JSON.parse(init.body), { company: 'Acme "Roofing"\n', s: '{{secret:EX_KEY}}' });   // row text is never expanded
  assert.equal(init.headers['content-type'], 'application/json');
});

test('HTTP config: https only, fixed host, no reserved secrets, valid paths', async () => {
  const { api, t } = await tableWith(fakeFetch({}));
  const post = (config) => api.post(`/api/tables/${t.id}/columns`, { name: 'H', kind: 'http', config });
  assert.equal((await post({ url: 'http://api.example.com/x' })).status, 400);
  assert.equal((await post({ url: 'https://{{company}}/x' })).status, 400);
  assert.equal((await post({ url: 'https://api.example.com@{{company}}/x' })).status, 400);
  assert.equal((await post({ url: 'https://api.example.com/x', headers: [{ name: 'X', value: '{{secret:APP_PASSWORD}}' }] })).status, 400);
  assert.equal((await post({ url: 'https://api.example.com/x', path: 'a..b[' })).status, 400);
  assert.equal((await post({ url: 'https://api.example.com/x?q={{company}}', path: 'data.email' })).status, 201);
});

test('HTTP column end to end: JSON path to the cell, outputs, errors carry the body', async () => {
  const f = fakeFetch({ 'api.example.com/ok': { data: { email: 'ann@acme.example.com', phones: ['352-555-0100'] } }, 'api.example.com/bad': () => json({ message: 'nope' }, 422) });
  const { env, api, t } = await tableWith(f);
  env.EX_KEY = 'secret-x';
  const phone = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Phone' })).body;
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'API email', kind: 'http', type: 'email', config: {
    method: 'GET', url: 'https://api.example.com/ok?c={{company}}', headers: [{ name: 'X-Key', value: '{{secret:EX_KEY}}' }],
    path: '$.data.email', outputs: [{ field: 'data.phones[0]', column: phone.key }], cost_micros: 1500 } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const row = (await api.get(`/api/tables/${t.id}`)).body.rows[0].data;
  assert.equal(row.api_email, 'ann@acme.example.com'); assert.equal(row.phone, '352-555-0100');
  assert.equal(f.calls[0].headers.get('x-key'), 'secret-x');
  assert.equal(env.sql.prepare('SELECT cost_micros FROM ledger').get().cost_micros, 1500);
  assert.ok(!JSON.stringify((await api.get(`/api/tables/${t.id}`)).body).includes('secret-x'));
  const bad = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Bad', kind: 'http', config: { url: 'https://api.example.com/bad' } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: bad.id });
  await api.post('/api/run-batch');
  const m = (await api.get(`/api/tables/${t.id}`)).body.meta.find((x) => x.column_id === bad.id);
  assert.match(m.error, /HTTP 422: \{"message":"nope"\}/);
});

test('JSON paths: own properties only', () => {
  const o = JSON.parse('{"a":{"b":[{"c":1}]},"odd key":2}');
  assert.equal(getPath(o, '$.a.b[0].c'), 1);
  assert.equal(getPath(o, 'a.b.0.c'), 1);
  assert.equal(getPath(o, '["odd key"]'), 2);
  assert.equal(getPath(o, 'a.constructor'), null);
  assert.equal(getPath(o, 'x.y'), null);
});

/* ---------------------------------------------------------------- Places source */

test('Places source: rows with typed columns, dedupe on re-run, ledger, budget check first', async () => {
  const place = (id, name) => ({ id, displayName: { text: name }, formattedAddress: 'Gainesville, FL', websiteUri: `https://${id}.example.com`, rating: 4.5, userRatingCount: 12 });
  let page = 0;
  const f = fakeFetch({ 'places.googleapis.com': () => (page++ === 0 ? { places: [place('p1', 'Acme'), place('p2', 'Beta')], nextPageToken: 't' } : { places: [place('p3', 'Cato')] }) });
  const env = fakeEnv(); const api = await client(env, { fetch: f, sleep: async () => {} });
  env.GOOGLE_MAPS_API_KEY = 'gk';
  const t = (await api.post('/api/tables', { name: 'Places' })).body;
  const r = (await api.post(`/api/tables/${t.id}/source/places`, { query: 'roofers in Gainesville FL', pages: 2, budget_micros: 100_000 })).body;
  assert.deepEqual(r, { found: 3, added: 3, skipped_duplicates: 0, cost_micros: 70_000 });
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.equal(full.columns.find((c) => c.name === 'Website').type, 'url');
  assert.equal(full.columns.filter((c) => c.name === 'Name').length, 1);      // reused the existing Name column
  assert.equal(full.rows[0].data.name, 'Acme');
  assert.equal(JSON.parse(f.calls[1].body).pageToken, 't');
  page = 1;
  const again = (await api.post(`/api/tables/${t.id}/source/places`, { query: 'roofers in Gainesville FL', budget_micros: 100_000 })).body;
  assert.equal(again.added, 0);
  assert.equal(env.sql.prepare(`SELECT sum(cost_micros) AS s FROM ledger WHERE provider='places_search'`).get().s, 105_000);
  const over = await api.post(`/api/tables/${t.id}/source/places`, { query: 'x', pages: 3, budget_micros: 50_000 });
  assert.equal(over.status, 400);
  assert.equal(f.calls.length, 3);
});
