import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch } from './helpers.mjs';
import { toBusiness } from '../src/opendata/osm.js';

const overpass = (n = 3) => ({ elements: [
  { type: 'node', id: 1, lat: 29.65, lon: -82.33, tags: { name: 'Gator Roofing', craft: 'roofer', phone: '+1 352 555 0100', website: 'https://gator.example.com', 'addr:housenumber': '12', 'addr:street': 'Main St', 'addr:city': 'Gainesville', 'addr:state': 'FL', 'addr:postcode': '32601' } },
  { type: 'way', id: 2, center: { lat: 29.66, lon: -82.34 }, tags: { name: 'Sunshine Roofs', 'contact:phone': '352-555-0101', 'contact:website': 'sun.example.com' } },
  { type: 'node', id: 3, lat: 1, lon: 1, tags: { craft: 'roofer' } },   // no name: dropped
  ...Array.from({ length: Math.max(0, n - 3) }, (_, i) => ({ type: 'node', id: 100 + i, lat: 29.652, lon: -82.321, tags: { name: `Extra ${i}` } })),
] });
const SEARCH = { lat: 29.6516, lon: -82.3248, radius_m: 5000, category: 'roofer' };

async function setup(routes) {
  const f = fakeFetch(routes);
  const env = fakeEnv(); const api = await client(env, { fetch: f });
  return { f, env, api };
}

test('an OSM element becomes a business: contact:* fallbacks, way centers, the OSM link', () => {
  const [a, b, c] = overpass().elements.map(toBusiness);
  assert.deepEqual(a, { name: 'Gator Roofing', phone: '+1 352 555 0100', website: 'https://gator.example.com', email: null,
    address: '12 Main St, Gainesville, FL 32601', city: 'Gainesville', hours: null, lat: 29.65, lon: -82.33, osm_url: 'https://www.openstreetmap.org/node/1' });
  assert.equal(b.phone, '352-555-0101'); assert.equal(b.website, 'sun.example.com'); assert.equal(b.lat, 29.66);
  assert.equal(c, null);
});

test('local search: the Worker takes the browser elements, keeps only valid ones, caches them, and answers from the cache after', async () => {
  const { f, api } = await setup({});
  const junk = [null, 'x', { type: 'area', id: 5, tags: { name: 'Bad type' } }, { type: 'node', id: 'x', tags: { name: 'Bad id' } }, { type: 'node', id: 7 }];
  const r1 = (await api.post('/api/find/local', { ...SEARCH, elements: [...overpass().elements, ...junk] })).body;
  assert.deepEqual(r1.results.map((b) => b.name), ['Gator Roofing', 'Sunshine Roofs']);
  assert.equal(r1.cached, false);
  const r2 = (await api.post('/api/find/local', { ...SEARCH, lat: 29.651600001 })).body;
  assert.equal(r2.cached, true); assert.equal(r2.results.length, 2);
  assert.equal(f.calls.length, 0);   // the Worker never calls Overpass itself
  assert.equal((await api.post('/api/find/local', { ...SEARCH, radius_m: 9000 })).status, 409);   // never searched
});

test('elements from the browser are capped: strings to 300 characters, at most 1,000 elements, 200 results', async () => {
  const { api } = await setup({});
  const long = 'x'.repeat(5000);
  const r = (await api.post('/api/find/local', { ...SEARCH, elements: [{ type: 'node', id: 1, lat: 1, lon: 'evil', tags: { name: long, phone: long } }] })).body;
  assert.equal(r.results[0].name.length, 300); assert.equal(r.results[0].lon, null);
  assert.equal((await api.post('/api/find/local', { ...SEARCH, elements: Array.from({ length: 1001 }, (_, i) => ({ type: 'node', id: i, tags: { name: 'n' } })) })).status, 400);
  const many = (await api.post('/api/find/local', { ...SEARCH, elements: Array.from({ length: 300 }, (_, i) => ({ type: 'node', id: i, tags: { name: `n${i}` } })) })).body;
  assert.equal(many.results.length, 200);
});

test('local search refuses bad input: unknown category, tag injection, huge radius, bad point', async () => {
  const { api } = await setup({});
  const els = overpass().elements;
  assert.equal((await api.post('/api/find/local', { ...SEARCH, category: 'casino', elements: els })).status, 400);
  assert.equal((await api.post('/api/find/local', { ...SEARCH, category: undefined, tag: 'craft"];out;//=x', elements: els })).status, 400);
  assert.equal((await api.post('/api/find/local', { ...SEARCH, radius_m: 100000, elements: els })).status, 400);
  assert.equal((await api.post('/api/find/local', { ...SEARCH, lat: 200, elements: els })).status, 400);
  assert.equal((await api.post('/api/find/local', { ...SEARCH, category: undefined, tag: 'shop=bakery', elements: els })).status, 200);
});

test('the browser query: a bounding box around the circle, the same area the Worker keys the cache on', async () => {
  const { checkArea, overpassQuery, bbox, distanceM } = await import('../public/js/overpass.js');
  const a = checkArea(SEARCH);
  assert.deepEqual(a, { lat: 29.6516, lon: -82.3248, r: 5000, key: 'craft', value: 'roofer' });
  const b = bbox(a);
  assert.match(overpassQuery(a), /^\[out:json\]\[timeout:25\];nwr\["craft"="roofer"\]\["name"\]\(29\.60663,-82\.37654,29\.69657,-82\.27306\);out center tags 200;$/);
  assert.ok(Math.abs(distanceM(a.lat, a.lon, b.n, a.lon) - 5000) < 5);   // the box edge is one radius away
  assert.ok(Math.abs(distanceM(a.lat, a.lon, a.lat, b.e) - 5000) < 5);
});

test('results in the corners of the box, outside the circle, are dropped; ones with no point are kept', async () => {
  const { api } = await setup({});
  const r = (await api.post('/api/find/local', { ...SEARCH, elements: [
    { type: 'node', id: 1, lat: 29.6516, lon: -82.3248, tags: { name: 'Center' } },
    { type: 'node', id: 2, lat: 29.69, lon: -82.28, tags: { name: 'Corner' } },   // inside the box, ~6 km away
    { type: 'relation', id: 3, tags: { name: 'No point' } }] })).body;
  assert.deepEqual(r.results.map((b) => b.name), ['Center', 'No point']);
});

test('the browser runs Overpass: 521 moves on, 429 waits once and retries, 400 stops, and the error says what each server did', async () => {
  const { runOverpass, checkArea, OverpassError } = await import('../public/js/overpass.js');
  const a = checkArea(SEARCH);
  const hosts = []; const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const mk = (answers) => async (url) => {
    const h = new URL(url).host; hosts.push(h);
    let x = answers[h]; if (Array.isArray(x)) x = x.shift();
    if (x instanceof Error) throw x;
    return new Response(JSON.stringify(x?.body ?? {}), { status: x?.status ?? 200 });
  };
  assert.equal((await runOverpass(a, mk({ 'overpass-api.de': { status: 521 }, 'overpass.private.coffee': { body: overpass() } }), sleep)).length, 3);
  assert.deepEqual(hosts, ['overpass-api.de', 'overpass.private.coffee']);
  hosts.length = 0;
  assert.equal((await runOverpass(a, mk({ 'overpass-api.de': [{ status: 429 }, { body: overpass() }] }), sleep)).length, 3);
  assert.deepEqual(hosts, ['overpass-api.de', 'overpass-api.de']); assert.deepEqual(waits, [5000]);
  hosts.length = 0;
  await assert.rejects(() => runOverpass(a, mk({ 'overpass-api.de': { status: 400 } }), sleep), /could not read/);
  assert.equal(hosts.length, 1);
  const err = await runOverpass(a, mk({ 'overpass-api.de': { status: 429 }, 'overpass.private.coffee': new Error('reset'), 'overpass.kumi.systems': { status: 504 } }), sleep).catch((e) => e);
  assert.ok(err instanceof OverpassError);
  assert.deepEqual(err.log, ['overpass-api.de 429 (too many requests, after one retry)', 'overpass.private.coffee unreachable', 'overpass.kumi.systems 504 (timed out)']);
});

test('backup route: Nominatim search for the category word inside the box, with the contact email, cached, trimmed to the circle, importable', async () => {
  const nom = [
    { osm_type: 'node', osm_id: 11, lat: '29.652', lon: '-82.325', name: 'Gator Roofing', display_name: 'Gator Roofing, Gainesville',
      extratags: { phone: '+1 352 555 0100', website: 'https://gator.example.com' }, address: { house_number: '12', road: 'Main St', city: 'Gainesville', state: 'Florida', postcode: '32601' } },
    { osm_type: 'way', osm_id: 12, lat: '29.69', lon: '-82.28', name: 'Far Corner Roofs', address: {} },
    { osm_type: 'bogus', osm_id: 13, lat: '29.65', lon: '-82.32', name: 'Bad' }];
  const { f, api } = await setup({ 'nominatim.openstreetmap.org': nom });
  assert.equal((await api.post('/api/find/local/nominatim', SEARCH)).status, 400);   // needs the contact email first
  await api.patch('/api/settings', { contact_email: 'me@example.com' });
  const r = (await api.post('/api/find/local/nominatim', SEARCH)).body;
  assert.equal(r.via, 'nominatim');
  assert.deepEqual(r.results.map((b) => b.name), ['Gator Roofing']);
  assert.equal(r.results[0].phone, '+1 352 555 0100'); assert.equal(r.results[0].address, '12 Main St, Gainesville, Florida 32601');
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get('q'), 'roofers'); assert.equal(u.searchParams.get('bounded'), '1');
  assert.equal(u.searchParams.get('viewbox'), '-82.37654,29.69657,-82.27306,29.60663');
  assert.match(f.calls[0].headers.get('user-agent'), /me@example\.com/);
  await api.post('/api/find/local/nominatim', SEARCH);
  assert.equal(f.calls.length, 1);   // cached
  const imp = (await api.post('/api/find/local/import', { search: SEARCH, new_name: 'Backup roofers' })).body;
  assert.equal(imp.added, 1);
});

test('geocode needs the contact email, sends it, and caches the answer', async () => {
  const { f, api } = await setup({ 'nominatim.openstreetmap.org': [{ lat: '29.65', lon: '-82.32', display_name: 'Gainesville, Florida, USA' }] });
  assert.equal((await api.post('/api/find/geocode', { q: 'Gainesville, FL' })).status, 400);
  assert.equal(f.calls.length, 0);
  await api.patch('/api/settings', { contact_email: 'me@example.com' });
  const g = (await api.post('/api/find/geocode', { q: 'Gainesville, FL' })).body;
  assert.equal(g.lat, 29.65); assert.equal(g.cached, false);
  assert.match(f.calls[0].headers.get('user-agent'), /me@example\.com/);
  assert.equal((await api.post('/api/find/geocode', { q: 'gainesville, fl ' })).body.cached, true);
  assert.equal(f.calls.length, 1);
});

test('import: new table with typed columns and no empty Name column, then re-import skips what is there; "only" picks rows', async () => {
  const { f, api } = await setup({});
  await api.post('/api/find/local', { ...SEARCH, elements: overpass(5).elements });
  const r = (await api.post('/api/find/local/import', { search: SEARCH, new_name: 'Gainesville roofers', only: ['https://www.openstreetmap.org/node/1', 'https://www.openstreetmap.org/way/2'] })).body;
  assert.equal(r.added, 2);
  const t = (await api.get(`/api/tables/${r.table_id}`)).body;
  assert.equal(t.table.name, 'Gainesville roofers');
  assert.equal(t.columns.filter((c) => c.name === 'Name').length, 1);
  assert.equal(t.columns.find((c) => c.name === 'Website').type, 'url');
  assert.equal(t.rows[0].data.name, 'Gator Roofing');
  const again = (await api.post('/api/find/local/import', { search: SEARCH, table_id: r.table_id })).body;
  assert.equal(again.added, 2); assert.equal(again.skipped_duplicates, 2);
  assert.equal(f.calls.length, 0);   // imports are answered from the cache the search filled
});

test('the cron sweeps expired cache entries', async () => {
  const { env, api } = await setup({});
  await api.post('/api/find/local', { ...SEARCH, elements: overpass().elements });
  const { scheduled } = await import('../src/index.js');
  await scheduled({}, env, {}, { now: new Date(Date.now() + 8 * 86400_000), fetch: fakeFetch({}) });
  assert.equal(env.sql.prepare('SELECT count(*) AS n FROM data_cache').get().n, 0);
});

test('a missing database update gives the exact command, not a raw SQL error', async () => {
  const { env, api } = await setup({});
  env.sql.exec('DROP TABLE data_cache');
  const r = await api.post('/api/find/local', { ...SEARCH, elements: overpass().elements });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /npx wrangler d1 migrations apply free-clay --remote/);
});

const gPlace = (i, lat = 29.652, lon = -82.325) => ({ id: `p${i}`, displayName: { text: `Roofer ${i}` }, formattedAddress: `${i} Main St, Gainesville, FL 32601, USA`,
  nationalPhoneNumber: `(352) 555-01${10 + i}`, websiteUri: `https://roofer${i}.example.com`, googleMapsUri: `https://maps.google.com/?cid=${i}`, location: { latitude: lat, longitude: lon } });

test('Google Maps route: needs the key, respects the budget, restricts to the box, pages, ledgers each request, trims to the circle, importable', async () => {
  let n = 0;
  const f = fakeFetch({ 'places.googleapis.com': () => {
    n++;
    return n === 1 ? { places: [gPlace(1), gPlace(2, 29.69, -82.28)], nextPageToken: 'T2' } : { places: [gPlace(3)] };
  } });
  const env = fakeEnv(); const api = await client(env, { fetch: f, sleep: async () => {} });
  const noKey = await api.post('/api/find/local/google', { ...SEARCH, pages: 2 });
  assert.equal(noKey.status, 400); assert.match(noKey.body.error, /wrangler secret put GOOGLE_MAPS_API_KEY/);
  env.GOOGLE_MAPS_API_KEY = 'gkey';
  await api.patch('/api/settings', { default_budget_micros: 50_000 });
  const tooMuch = await api.post('/api/find/local/google', { ...SEARCH, pages: 2 });
  assert.equal(tooMuch.status, 400); assert.match(tooMuch.body.error, /\$0\.070/);
  assert.equal(f.calls.length, 0);
  await api.patch('/api/settings', { default_budget_micros: 1_000_000 });
  const r = (await api.post('/api/find/local/google', { ...SEARCH, pages: 2 })).body;
  assert.equal(r.via, 'google'); assert.equal(r.cost_micros, 70_000);
  assert.deepEqual(r.results.map((b) => b.name), ['Roofer 1', 'Roofer 3']);   // Roofer 2 is outside the circle
  assert.equal(r.results[0].city, 'Gainesville'); assert.equal(r.results[0].phone, '(352) 555-0111');
  const sent = JSON.parse(f.calls[0].body);
  assert.equal(sent.textQuery, 'roofers');
  assert.deepEqual(sent.locationRestriction.rectangle.low, { latitude: 29.60663, longitude: -82.37654 });
  assert.equal(f.calls[0].headers.get('x-goog-api-key'), 'gkey');
  assert.match(f.calls[0].headers.get('x-goog-fieldmask'), /places\.location/);
  assert.equal(JSON.parse(f.calls[1].body).pageToken, 'T2');
  assert.deepEqual(env.sql.prepare(`SELECT cost_micros FROM ledger WHERE provider='places_search' ORDER BY id`).all().map((x) => x.cost_micros), [35_000, 35_000]);
  const imp = (await api.post('/api/find/local/import', { search: SEARCH, new_name: 'Google roofers' })).body;
  assert.equal(imp.added, 2);
  const t = (await api.get(`/api/tables/${imp.table_id}`)).body;
  assert.ok(t.columns.some((c) => c.name === 'Map link'));
  assert.equal(f.calls.length, 2);
});

test('Google Maps route: a provider error on the first page is a 502, ledgered at $0', async () => {
  const f = fakeFetch({ 'places.googleapis.com': () => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 400 }) });
  const env = fakeEnv(); env.GOOGLE_MAPS_API_KEY = 'bad';
  const api = await client(env, { fetch: f });
  const r = await api.post('/api/find/local/google', SEARCH);
  assert.equal(r.status, 502);
  assert.equal(env.sql.prepare(`SELECT cost_micros, outcome FROM ledger WHERE provider='places_search'`).get().outcome, 'error');
});
