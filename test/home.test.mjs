import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch } from './helpers.mjs';
import { parsePlan } from '../src/assist.js';

test('migrations run once and add favorites, recents and the profile name', async () => {
  const env = fakeEnv(); const api = await client(env);
  assert.equal(env.sql.prepare(`SELECT count(*) AS n FROM d1_migrations`).get().n >= 1, true);
  const t = (await api.post('/api/tables', { name: 'A' })).body;
  await api.patch(`/api/tables/${t.id}`, { favorite: true });
  assert.equal((await api.patch(`/api/tables/${t.id}`, { favorite: 'yes' })).status, 400);
  await api.get(`/api/tables/${t.id}`);
  const boot = (await api.get('/api/bootstrap')).body;
  const row = boot.tables[0];
  assert.equal(row.favorite, 1); assert.ok(row.last_opened_at); assert.equal(row.column_count, 1);
  assert.equal(boot.settings.profile_name, '');
  assert.equal((await api.patch('/api/settings', { profile_name: 'Mert' })).body.profile_name, 'Mert');
});

test('start from template builds the sample with working columns and fictional rows', async () => {
  const env = fakeEnv(); const api = await client(env);
  const s = (await api.post('/api/tables/sample')).body;
  const full = (await api.get(`/api/tables/${s.id}`)).body;
  assert.equal(full.rows.length, 8);
  assert.ok(full.columns.some((c) => c.kind === 'waterfall'));
  assert.ok(full.rows.every((r) => !r.data.website || r.data.website.includes('example.com')));
  assert.ok(!full.columns.some((c) => c.name === 'Name' && c.kind === 'data' && full.columns.filter((x) => x.name === 'Name').length > 1));
});

test('plan parsing keeps only real functions whose inputs map to columns', () => {
  const plan = parsePlan(`<think>hmm</think> Here: {"name":"Tampa roofers","columns":[{"name":"Company","type":"text"},{"name":"Website","type":"url"},{"name":"Company","type":"text"}],
    "enrichments":[{"name":"Email provider","fn":"email_provider","inputs":{"domain":"Website"}},
      {"name":"Evil","fn":"eval","inputs":{}},{"name":"Alive","fn":"domain_alive","inputs":{"domain":"Nope"}},
      {"name":"Site","fn":"website_check","inputs":{"domain":"website"}}],"notes":"Import a CSV"}`);
  assert.deepEqual(plan.columns.map((c) => c.name), ['Company', 'Website']);
  assert.deepEqual(plan.enrichments.map((e) => e.fn), ['email_provider', 'website_check']);
  assert.equal(plan.notes.length, 3);
  assert.throws(() => parsePlan('no json'), /did not return a plan/);
});

test('plan endpoint calls Groq once, ledgers it at $0, and build wires inputs by column key', async () => {
  const f = fakeFetch({ 'api.groq.com': { choices: [{ message: { content: '{"name":"Roofers","columns":[{"name":"Company"},{"name":"Website","type":"url"}],"enrichments":[{"name":"Alive","fn":"domain_alive","inputs":{"domain":"Website"}}]}' } }], usage: { prompt_tokens: 900, completion_tokens: 80 } } });
  const env = fakeEnv(); env.GROQ_API_KEY = 'gk';
  const api = await client(env, { fetch: f });
  const plan = (await api.post('/api/assist/plan', { prompt: 'roofers in Tampa' })).body;
  assert.equal(plan.enrichments[0].fn, 'domain_alive');
  assert.equal(f.calls[0].headers.get('authorization'), 'Bearer gk');
  assert.equal(env.sql.prepare(`SELECT cost_micros FROM ledger WHERE provider='assist:groq'`).get().cost_micros, 0);
  const t = (await api.post('/api/assist/build', { plan })).body;
  const cols = (await api.get(`/api/tables/${t.id}`)).body.columns;
  assert.deepEqual(cols.map((c) => c.name), ['Company', 'Website', 'Alive']);
  assert.deepEqual(cols[2].config.inputs, { domain: '{{website}}' });
});

test('plan endpoint without a Groq key says how to add one', async () => {
  const env = fakeEnv(); const api = await client(env, { fetch: fakeFetch({}) });
  const r = await api.post('/api/assist/plan', { prompt: 'x' });
  assert.equal(r.status, 400); assert.match(r.body.error, /wrangler secret put GROQ_API_KEY/);
});
