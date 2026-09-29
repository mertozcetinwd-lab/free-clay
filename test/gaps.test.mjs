// Tests added after the mutation run (dev/mutate.mjs) found bugs the suite let through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch, html, dns } from './helpers.mjs';
import { processBatch, secretValue } from '../src/runner.js';
import { register } from '../src/functions/index.js';
import { fill } from '../public/js/template.js';
import { find_contact_info } from '../src/functions/free.js';

test('a drain never re-claims cells another drain is still running', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const slow = async () => { calls++; await gate; return new Response(JSON.stringify(dns([[1, '1.1.1.1']])), { headers: { 'content-type': 'application/json' } }); };
  const env = fakeEnv(); const api = await client(env);
  const t = (await api.post('/api/tables', { name: 'T' })).body;
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Website' });
  await api.post(`/api/tables/${t.id}/rows`, { rows: [{ website: 'a.example.com' }, { website: 'b.example.com' }] });
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Alive', kind: 'enrich', type: 'checkbox', config: { fn: 'domain_alive', inputs: { domain: '{{website}}' } } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  const first = processBatch(env, { fetch: slow });
  await new Promise((r) => setTimeout(r, 20));        // first drain is now waiting on its fetches
  const second = await processBatch(env, { fetch: slow });
  assert.equal(second.claimed, 0);
  release();
  assert.equal((await first).done, 2);
  assert.equal(calls, 2);
});

test('the app password and bindings can never be read as keys', () => {
  const env = { APP_PASSWORD: 'pw', DB: {}, HUNTER_API_KEY: 'k' };
  assert.throws(() => secretValue(env, 'APP_PASSWORD'), /cannot be used/);
  assert.throws(() => secretValue(env, 'DB'), /cannot be used/);
  assert.throws(() => secretValue(env, 'lowercase'), /cannot be used/);
  assert.equal(secretValue(env, 'HUNTER_API_KEY'), 'k');
});

register({ id: 'wf_empty', name: 'Empty', blurb: '', costMicros: 0, subrequests: 0, inputs: [{ key: 'd', label: 'D', required: true }],
  outputs: [{ key: 'email', label: 'Email', type: 'email' }], primary: 'email', type: 'email', run: async () => ({ status: 'done', data: { email: '' } }) });
register({ id: 'wf_hit', name: 'Hit', blurb: '', costMicros: 0, subrequests: 0, inputs: [{ key: 'd', label: 'D', required: true }],
  outputs: [{ key: 'email', label: 'Email', type: 'email' }], primary: 'email', type: 'email', run: async () => ({ status: 'done', data: { email: 'hit@acme.example.com' } }) });

test('a waterfall step that "succeeds" with an empty value does not stop the waterfall', async () => {
  const env = fakeEnv(); const api = await client(env, { fetch: fakeFetch({}) });
  const t = (await api.post('/api/tables', { name: 'T' })).body;
  await api.post(`/api/tables/${t.id}/rows`, { data: { name: 'x' } });
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Email', kind: 'waterfall', type: 'email', config: { steps: [
    { fn: 'wf_empty', inputs: { d: '{{name}}' } }, { fn: 'wf_hit', inputs: { d: '{{name}}' } }] } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.equal(full.rows[0].data.email, 'hit@acme.example.com');
  assert.equal(full.meta[0].provider, 'wf_hit');
});

test('templates never read the prototype', () => {
  assert.equal(fill('{{constructor}}', {}, { encode: fill.raw }), null);
  assert.equal(fill('x{{toString}}y', {}), 'xy');
  assert.equal(fill('{{name}}', { name: 'Acme' }, { encode: fill.raw }), 'Acme');
});

test('the contact finder stops at the homepage when it already found an email', async () => {
  const f = fakeFetch({ 'https://acme.example.com': html('<a href="mailto:office@acme.example.com">x</a> <a href="/contact">Contact</a>') });
  const r = await find_contact_info.run({ domain: 'acme.example.com' }, { fetch: f });
  assert.equal(r.data.email, 'office@acme.example.com');
  assert.equal(f.calls.length, 1);
});

test('claim race: a drain that picked candidates before another claimed them cannot steal them', async () => {
  // Forces the one interleaving where the claim's status='queued' guard is all that stands
  // between a cell and a second provider call: B reads the queue, A claims and starts running,
  // then B tries to claim what it read.
  let release; const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const slow = async () => { calls++; await gate; return new Response(JSON.stringify(dns([[1, '1.1.1.1']])), { headers: { 'content-type': 'application/json' } }); };
  const env = fakeEnv(); const api = await client(env);
  const t = (await api.post('/api/tables', { name: 'T' })).body;
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Website' });
  await api.post(`/api/tables/${t.id}/rows`, { rows: [{ website: 'a.example.com' }, { website: 'b.example.com' }] });
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Alive', kind: 'enrich', type: 'checkbox', config: { fn: 'domain_alive', inputs: { domain: '{{website}}' } } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });

  let aRunning; const aClaimed = new Promise((r) => { aRunning = r; });
  const wrap = (onPrepare) => ({ ...env, DB: { ...env.DB, batch: env.DB.batch, prepare: (text) => onPrepare(text, env.DB.prepare(text)) } });
  const envA = wrap((text, stmt) => {
    if (!/WHERE j\.claim=\?1/.test(text)) return stmt;
    const all = stmt.all; stmt.all = async () => { const r = await all(); aRunning(); return r; };
    return stmt;
  });
  const envB = wrap((text, stmt) => {
    if (!/JOIN columns c ON c\.id=j\.column_id WHERE j\.status='queued'/.test(text)) return stmt;
    const all = stmt.all; stmt.all = async () => { const r = await all(); await aClaimed; return r; };
    return stmt;
  });
  const b = processBatch(envB, { fetch: slow });       // B reads the queue first, then waits
  await new Promise((r) => setTimeout(r, 10));
  const a = processBatch(envA, { fetch: slow });       // A claims and starts its (blocked) calls
  const rb = await b;
  release();
  const ra = await a;
  assert.equal(ra.claimed, 2);
  assert.equal(rb.claimed, 0);
  assert.equal(calls, 2);
});
