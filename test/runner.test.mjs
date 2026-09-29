import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch, dns, html } from './helpers.mjs';
import { processBatch, MAX_FETCHES, MAX_HEAVY } from '../src/runner.js';
import { scheduled } from '../src/index.js';
import { register } from '../src/functions/index.js';

// A metered function for budget tests. It never leaves the process: its "provider" is the fake fetch.
register({
  id: 'test_paid', name: 'Paid test', blurb: '', secret: 'TEST_KEY', costMicros: 400_000, subrequests: 1,
  inputs: [{ key: 'q', label: 'Query', required: true }], outputs: [{ key: 'v', label: 'V', type: 'text' }], primary: 'v', type: 'text',
  async run({ q }, { fetch, secret }) {
    const r = await fetch('https://paid.test/?key=' + secret('TEST_KEY') + '&q=' + encodeURIComponent(q));
    return { status: 'done', data: { v: (await r.json()).v } };
  },
});

const alive = () => fakeFetch({ 'cloudflare-dns.com': (r) => (r.url.includes('dead') ? dns([], 3) : dns([[1, '10.0.0.1']])) });

async function setup(domains, fetch = alive()) {
  const env = fakeEnv();
  const api = await client(env, { fetch });
  const t = (await api.post('/api/tables', { name: 'T' })).body;
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Website', type: 'url' });
  await api.post(`/api/tables/${t.id}/rows`, { rows: domains.map((d) => ({ name: d, website: d })) });
  return { env, api, t, fetch };
}

const col = async (api, t, cfg, name = 'Alive') =>
  (await api.post(`/api/tables/${t.id}/columns`, { name, kind: 'enrich', type: 'checkbox', config: cfg })).body;

test('enrichment config is checked: unknown function and missing required input are refused', async () => {
  const { api, t } = await setup([]);
  assert.equal((await api.post(`/api/tables/${t.id}/columns`, { name: 'x', kind: 'enrich', config: { fn: 'nope' } })).status, 400);
  const r = await api.post(`/api/tables/${t.id}/columns`, { name: 'x', kind: 'enrich', config: { fn: 'domain_alive', inputs: {} } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Domain or URL/);
});

test('run -> queue -> batch -> values, statuses and a ledger line per call', async () => {
  const { env, api, t, fetch } = await setup(['acme.example.com', 'dead.example.com']);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  const run = (await api.post(`/api/tables/${t.id}/run`, { column_id: c.id })).body;
  assert.equal(run.queued, 2);
  assert.equal(run.est_micros, 0);
  let full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.deepEqual(full.meta.map((m) => m.status), ['queued', 'queued']);
  const rep = (await api.post('/api/run-batch')).body;
  assert.equal(rep.claimed, 2); assert.equal(rep.done, 2); assert.equal(rep.remaining, 0);
  full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.deepEqual(full.rows.map((r) => r.data.alive), [true, false]);
  assert.deepEqual(full.meta.map((m) => [m.status, m.provider]), [['done', 'domain_alive'], ['done', 'domain_alive']]);
  assert.equal(env.sql.prepare('SELECT count(*) AS n FROM ledger').get().n, 2);
  assert.equal(env.sql.prepare(`SELECT status FROM runs`).get().status, 'done');
  assert.equal(fetch.calls.length, 2);
});

test('"empty" scope skips rows that already have a value; "all" re-runs them', async () => {
  const { api, t } = await setup(['a.example.com', 'b.example.com']);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  assert.equal((await api.post(`/api/tables/${t.id}/run`, { column_id: c.id })).body.queued, 0);
  assert.equal((await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, scope: 'all' })).body.queued, 2);
  // Clicking Run twice never double-queues a cell.
  assert.equal((await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, scope: 'all' })).body.queued, 0);
});

test('outputs write into their own columns; missing inputs are skipped, not billed', async () => {
  const { env, api, t } = await setup(['acme.example.com']);
  await api.post(`/api/tables/${t.id}/rows`, { data: { name: 'no site' } });
  const ips = (await api.post(`/api/tables/${t.id}/columns`, { name: 'IPs' })).body;
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' }, outputs: [{ field: 'ips', column: ips.key }] });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.equal(full.rows[0].data.ips, '10.0.0.1');
  const skipped = full.meta.find((m) => m.row_id === full.rows[1].id);
  assert.equal(skipped.status, 'skipped');
  assert.match(skipped.error, /Missing input/);
  assert.equal(env.sql.prepare('SELECT count(*) AS n FROM ledger').get().n, 1);
});

test('a provider failure is an error cell carrying the message; "errored" scope re-runs only those', async () => {
  const f = fakeFetch({ 'cloudflare-dns.com': (r) => (r.url.includes('bad') ? new Error('socket hang up') : dns([[1, '1.1.1.1']])), 'dns.google': new Error('also down') });
  const { api, t } = await setup(['ok.example.com', 'bad.example.com'], f);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  const rep = (await api.post('/api/run-batch')).body;
  assert.equal(rep.error, 1);
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  const err = full.meta.find((m) => m.status === 'error');
  assert.match(err.error, /DNS lookup failed: also down/);
  assert.equal((await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, scope: 'errored' })).body.queued, 1);
});

test('a batch never plans more fetches than the free plan allows, and caps HTML-parsing jobs', async () => {
  const many = Array.from({ length: 60 }, (_, i) => `s${i}.example.com`);
  const { env, api, t } = await setup(many);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  const rep = await processBatch(env, { fetch: alive() });
  assert.equal(rep.claimed, MAX_FETCHES / 2);            // domain_alive plans 2 fetches (DoH + fallback)
  const w = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Site', kind: 'enrich', type: 'select', config: { fn: 'website_check', inputs: { domain: '{{website}}' } } })).body;
  await processBatch(env, { fetch: alive() }); await processBatch(env, { fetch: alive() });
  await api.post(`/api/tables/${t.id}/run`, { column_id: w.id });
  const rep2 = await processBatch(env, { fetch: fakeFetch({ 'https://': html('<title>x</title>') }) });
  assert.equal(rep2.claimed, MAX_HEAVY);
});

test('one batch stays under the 50 D1 queries a free Worker invocation allows', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `q${i}.example.com`);
  const { env, api, t } = await setup(many);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  env.DB.resetQueries();
  const rep = await processBatch(env, { fetch: alive() });
  assert.ok(rep.claimed >= 20);
  assert.ok(env.DB.queries <= 50, `used ${env.DB.queries} queries`);
});

test('two drains at once never run the same cell (claim token)', async () => {
  const many = Array.from({ length: 10 }, (_, i) => `c${i}.example.com`);
  const f = alive();
  const { env, api, t } = await setup(many, f);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  const [a, b] = await Promise.all([processBatch(env, { fetch: f }), processBatch(env, { fetch: f })]);
  assert.equal(a.claimed + b.claimed, 10);
  assert.equal(f.calls.length, 10);
  assert.equal(env.sql.prepare('SELECT count(*) AS n FROM ledger').get().n, 10);
});

test('the budget cap stops a metered run before it overspends', async () => {
  const f = fakeFetch({ 'paid.test': { v: 'ok' } });
  const { env, api, t } = await setup(['a', 'b', 'c', 'd', 'e'].map((x) => `${x}.example.com`), f);
  env.TEST_KEY = 'k';
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Paid', kind: 'enrich', config: { fn: 'test_paid', inputs: { q: '{{website}}' } } })).body;
  const run = (await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, budget_micros: 1_000_000 })).body;
  assert.equal(run.est_micros, 2_000_000);
  const rep = (await api.post('/api/run-batch')).body;
  assert.equal(rep.claimed, 2);
  assert.equal(rep.over_budget, 3);
  assert.equal(f.calls.length, 2);
  const spent = env.sql.prepare('SELECT sum(cost_micros) AS s FROM ledger').get().s;
  assert.equal(spent, 800_000);
  const r = env.sql.prepare('SELECT status, spent_micros FROM runs').get();
  assert.deepEqual([r.status, r.spent_micros], ['over_budget', 800_000]);
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.equal(full.meta.filter((m) => m.status === 'skipped' && /budget/.test(m.error)).length, 3);
  assert.equal((await api.post('/api/run-batch')).body.claimed, 0);
});

test('a zero budget runs free functions but no metered ones', async () => {
  const f = fakeFetch({ 'paid.test': { v: 'ok' }, 'cloudflare-dns.com': dns([[1, '1.1.1.1']]) });
  const { env, api, t } = await setup(['a.example.com'], f);
  env.TEST_KEY = 'k';
  const free = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  const paid = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Paid', kind: 'enrich', config: { fn: 'test_paid', inputs: { q: '{{website}}' } } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: free.id, budget_micros: 0 });
  await api.post(`/api/tables/${t.id}/run`, { column_id: paid.id, budget_micros: 0 });
  await api.post('/api/run-batch');
  assert.equal(f.calls.filter((c) => c.url.includes('paid.test')).length, 0);
  assert.equal(f.calls.filter((c) => c.url.includes('dns')).length, 1);
});

test('a missing key is a readable error with the command to fix it', async () => {
  const { api, t } = await setup(['a.example.com'], fakeFetch({ 'paid.test': { v: 'x' } }));
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Paid', kind: 'enrich', config: { fn: 'test_paid', inputs: { q: '{{website}}' } } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const m = (await api.get(`/api/tables/${t.id}`)).body.meta[0];
  assert.equal(m.status, 'error');
  assert.match(m.error, /wrangler secret put TEST_KEY/);
});

test('Stop cancels what is still queued and clears those cells', async () => {
  const { env, api, t } = await setup(['a.example.com', 'b.example.com']);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  const run = (await api.post(`/api/tables/${t.id}/run`, { column_id: c.id })).body;
  await api.post(`/api/runs/${run.run_id}/stop`);
  assert.equal((await api.post('/api/run-batch')).body.claimed, 0);
  assert.equal(env.sql.prepare('SELECT count(*) AS n FROM cells_meta').get().n, 0);
  assert.equal(env.sql.prepare('SELECT status FROM runs').get().status, 'stopped');
});

test('a job lost with its Worker goes back on the queue after 5 minutes', async () => {
  const { env, api, t } = await setup(['a.example.com']);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  env.sql.exec(`UPDATE cell_jobs SET status='running', claim='dead', claimed_at='2026-01-01T00:00:00.000Z'`);
  const rep = await processBatch(env, { fetch: alive() });
  assert.equal(rep.done, 1);
});

test('the cron drains the queue with no browser open', async () => {
  const { env, api, t } = await setup(['a.example.com']);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  // Whatever minute it is, the cells queue runs: the queues before it in the turn order are empty.
  const rep = await scheduled({}, env, {}, { fetch: alive() });
  assert.equal(rep.cells.done, 1);
});

test('changes endpoint returns only what moved since the last poll', async () => {
  const { api, t } = await setup(['a.example.com']);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  const first = (await api.get(`/api/tables/${t.id}/changes?since=1970`)).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const ch = (await api.get(`/api/tables/${t.id}/changes?since=${encodeURIComponent(first.now)}`)).body;
  assert.equal(ch.rows.length, 1);
  assert.equal(ch.rows[0].data.alive, true);
  assert.equal(ch.meta[0].status, 'done');
});

test('adding an output after a run fills the new column from stored results, no re-run', async () => {
  const f = alive();
  const { api, t } = await setup(['acme.example.com'], f);
  const c = await col(api, t, { fn: 'domain_alive', inputs: { domain: '{{website}}' } });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const r = (await api.post(`/api/columns/${c.id}/outputs`, { field: 'ips' })).body;
  assert.equal(r.column.name, 'IP addresses');
  assert.deepEqual(r.source.config.outputs, [{ field: 'ips', column: r.column.key }]);
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.equal(full.rows[0].data[r.column.key], '10.0.0.1');
  assert.equal(f.calls.length, 1);
  assert.equal((await api.post(`/api/columns/${c.id}/outputs`, { field: 'ips' })).status, 409);   // no orphan twin
});

test('the function catalog never ships run code', async () => {
  const { api } = await setup([]);
  const list = (await api.get('/api/functions')).body;
  assert.ok(list.find((f) => f.id === 'email_check'));
  assert.ok(list.every((f) => !('run' in f)));
});
