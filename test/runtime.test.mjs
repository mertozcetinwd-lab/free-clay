// Workers-runtime behaviour Node does not have. On Cloudflare, calling the global fetch with any
// `this` but the global (e.g. ctx.fetch(...) where ctx.fetch IS the global) throws "Illegal
// invocation". Node ignores `this`, so every other test would pass while production fails. These
// tests install a global fetch that checks `this` the way workerd does, and inject NO fetch, so
// the code takes its production path (found 2026-09-29 by a `wrangler dev` smoke).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch } from './helpers.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Install a global fetch that answers from `routes` and refuses a foreign `this`, like workerd. */
function installStrictFetch(routes) {
  const fake = fakeFetch(routes);
  globalThis.fetch = function fetch(input, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation: function called with incorrect `this` reference.');
    return fake(input, init);
  };
  return fake;
}

const tregAnswer = (output, cost) => new Response(JSON.stringify({ output, raw: {}, _treg: {} }),
  { status: 200, headers: { 'content-type': 'application/json', 'x-treg-cost-micro': String(cost) } });

async function table(api) {
  const t = (await api.post('/api/tables', { name: 'T', csv: 'Company,Website\nAcme Roofing,example.com\n' })).body;
  return t;
}

async function runColumn(api, t, spec) {
  const c = await api.post(`/api/tables/${t.id}/columns`, spec);
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.body.id, budget_micros: 200_000 });
  await api.post('/api/run-batch');
  const got = (await api.get(`/api/tables/${t.id}`)).body;
  return { value: got.rows[0].data[c.body.key], meta: got.meta.find((m) => m.column_id === c.body.id) };
}

test('runtime: AI, HTTP and treg columns work with the global fetch (no injected fetch)', async () => {
  installStrictFetch({
    'api.anthropic.com/v1/messages': { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{"answer": "roofer"}' }], usage: { input_tokens: 50, output_tokens: 5 } },
    'api.example.com/ok': { data: { email: 'info@example.com' } },
    'treg.to/call/treg.companies.enrich': () => tregAnswer({ name: 'Acme Roofing', domain: 'example.com', industry: 'Roofing' }, 1900),
  });
  const env = fakeEnv(); env.ANTHROPIC_API_KEY = 'sk-test'; env.TREG_TOKEN = 'tok';
  const api = await client(env);
  const t = await table(api);

  const ai = await runColumn(api, t, { name: 'Kind', kind: 'ai', config: { provider: 'anthropic', model: 'claude-opus-5',
    prompt: 'What is {{company}}?', max_tokens: 100, fields: [{ name: 'answer', type: 'text' }] } });
  assert.equal(ai.meta.status, 'done', ai.meta.error);

  const http = await runColumn(api, t, { name: 'API', kind: 'http', config: { method: 'GET', url: 'https://api.example.com/ok?c={{company}}', path: '$.data.email' } });
  assert.equal(http.meta.status, 'done', http.meta.error);
  assert.equal(http.value, 'info@example.com');

  const treg = await runColumn(api, t, { name: 'Industry', kind: 'enrich', config: { fn: 'treg_company_enrich', inputs: { domain: '{{website}}' } } });
  assert.equal(treg.meta.status, 'done', treg.meta.error);
});

test('runtime: People search reaches treg with the global fetch (no injected fetch)', async () => {
  installStrictFetch({ 'treg.to/call/treg.people.search': () => tregAnswer({ people: [{ full_name: 'Ana Testrow', title: 'Owner', company: 'Example Roofing', domain: 'example.com' }] }, 3000) });
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const api = await client(env);
  const r = await api.post('/api/find/people', { title: 'owner', company_domain: 'example.com', limit: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.results[0].full_name, 'Ana Testrow');
});
