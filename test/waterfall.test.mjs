import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch, dns } from './helpers.mjs';
import { register } from '../src/functions/index.js';

// Three fake finders. Each asks its own fake host; the route decides hit, miss or failure.
const finder = (id, cost) => ({
  id, name: id.toUpperCase(), blurb: '', costMicros: cost, subrequests: 1, secret: null,
  inputs: [{ key: 'domain', label: 'Domain', required: true }], outputs: [{ key: 'email', label: 'Email', type: 'email' }, { key: 'score', label: 'Score', type: 'number' }],
  primary: 'email', type: 'email',
  async run({ domain }, { fetch }) {
    const r = await fetch(`https://${id}.test/?d=${domain}`);
    if (!r.ok) throw new Error(`${id} HTTP ${r.status}`);
    const j = await r.json();
    return j.email ? { status: 'done', data: j } : { status: 'no_result', data: {} };
  },
});
register(finder('wf_a', 1000), finder('wf_b', 2000), finder('wf_c', 3000), { ...finder('wf_big', 0), id: 'wf_big', subrequests: 6 });

const ok = (email, score = 90) => ({ email, score });
const status = (n) => new Response('{}', { status: n, headers: { 'content-type': 'application/json' } });
const mxOk = dns([[15, '10 aspmx.l.google.com.']]);

async function setup(routes) {
  const f = fakeFetch(routes);
  const env = fakeEnv(); const api = await client(env, { fetch: f });
  const t = (await api.post('/api/tables', { name: 'W' })).body;
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Domain' });
  await api.post(`/api/tables/${t.id}/rows`, { data: { name: 'Acme', domain: 'acme.example.com' } });
  const wf = async (config) => (await api.post(`/api/tables/${t.id}/columns`, { name: 'Work email', kind: 'waterfall', type: 'email', config })).body;
  const run = async (c) => { await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, scope: 'all' }); return (await api.post('/api/run-batch')).body; };
  const table = async () => (await api.get(`/api/tables/${t.id}`)).body;
  return { env, api, t, f, wf, run, table };
}

const step = (fn, enabled = true) => ({ fn, inputs: { domain: '{{domain}}' }, enabled });

test('stops at the first provider with a result and never calls the rest', async () => {
  const s = await setup({ 'wf_a.test': {}, 'wf_b.test': ok('ann@acme.example.com'), 'wf_c.test': ok('zzz@acme.example.com') });
  const c = await s.wf({ steps: [step('wf_a'), step('wf_b'), step('wf_c')] });
  await s.run(c);
  const t = await s.table();
  assert.equal(t.rows[0].data.work_email, 'ann@acme.example.com');
  assert.equal(t.meta[0].provider, 'wf_b');
  assert.deepEqual(s.f.calls.map((x) => new URL(x.url).host), ['wf_a.test', 'wf_b.test']);
  const ledger = s.env.sql.prepare('SELECT provider, cost_micros, outcome FROM ledger ORDER BY id').all();
  assert.deepEqual(ledger.map((l) => [l.provider, l.cost_micros, l.outcome]), [['wf_a', 1000, 'no_result'], ['wf_b', 2000, 'done']]);
});

test('a candidate that fails validation moves the waterfall on', async () => {
  const s = await setup({
    'wf_a.test': ok('bob@nomx.example.com'), 'wf_b.test': ok('ann@acme.example.com'),
    'cloudflare-dns.com': (r) => (r.url.includes('nomx') ? dns([], 3) : mxOk),
  });
  const c = await s.wf({ steps: [step('wf_a'), step('wf_b')], validate: { fn: 'email_check', pass: 'valid' } });
  await s.run(c);
  const t = await s.table();
  assert.equal(t.rows[0].data.work_email, 'ann@acme.example.com');
  assert.equal(t.meta[0].provider, 'wf_b');
  const providers = s.env.sql.prepare('SELECT provider FROM ledger ORDER BY id').all().map((l) => l.provider);
  assert.deepEqual(providers, ['wf_a', 'email_check', 'wf_b', 'email_check']);
});

test('switched-off steps are skipped and the winner can be written to its own column', async () => {
  const s = await setup({ 'wf_a.test': ok('a@acme.example.com'), 'wf_b.test': ok('b@acme.example.com', 55) });
  const prov = (await s.api.post(`/api/tables/${s.t.id}/columns`, { name: 'Found by' })).body;
  const score = (await s.api.post(`/api/tables/${s.t.id}/columns`, { name: 'Score', type: 'number' })).body;
  const c = await s.wf({ steps: [step('wf_a', false), step('wf_b')], provider_column: prov.key, outputs: [{ field: 'score', column: score.key }] });
  await s.run(c);
  const row = (await s.table()).rows[0].data;
  assert.equal(row.work_email, 'b@acme.example.com');
  assert.equal(row.found_by, 'WF_B');
  assert.equal(row.score, 55);
  assert.ok(!s.f.calls.some((x) => x.url.includes('wf_a')));
});

test('all providers missing is "no result" with what each said; all failing is an error', async () => {
  const s = await setup({ 'wf_a.test': {}, 'wf_b.test': status(429) });
  const c = await s.wf({ steps: [step('wf_a'), step('wf_b')] });
  await s.run(c);
  let m = (await s.table()).meta[0];
  assert.equal(m.status, 'no_result');
  assert.match(m.error, /WF_A: no_result; WF_B: wf_b HTTP 429/);
  const s2 = await setup({ 'wf_a.test': status(500), 'wf_b.test': status(401) });
  const c2 = await s2.wf({ steps: [step('wf_a'), step('wf_b')] });
  await s2.run(c2);
  m = (await s2.table()).meta[0];
  assert.equal(m.status, 'error');
});

test('a run reserves the worst case (every step plus validation) against the budget', async () => {
  const s = await setup({ 'wf_a.test': {} });
  const c = await s.wf({ steps: [step('wf_a'), step('wf_b'), step('wf_c')] });
  const r = (await s.api.post(`/api/tables/${s.t.id}/run`, { column_id: c.id, budget_micros: 5_999 })).body;
  assert.equal(r.per_cell_micros, 6000);
  const rep = (await s.api.post('/api/run-batch')).body;
  assert.equal(rep.over_budget, 1);
  assert.equal(s.f.calls.length, 0);
});

test('reordering steps changes who is asked first', async () => {
  const s = await setup({ 'wf_a.test': ok('a@acme.example.com'), 'wf_b.test': ok('b@acme.example.com') });
  const c = await s.wf({ steps: [step('wf_a'), step('wf_b')] });
  await s.api.patch(`/api/columns/${c.id}`, { config: { ...c.config, steps: [step('wf_b'), step('wf_a')] } });
  await s.run(c);
  assert.equal((await s.table()).rows[0].data.work_email, 'b@acme.example.com');
});

test('waterfall config is checked', async () => {
  const s = await setup({});
  const post = (config) => s.api.post(`/api/tables/${s.t.id}/columns`, { name: 'x', kind: 'waterfall', config });
  assert.equal((await post({ steps: [] })).status, 400);
  assert.equal((await post({ steps: [step('nope')] })).status, 400);
  assert.equal((await post({ steps: [step('wf_a', false)] })).status, 400);
  assert.equal((await post({ steps: [step('wf_a')], validate: { fn: 'domain_alive' } })).status, 400);
  const nine = Array.from({ length: 9 }, () => step('wf_a'));
  assert.equal((await post({ steps: nine })).status, 400);
  const tooMany = Array.from({ length: 6 }, () => step('wf_big'));   // 6 x (6 + 2 validation) = 48 > 40
  const r = await post({ steps: tooMany, validate: { fn: 'email_check', pass: 'valid' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /fetches per row/);
});
