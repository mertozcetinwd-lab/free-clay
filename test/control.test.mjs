import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.js';
import { fakeEnv, client, fakeFetch, dns } from './helpers.mjs';
import { hmacHex } from '../src/webhooks.js';

const alive = () => fakeFetch({ 'cloudflare-dns.com': dns([[1, '1.1.1.1']]) });

async function setup(fetch = alive()) {
  const env = fakeEnv(); const api = await client(env, { fetch });
  const t = (await api.post('/api/tables', { name: 'C' })).body;
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Website', type: 'url' });
  await api.post(`/api/tables/${t.id}/columns`, { name: 'City' });
  const jobs = () => env.sql.prepare('SELECT count(*) AS n FROM cell_jobs').get().n;
  return { env, api, t, fetch, jobs };
}

const autoCol = (api, t, extra = {}) => api.post(`/api/tables/${t.id}/columns`, { name: 'Alive', kind: 'enrich', type: 'checkbox',
  config: { fn: 'domain_alive', inputs: { domain: '{{website}}' }, auto: true, ...extra } }).then((r) => r.body);

test('auto-run is off by default: edits and imports queue nothing', async () => {
  const { api, t, jobs } = await setup();
  await autoCol(api, t);
  const row = (await api.post(`/api/tables/${t.id}/rows`, { data: { website: 'a.example.com' } })).body.rows[0];
  await api.patch(`/api/rows/${row.id}`, { data: { website: 'b.example.com' } });
  await api.post(`/api/tables/${t.id}/import`, 'Website\nc.example.com\n');
  assert.equal(jobs(), 0);
});

test('auto-run on: new rows and changed inputs queue; unrelated edits and run results do not', async () => {
  const { api, t, jobs } = await setup();
  await api.patch('/api/settings', { auto_run: true });
  await autoCol(api, t);
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Manual', kind: 'enrich', config: { fn: 'domain_alive', inputs: { domain: '{{website}}' } } });
  const row = (await api.post(`/api/tables/${t.id}/rows`, { data: { website: 'a.example.com' } })).body.rows[0];
  assert.equal(jobs(), 1);                                      // the auto column only
  await api.post('/api/run-batch');                             // its result must not re-trigger
  assert.equal(jobs(), 1);
  await api.patch(`/api/rows/${row.id}`, { data: { city: 'Tampa' } });
  assert.equal(jobs(), 1);
  await api.patch(`/api/rows/${row.id}`, { data: { website: 'b.example.com' } });
  assert.equal(jobs(), 2);
});

test('auto-run follows formulas: editing a formula input re-runs a column that reads the formula', async () => {
  const { api, t, jobs } = await setup();
  await api.patch('/api/settings', { auto_run: true });
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Domain', kind: 'formula', config: { formula: 'DOMAIN({{website}})' } });
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Alive', kind: 'enrich', type: 'checkbox', config: { fn: 'domain_alive', inputs: { domain: '{{domain}}' }, auto: true } });
  const row = (await api.post(`/api/tables/${t.id}/rows`, { data: { website: 'a.example.com' } })).body.rows[0];
  await api.post('/api/run-batch');
  await api.patch(`/api/rows/${row.id}`, { data: { website: 'https://b.example.com' } });
  assert.equal(jobs(), 2);
});

/* ---------------------------------------------------------------- webhook in */

const hook = async (env, tid, body, secret) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = secret ? { 'x-signature': 'sha256=' + await hmacHex(secret, raw) } : {};
  const r = await handle(new Request(`https://clay.test/api/hook/${tid}`, { method: 'POST', headers, body: raw }), env);
  return { status: r.status, body: await r.json() };
};

test('webhook in: off, unsigned and wrongly signed requests are all refused alike', async () => {
  const { env, api, t } = await setup();
  assert.equal((await hook(env, t.id, { website: 'x.example.com' }, 'guess')).status, 401);
  const on = (await api.post(`/api/tables/${t.id}/webhook`, {})).body;
  assert.match(on.secret, /^whsec_[0-9a-f]{48}$/);
  assert.equal((await hook(env, t.id, { website: 'x.example.com' })).status, 401);
  assert.equal((await hook(env, t.id, { website: 'x.example.com' }, 'whsec_wrong')).status, 401);
  assert.equal(env.sql.prepare('SELECT count(*) AS n FROM rows').get().n, 0);
});

test('webhook in: a signed list becomes rows, fields matched by name or alias, extras reported', async () => {
  const { env, api, t } = await setup();
  const { secret } = (await api.post(`/api/tables/${t.id}/webhook`, {})).body;
  const r = await hook(env, t.id, [{ 'Company Website': 'a.example.com', city: 'Tampa', favourite_color: 'red' }, { website: 'b.example.com' }], secret);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { added: 2, ignored_fields: ['favourite_color'] });
  const rows = (await api.get(`/api/tables/${t.id}`)).body.rows;
  assert.deepEqual(rows.map((x) => x.data), [{ website: 'a.example.com', city: 'Tampa' }, { website: 'b.example.com' }]);
  assert.equal((await hook(env, t.id, Array(501).fill({ city: 'x' }), secret)).status, 400);
  await api.post(`/api/tables/${t.id}/webhook`, { enabled: false });
  assert.equal((await hook(env, t.id, { city: 'y' }, secret)).status, 401);
  // Rotating makes a new secret; the old one stops working.
  const again = (await api.post(`/api/tables/${t.id}/webhook`, {})).body;
  assert.notEqual(again.secret, secret);
});

/* ---------------------------------------------------------------- webhook out */

test('webhook out posts the row with formulas, signed when asked', async () => {
  const f = fakeFetch({ 'hooks.example.com': { ok: true } });
  const { env, api, t } = await setup(f);
  env.OUT_SECRET = 'shh';
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Domain', kind: 'formula', config: { formula: 'DOMAIN({{website}})' } });
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Sent', kind: 'enrich', config: { fn: 'send_to_webhook', inputs: { url: 'https://hooks.example.com/in', signing_secret: 'OUT_SECRET' } } })).body;
  await api.post(`/api/tables/${t.id}/rows`, { data: { website: 'https://www.acme.example.com', city: 'Tampa' } });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const sent = f.calls[0];
  const body = JSON.parse(sent.body);
  assert.deepEqual(body.data, { website: 'https://www.acme.example.com', city: 'Tampa', domain: 'acme.example.com' });
  assert.equal(sent.headers.get('x-signature'), 'sha256=' + await hmacHex('shh', sent.body));
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.rows[0].data.sent, 'sent (200)');
});

/* ---------------------------------------------------------------- costs, spend, prices */

test('cost footer and spend report add up the ledger', async () => {
  const { env, api, t } = await setup();
  env.sql.exec(`INSERT INTO ledger (ts, table_id, provider, cost_micros, outcome) VALUES
    ('2026-09-01T00:00:00Z', ${t.id}, 'exa_search', 7000, 'done'), ('2026-09-02T00:00:00Z', ${t.id}, 'exa_search', 6000, 'no_result'),
    ('2026-08-30T00:00:00Z', ${t.id}, 'hunter_email_finder', 0, 'done')`);
  const now = new Date();
  if (now.toISOString().slice(0, 7) !== '2026-09') env.sql.exec(`UPDATE ledger SET ts = '${now.toISOString().slice(0, 7)}' || substr(ts, 8) WHERE ts LIKE '2026-09%'`);
  const c = (await api.get(`/api/tables/${t.id}/costs`)).body;
  assert.equal(c.month_table_micros, 13000);
  assert.equal(c.month_table_calls, 2);
  const s = (await api.get('/api/spend')).body;
  assert.deepEqual(s.by_provider.map((p) => [p.provider, p.calls, p.micros, p.hits]), [['exa_search', 2, 13000, 1]]);
  assert.equal(s.recent.length, 3);
});

test('your own price per function drives estimates and budgets', async () => {
  const { api, t } = await setup();
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'H', kind: 'enrich', config: { fn: 'hunter_email_finder', inputs: { first_name: 'a', last_name: 'b', domain: '{{website}}' } } })).body;
  await api.post(`/api/tables/${t.id}/rows`, { data: { website: 'a.example.com' } });
  assert.equal((await api.patch('/api/settings', { cost_overrides: { hunter_email_finder: 1.5 } })).status, 400);
  await api.patch('/api/settings', { cost_overrides: { hunter_email_finder: 40_000 } });
  const r = (await api.post(`/api/tables/${t.id}/run`, { column_id: c.id, budget_micros: 30_000 })).body;
  assert.equal(r.per_cell_micros, 40_000);
  assert.equal((await api.post('/api/run-batch')).body.over_budget, 1);
});
