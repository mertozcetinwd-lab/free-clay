import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch } from './helpers.mjs';
import { PROBES } from '../src/opendata/probe.js';

const ok = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '9', 'x-other': 'no' } });
const allHosts = (fn) => Object.fromEntries(['nominatim.', 'overpass-api.', 'data.sec.', 'wikidata.', 'gleif.', 'greenhouse.', 'gdeltproject.', 'lever.', 'ashbyhq.', 'www.sec.', 'private.coffee', 'kumi.systems'].map((h) => [h, fn]));

test('contact email: validated, and blank clears it', async () => {
  const env = fakeEnv(); const api = await client(env);
  assert.equal((await api.patch('/api/settings', { contact_email: 'not an email' })).status, 400);
  assert.equal((await api.patch('/api/settings', { contact_email: 'a@b.co<script>' })).status, 400);
  assert.equal((await api.patch('/api/settings', { contact_email: 'me@example.com' })).body.contact_email, 'me@example.com');
  assert.equal((await api.patch('/api/settings', { contact_email: '' })).body.contact_email, '');
});

test('probe without a contact email skips the services that require one and never calls them', async () => {
  const f = fakeFetch(allHosts(ok));
  const env = fakeEnv(); const api = await client(env, { fetch: f });
  const r = (await api.post('/api/admin/probe')).body;
  assert.equal(r.contact_set, false);
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(byId.nominatim.skipped, true); assert.equal(byId.sec.skipped, true);
  assert.equal(byId.overpass.ok, true);
  assert.ok(!f.calls.some((c) => /nominatim|sec\.gov/.test(c.url)));
  assert.equal(f.calls.length, PROBES.filter((p) => !p.needsContact).length);
  assert.deepEqual(byId.gleif.limits, { 'x-ratelimit-remaining': '9' });
  assert.ok(r.results.filter((x) => !x.skipped).every((x) => x.ok), 'every probe has a fake answer');
});

test('probe with a contact email calls all seven, puts the email in the User-Agent, and reports failures without throwing', async () => {
  const routes = allHosts(ok); routes['gdeltproject.'] = new Error('connection refused'); routes['greenhouse.'] = () => new Response('no', { status: 429 });
  const f = fakeFetch(routes);
  const env = fakeEnv(); const api = await client(env, { fetch: f });
  await api.patch('/api/settings', { contact_email: 'me@example.com' });
  const r = (await api.post('/api/admin/probe')).body;
  assert.equal(f.calls.length, PROBES.length);
  assert.ok(f.calls.every((c) => c.headers.get('user-agent').includes('me@example.com')));
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(byId.gdelt.ok, false); assert.match(byId.gdelt.note, /refused/);
  assert.equal(byId.greenhouse.ok, false); assert.equal(byId.greenhouse.status, 429);
  assert.equal(f.calls.find((c) => c.url.includes('overpass')).method, 'POST');
});

test('probe needs a login', async () => {
  const env = fakeEnv();
  const { handle } = await import('../src/index.js');
  const res = await handle(new Request('https://x.test/api/admin/probe', { method: 'POST' }), env, {}, { fetch: fakeFetch({}) });
  assert.equal(res.status, 401);
});

test('openFetch refuses a service that needs a contact before one is set, without calling it', async () => {
  const { openFetch } = await import('../src/opendata/http.js');
  const f = fakeFetch({ 'data.sec.': ok });
  const env = fakeEnv();
  await assert.rejects(() => openFetch(env.DB, { fetch: f }, 'https://data.sec.gov/x', { needsContact: true }), /contact email/);
  assert.equal(f.calls.length, 0);
  await openFetch(env.DB, { fetch: f }, 'https://data.sec.gov/x');   // services that do not ask are fine
  assert.equal(f.calls[0].headers.get('user-agent'), 'FreeClay/1.0 (open-source lead tool)');
});
