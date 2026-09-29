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

test('find a contact at a company: one person per row, limit 1, capped, LinkedIn dropped', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const calls = [];
  const f = fakeTreg({ 'treg.people.search': (b) => (b.company_domain === 'example.com'
    ? [200, { people: [{ name: 'Ana Testrow', title: 'Founder & CEO', linkedin_url: 'https://linkedin.com/in/x' }, { name: 'Ben Testrow', title: 'CEO' }] }, 2000, 'pdl.people.search']
    : [200, { people: [] }, 0, null]) }, calls);
  const api = await client(env, { fetch: f });
  const { t, key } = await tableWith(api, 'Company,Website\nExample,example.com\nNobody,example.org\n');
  const c = await api.post(`/api/tables/${t.id}/columns`, { name: 'Contact', kind: 'enrich', config: { fn: 'treg_find_contact', inputs: { domain: `{{${key('Website')}}}`, title: 'CEO' } } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.body.id });
  await api.post('/api/run-batch');
  const got = (await api.get(`/api/tables/${t.id}`)).body;
  assert.equal(got.rows[0].data[c.body.key], 'Ana Testrow');
  assert.equal(got.rows[1].data[c.body.key], undefined);
  assert.deepEqual(calls[0].body, { company_domain: 'example.com', title: 'CEO', limit: 1 });
  assert.equal(calls[0].cap, '0.0500');
  const stored = env.sql.prepare('SELECT result FROM cells_meta WHERE row_id=? AND column_id=?').get(got.rows[0].id, c.body.id).result;
  assert.ok(!stored.includes('linkedin'));
  assert.equal(JSON.parse(stored).first_name, 'Ana');
});

test('company data: fields treg left null in output are read from raw (live shape, 2026-09-29)', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const f = fakeFetch({ 'treg.to/call/treg.companies.enrich': () => new Response(JSON.stringify({
    output: { name: 'Example', domain: 'example.com', industry: null, description: null, employees: null },
    raw: { about: { industries: ['customer-support', 'sales', 'hr-support', 'recruiting'] }, descriptions: { tagline: 'Short', website: 'Does useful things for teams.' } } }),
  { headers: { 'content-type': 'application/json', 'x-treg-cost-micro': '1900', 'x-treg-served-by': 'thecompaniesapi.companies.enrich' } }) });
  const api = await client(env, { fetch: f });
  const { t, key } = await tableWith(api, 'Company,Website\nExample,example.com\n');
  const ind = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Industry' })).body;
  const desc = (await api.post(`/api/tables/${t.id}/columns`, { name: 'About' })).body;
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Company data', kind: 'enrich', config: { fn: 'treg_company_enrich', inputs: { domain: `{{${key('Website')}}}` },
    outputs: [{ field: 'industry', column: ind.key }, { field: 'description', column: desc.key }] } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const row = (await api.get(`/api/tables/${t.id}`)).body.rows[0].data;
  assert.equal(row[ind.key], 'customer support, sales, hr support');
  assert.equal(row[desc.key], 'Does useful things for teams.');
});

test('email waterfall: a verifier outage is a retryable error, a verifier "no" is a miss with its reason', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  let verify = 503;
  const f = fakeTreg({
    'treg.people.email.find': [200, { email: 'ana@example.com' }, 4834, 'hunter.people.email.find'],
    'treg.people.email.verify': () => (verify === 503 ? [503, { error: 'no capacity' }, 0, null] : [200, { status: 'catch_all' }, 0, 'zerobounce']),
  });
  const api = await client(env, { fetch: f });
  const { t, key } = await tableWith(api, 'Name,Website\nAna Testrow,example.com\n');
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Email', kind: 'waterfall', type: 'email', config: {
    steps: [{ fn: 'treg_email_find', inputs: { full_name: `{{${key('Name')}}}`, domain: `{{${key('Website')}}}` }, enabled: true }],
    validate: { fn: 'treg_email_verify', pass: 'valid' } } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  let meta = (await api.get(`/api/tables/${t.id}`)).body.meta.find((m) => m.column_id === c.id);
  assert.equal(meta.status, 'error');
  assert.match(meta.error, /could not check it \(treg HTTP 503/);
  assert.ok(!meta.error.includes('ana@'));
  verify = 200;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, scope: 'errored' });
  await api.post('/api/run-batch');
  meta = (await api.get(`/api/tables/${t.id}`)).body.meta.find((m) => m.column_id === c.id);
  assert.equal(meta.status, 'no_result');
  assert.match(meta.error, /failed validation \(catch_all\)/);
});

test('AI column: a row with any empty input is skipped and says which; allow_empty runs it', async () => {
  const env = fakeEnv(); env.ANTHROPIC_API_KEY = 'sk-test';
  const prompts = [];
  const f = fakeFetch({ 'api.anthropic.com/v1/messages': (r) => { prompts.push(JSON.parse(r.body).messages[0].content);
    return { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } }; } });
  const api = await client(env, { fetch: f });
  const { t, key } = await tableWith(api, 'Name,About\nAna,Builds things\nBen,\n');
  const cfg = { provider: 'anthropic', model: 'claude-opus-5', max_tokens: 20, prompt: `Hi {{${key('Name')}}}, about {{${key('About')}}}` };
  const strict = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Strict', kind: 'ai', config: cfg })).body;
  const loose = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Loose', kind: 'ai', config: { ...cfg, allow_empty: true } })).body;
  for (const c of [strict, loose]) { await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, budget_micros: 1_000_000 }); await api.post('/api/run-batch'); }
  const got = (await api.get(`/api/tables/${t.id}`)).body;
  const m = (row, c) => got.meta.find((x) => x.row_id === got.rows[row].id && x.column_id === c.id);
  assert.equal(m(0, strict).status, 'done');
  assert.equal(m(1, strict).status, 'skipped');
  assert.equal(m(1, strict).error, 'Some inputs are empty: About');
  assert.equal(m(1, loose).status, 'done');
  assert.equal(prompts.length, 3);
});

test('email waterfall: catch-all ("valid-risky") fails "valid", passes "acceptable" when chosen', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const f = fakeTreg({
    'treg.people.email.find': [200, { email: 'ana@example.com' }, 4834, 'hunter.people.email.find'],
    'treg.people.email.verify': [200, { status: 'valid-risky' }, 0, 'millionverifier'],
  });
  const api = await client(env, { fetch: f });
  const { t, key } = await tableWith(api, 'Name,Website\nAna Testrow,example.com\n');
  const make = async (name, pass) => (await api.post(`/api/tables/${t.id}/columns`, { name, kind: 'waterfall', type: 'email', config: {
    steps: [{ fn: 'treg_email_find', inputs: { full_name: `{{${key('Name')}}}`, domain: `{{${key('Website')}}}` }, enabled: true }],
    validate: { fn: 'treg_email_verify', pass } } })).body;
  const strict = await make('Strict', 'valid'); const risky = await make('Risky ok', 'acceptable');
  for (const c of [strict, risky]) { await api.post(`/api/tables/${t.id}/run`, { column_id: c.id }); await api.post('/api/run-batch'); }
  const got = (await api.get(`/api/tables/${t.id}`)).body;
  assert.equal(got.rows[0].data[strict.key], undefined);
  assert.match(got.meta.find((m) => m.column_id === strict.id).error, /valid-risky/);
  assert.equal(got.rows[0].data[risky.key], 'ana@example.com');
});

test('company data: empty fields are filled by one more provider, excluding the first, inside the same cap', async () => {
  const env = fakeEnv(); env.TREG_TOKEN = 'tok';
  const seen = [];
  const f = fakeFetch({ 'treg.to/call/treg.companies.enrich': (req) => {
    const exclude = req.headers.get('x-treg-route-exclude'); seen.push({ exclude, cap: req.headers.get('x-treg-route-max-cost') });
    const [output, cost, by] = exclude
      ? [{ name: 'Example', industry: 'software', employees: 36, description: null }, 1800, 'dropleads.companies.enrich']
      : [{ name: 'Example', industry: null, employees: null, description: 'Does things' }, 1900, 'thecompaniesapi.companies.enrich'];
    return new Response(JSON.stringify({ output, raw: {} }), { headers: { 'content-type': 'application/json', 'x-treg-cost-micro': String(cost), 'x-treg-served-by': by } });
  } });
  const api = await client(env, { fetch: f });
  const { t, key } = await tableWith(api, 'Company,Website\nExample,example.com\n');
  const emp = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Employees', type: 'number' })).body;
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Company data', kind: 'enrich', config: { fn: 'treg_company_enrich', inputs: { domain: `{{${key('Website')}}}` },
    outputs: [{ field: 'employees', column: emp.key }] } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.rows[0].data[emp.key], 36);
  assert.deepEqual(seen, [{ exclude: null, cap: '0.0100' }, { exclude: 'thecompaniesapi', cap: '0.0081' }]);
  const stored = JSON.parse(env.sql.prepare('SELECT result FROM cells_meta WHERE column_id=?').get(c.id).result);
  assert.equal(stored.description, 'Does things');                     // the first answer's fields stand
  assert.equal(stored.found_by, 'thecompaniesapi + dropleads');
  assert.equal(env.sql.prepare('SELECT sum(cost_micros) c FROM ledger WHERE column_id=?').get(c.id).c, 3700);
});
