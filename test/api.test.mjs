import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.js';
import { fakeEnv, client } from './helpers.mjs';

test('the API is locked without a session', async () => {
  const env = fakeEnv();
  const r = await handle(new Request('https://clay.test/api/bootstrap'), env);
  assert.equal(r.status, 401);
});

test('a wrong password is refused and counted', async () => {
  const env = fakeEnv();
  const r = await handle(new Request('https://clay.test/api/login', { method: 'POST', body: JSON.stringify({ password: 'nope' }) }), env);
  assert.equal(r.status, 401);
  assert.equal(env.sql.prepare('SELECT count(*) AS n FROM login_failures').get().n, 1);
});

test('no APP_PASSWORD means a clear setup error, not an open door', async () => {
  const env = fakeEnv(); delete env.APP_PASSWORD;
  const r = await handle(new Request('https://clay.test/api/bootstrap'), env);
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /wrangler secret put APP_PASSWORD/);
});

test('bootstrap returns defaults: auto-run off and a $1 budget cap', async () => {
  const api = await client(fakeEnv());
  const { status, body } = await api.get('/api/bootstrap');
  assert.equal(status, 200);
  assert.equal(body.settings.auto_run, false);
  assert.equal(body.settings.default_budget_micros, 1_000_000);
  assert.deepEqual(body.tables, []);
});

test('settings are validated', async () => {
  const api = await client(fakeEnv());
  assert.equal((await api.patch('/api/settings', { auto_run: 'yes' })).status, 400);
  assert.equal((await api.patch('/api/settings', { nope: 1 })).status, 400);
  const ok = await api.patch('/api/settings', { default_budget_micros: 250000 });
  assert.equal(ok.body.default_budget_micros, 250000);
});

test('bootstrap says whether a named secret is set, never its value', async () => {
  const env = fakeEnv(); env.HUNTER_API_KEY = 'secret-value';
  env.sql.exec(`INSERT INTO secrets_index (name, created_at) VALUES ('HUNTER_API_KEY','x'),('EXA_API_KEY','x')`);
  const api = await client(env);
  const { body } = await api.get('/api/bootstrap');
  assert.deepEqual(body.secrets.map((s) => [s.name, s.set]), [['EXA_API_KEY', false], ['HUNTER_API_KEY', true]]);
  assert.ok(!JSON.stringify(body).includes('secret-value'));
});
