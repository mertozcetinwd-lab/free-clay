import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch } from './helpers.mjs';
import { flatten, toPerson } from '../src/functions/treg.js';

/** A fake treg: answers by route, with the cost in the header the way treg does. */
function fakeTreg(routes, calls = []) {
  return fakeFetch({ 'treg.to/call/': (req) => {
    const route = req.url.split('/call/')[1];
    calls.push({ route, body: JSON.parse(req.body || '{}'), token: req.headers.get('x-treg-token'), cap: req.headers.get('x-treg-route-max-cost') });
    const r = routes[route];
    if (!r) return new Response('no route', { status: 404 });
    const [status, output, cost, by] = typeof r === 'function' ? r(JSON.parse(req.body || '{}')) : r;
    return new Response(JSON.stringify(status === 200 ? { output, raw: {}, _treg: { served_by: by } } : output), { status,
      headers: { 'content-type': 'application/json', 'x-treg-cost-micro': String(cost), ...(by ? { 'x-treg-served-by': by } : {}) } });
  } });
}

async function tableWith(api, csv) {
  const t = (await api.post('/api/tables', { name: 'T', csv })).body;
  const cols = (await api.get(`/api/tables/${t.id}`)).body.columns;
  return { t, key: (name) => cols.find((c) => c.name === name).key };
}

test('treg functions send the token and a hard cap, and the ledger records treg’s real charge', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const calls = [];
  const f = fakeTreg({
    'treg.people.email.find': (b) => (b.domain === 'example.com' ? [200, { email: 'ana@example.com' }, 4834, 'hunter.people.email.find'] : [200, { email: null }, 0, null]),
  }, calls);
  const api = await client(env, { fetch: f });
  const { t, key } = await tableWith(api, 'Name,Website\nAna Testrow,https://www.example.com/about\nBen Testrow,example.org\n');
  const c = await api.post(`/api/tables/${t.id}/columns`, { name: 'Email', kind: 'enrich', config: { fn: 'treg_email_find', inputs: { full_name: `{{${key('Name')}}}`, domain: `{{${key('Website')}}}` } } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.body.id });
  await api.post('/api/run-batch');
  const rows = (await api.get(`/api/tables/${t.id}`)).body.rows;
  assert.equal(rows[0].data[c.body.key], 'ana@example.com');
  assert.equal(rows[1].data[c.body.key], undefined);
  assert.equal(calls[0].token, 'tok');
  assert.equal(calls[0].cap, '0.0200');
  assert.deepEqual(calls[0].body, { full_name: 'Ana Testrow', domain: 'example.com' });
  const spend = (await api.get('/api/spend')).body;
  assert.ok(JSON.stringify(spend).includes('treg_email_find'));
  const { results } = { results: env.sql.prepare(`SELECT provider, cost_micros, outcome FROM ledger WHERE provider='treg_email_find' ORDER BY id`).all() };
  assert.deepEqual(results.map((r) => [r.cost_micros, r.outcome]), [[4834, 'done'], [0, 'no_result']]);
});

test('a treg refusal is a readable error; a name is required', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const f = fakeTreg({ 'treg.people.email.find': [402, { error: 'route_max_cost' }, 0, null] });
  const api = await client(env, { fetch: f });
  const { t, key } = await tableWith(api, 'Name,Website,Other\nAna Testrow,example.com,\n,example.com,x\n');
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Email', kind: 'enrich', config: { fn: 'treg_email_find', inputs: { full_name: `{{${key('Name')}}}`, domain: `{{${key('Website')}}}` } } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const meta = (await api.get(`/api/tables/${t.id}`)).body.meta.filter((m) => m.column_id === c.id);
  assert.match(meta[0].error, /treg HTTP 402: every provider would cost more than this row’?s? ?\$?0\.020 cap|would cost more than this row/);
  assert.match(meta[1].error, /Needs a full name/);
});

test('treg verify works as a waterfall validation step', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const f = fakeTreg({
    'treg.people.email.find': [200, { email: 'guess@example.co' }, 4834, 'dropcontact.people.email.find'],
    'treg.people.email.verify': (b) => [200, { status: b.email.endsWith('.co') ? 'invalid' : 'valid' }, 0, 'contactout.people.email.verify'],
  });
  const api = await client(env, { fetch: f });
  const { t, key } = await tableWith(api, 'Name,Website\nAna Testrow,example.com\n');
  const c = await api.post(`/api/tables/${t.id}/columns`, { name: 'Email', kind: 'waterfall', type: 'email', config: {
    steps: [{ fn: 'treg_email_find', inputs: { full_name: `{{${key('Name')}}}`, domain: `{{${key('Website')}}}` } }], validate: { fn: 'treg_email_verify', pass: 'valid' } } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.body.id });
  await api.post('/api/run-batch');
  const row = (await api.get(`/api/tables/${t.id}`)).body.rows[0];
  // The wrong-domain guess Clay billed as a hit (paid pass, 2026-09-28) fails validation here.
  assert.equal(row.data[c.body.key], undefined);
});

test('company enrich drops LinkedIn fields and fills output columns', async () => {
  assert.deepEqual(flatten({ name: 'Acme', linkedin_url: 'https://linkedin.com/company/acme', employees: 12, tags: ['a'] }), { name: 'Acme', employees: 12 });
  assert.equal(toPerson({ name: 'Ana Testrow', linkedin_url: 'x', title: 'Owner', company_website: 'https://example.com' }).domain, 'example.com');
  assert.equal(toPerson({ linkedin_url: 'x' }), null);
  assert.equal(Object.keys(toPerson({ full_name: 'Ana', linkedin: 'x' })).some((k) => /linkedin/.test(k)), false);
});

test('people search: capped by the budget, cached, imported without duplicates, saved to People', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const calls = [];
  const people = [{ full_name: 'Ana Testrow', title: 'Owner', company: 'Example Roofing', company_domain: 'example.com', location: 'Gainesville, FL', linkedin_url: 'https://linkedin.com/in/x' },
    { first_name: 'Ben', last_name: 'Testrow', job_title: 'General Manager', company_name: 'Example HVAC', domain: 'example.org' }];
  const f = fakeTreg({ 'treg.people.search': [200, { people }, 3000, 'apollo.people.search'] }, calls);
  const api = await client(env, { fetch: f });
  await api.patch('/api/settings', { default_budget_micros: 50_000 });
  const search = { title: 'owner', location: 'Florida', limit: 10 };
  const r = (await api.post('/api/find/people', { ...search, max_usd: 0.5 })).body;
  assert.equal(r.results.length, 2);
  assert.equal(calls[0].cap, '0.0500');                 // the budget per run wins over a bigger ask
  assert.equal(r.cost_micros, 3000);
  assert.equal(r.results[1].full_name, 'Ben Testrow');
  assert.ok(!JSON.stringify(r.results).includes('linkedin'));
  const again = (await api.post('/api/find/people', search)).body;
  assert.equal(again.cached, true); assert.equal(again.cost_micros, 0); assert.equal(calls.length, 1);
  const imp = (await api.post('/api/find/people/import', { search, new_name: 'Owners' })).body;
  assert.equal(imp.added, 2);
  assert.equal((await api.post('/api/find/people/import', { search, table_id: imp.table_id })).body.added, 0);
  const aud = (await api.post('/api/find/people/to-people', { search })).body;
  assert.equal(aud.added, 2);
  assert.equal((await api.post('/api/find/people', {})).status, 400);
  assert.equal((await api.post('/api/find/people/import', { search: { title: 'nobody searched this' } })).status, 409);
  const led = env.sql.prepare(`SELECT cost_micros FROM ledger WHERE provider='treg:people.search'`).all();
  assert.deepEqual(led.map((x) => x.cost_micros), [3000]);
});

test('agents get treg tools with several arguments; MCP can find people', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok'; env.GROQ_API_KEY = 'k';
  const calls = []; let n = 0;
  const treg = fakeTreg({ 'treg.people.email.find': [200, { email: 'ana@example.com' }, 4834, 'hunter'], 'treg.people.search': [200, { people: [{ full_name: 'Ana Testrow', title: 'Owner' }] }, 1000, 'apollo'] }, calls);
  const f = async (url, init) => {
    if (String(url).includes('api.groq.com')) {
      n++;
      const body = JSON.parse(init.body);
      if (n === 1) {
        assert.ok(body.tools.some((t) => t.function.name === 'find_work_email'));
        return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'find_work_email', arguments: '{"full_name":"Ana Testrow","domain":"example.com"}' } }] } }], usage: {} }));
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ana@example.com' } }], usage: {} }));
    }
    return treg(url, init);
  };
  const api = await client(env, { fetch: f });
  const a = (await api.post('/api/agents', { name: 'x', provider: 'groq', prompt: 'Email of {{person}}', tools: ['find_work_email'] })).body;
  const run = (await api.post(`/api/agents/${a.id}/run`, { input: { person: 'Ana at example.com' } })).body;
  assert.equal(run.status, 'done', run.error);
  assert.deepEqual(calls[0].body, { full_name: 'Ana Testrow', domain: 'example.com' });
  assert.equal(run.cost_micros, 4834);
  const { token } = (await api.post('/api/tokens', { name: 'mcp' })).body;
  const { handle } = await import('../src/index.js');
  const res = await handle(new Request('https://x.test/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'find_people', arguments: { title: 'owner' } } }) }), env, {}, { fetch: f });
  const out = (await res.json()).result.structuredContent;
  assert.equal(out.count, 1);
  assert.equal(out.cost_usd, 0.001);
});

test('job change signal: baseline first, then an event when the title or employer changes; paid checks are ledgered', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  let who = { full_name: 'Ana Testrow', title: 'Office Manager', company: 'Example Roofing' };
  const f = fakeTreg({ 'treg.people.enrich': () => [200, who, 2634, 'pdl'] });
  const api = await client(env, { fetch: f });
  const s = (await api.post('/api/signals', { name: 'Champions', type: 'job_change', targets: ['ana@example.com', 'Ben Testrow, example.org'] })).body;
  assert.equal((await api.post(`/api/signals/${s.id}/check`)).body.events, 0);
  who = { ...who, title: 'Operations Director' };
  const r = (await api.post(`/api/signals/${s.id}/check`)).body;
  assert.equal(r.events, 2);   // both fake people now show the new title
  const ev = (await api.get('/api/signals/events')).body;
  assert.match(ev[0].title, /new title, now Operations Director at Example Roofing \(was Office Manager/);
  const led = env.sql.prepare(`SELECT count(*) AS n, sum(cost_micros) AS c FROM ledger WHERE provider='treg:people.enrich'`).get();
  assert.deepEqual([led.n, led.c], [4, 4 * 2634]);
  assert.equal((await api.post('/api/signals', { name: 'bad', type: 'job_change', targets: ['just a name'] })).status, 201);
});

test('a "new member in segment" trigger runs for records added after it was switched on', async () => {
  const env = fakeEnv(); const api = await client(env);
  await api.post('/api/audiences/people/upsert', { records: [{ email: 'old@example.com', title: 'Owner' }] });
  const seg = (await api.post('/api/segments', { kind: 'people', name: 'Owners', filters: [{ field: 'title', op: 'equals', value: 'owner' }] })).body;
  const wf = (await api.post('/api/workflows', { name: 'Welcome owners', graph: { nodes: [
    { id: 'n1', type: 'trigger', config: { type: 'segment_new', segment_id: seg.id } }, { id: 'n2', type: 'set', config: { values: { hello: '{{email}}' } } }],
    edges: [{ from: 'n1', to: 'n2', port: 'out' }] } })).body;
  assert.equal((await api.patch(`/api/workflows/${wf.id}`, { status: 'on' })).status, 200);
  await api.post('/api/audiences/people/upsert', { records: [{ email: 'new@example.com', title: 'Owner' }, { email: 'other@example.com', title: 'Clerk' }] });
  const { scheduled } = await import('../src/index.js');
  for (let i = 0; i < 3; i++) await scheduled({}, env, {}, { now: new Date(Date.now() + i * 60000) });
  const runs = (await api.get(`/api/workflows/${wf.id}/runs`)).body;
  assert.equal(runs.length, 1);
  assert.equal(runs[0].item.hello, 'new@example.com');
});

test('send to HubSpot updates on 409, Instantly and Smartlead get the documented shapes', async () => {
  const env = fakeEnv(); env.HUBSPOT_TOKEN = 'hs'; env.INSTANTLY_API_KEY = 'in'; env.SMARTLEAD_API_KEY = 'sl';
  const seen = [];
  const f = fakeFetch({
    'api.hubapi.com/crm/v3/objects/contacts/77': (req) => { seen.push(['hs-patch', req.method, JSON.parse(req.body)]); return { id: '77' }; },
    'api.hubapi.com/crm/v3/objects/contacts': (req) => { seen.push(['hs-post', req.headers.get('authorization')]); return new Response('{"message":"Contact already exists. Existing ID: 77"}', { status: 409 }); },
    'api.instantly.ai/api/v2/leads': (req) => { seen.push(['in', req.headers.get('authorization'), JSON.parse(req.body)]); return { id: 'lead_1' }; },
    'server.smartlead.ai/api/v1/campaigns/123/leads': (req) => { seen.push(['sl', req.url.includes('api_key=sl'), JSON.parse(req.body)]); return { upload_count: 1 }; },
  });
  const api = await client(env, { fetch: f });
  const t = (await api.post('/api/tables', { name: 'Send', csv: 'Email,First name,Company\nana@example.com,Ana,Example Roofing\n' })).body;
  const cols = (await api.get(`/api/tables/${t.id}`)).body.columns;
  const k = (n) => `{{${cols.find((c) => c.name === n).key}}}`;
  for (const [fn, extra] of [['hubspot_upsert_contact', {}], ['instantly_add_lead', { campaign_id: 'c-uuid' }], ['smartlead_add_lead', { campaign_id: '123' }]]) {
    const c = await api.post(`/api/tables/${t.id}/columns`, { name: fn, kind: 'enrich', config: { fn, inputs: { email: k('Email'), first_name: k('First name'), company: k('Company'), ...extra } } });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    await api.post(`/api/tables/${t.id}/run`, { column_id: c.body.id });
    await api.post('/api/run-batch');
  }
  assert.deepEqual(seen[0], ['hs-post', 'Bearer hs']);
  assert.deepEqual(seen[1], ['hs-patch', 'PATCH', { properties: { email: 'ana@example.com', firstname: 'Ana', company: 'Example Roofing' } }]);
  assert.deepEqual(seen[2], ['in', 'Bearer in', { campaign: 'c-uuid', email: 'ana@example.com', first_name: 'Ana', company_name: 'Example Roofing' }]);
  assert.equal(seen[3][1], true);
  assert.deepEqual(seen[3][2].lead_list, [{ email: 'ana@example.com', first_name: 'Ana', company_name: 'Example Roofing' }]);
  const row = (await api.get(`/api/tables/${t.id}`)).body.rows[0];
  assert.ok(Object.values(row.data).includes('updated'));
});

test('a price override in Settings becomes the treg cap', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const calls = [];
  const f = fakeTreg({ 'treg.companies.enrich': [200, { name: 'Acme' }, 1900, 'x'] }, calls);
  const api = await client(env, { fetch: f });
  await api.patch('/api/settings', { cost_overrides: { treg_company_enrich: 30_000 } });
  const { t, key } = await tableWith(api, 'Website\nexample.com\n');
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Co', kind: 'enrich', config: { fn: 'treg_company_enrich', inputs: { domain: `{{${key('Website')}}}` } } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  assert.equal(calls[0].cap, '0.0300');
});
