import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeEnv, client } from './helpers.mjs';
import { checkOpenArea, tilesFor, tileName, cellAt, leafFinder, parseTile, searchOpenPlaces, placeLink, OPEN_CATEGORIES, MAX_OPEN_RESULTS, MAX_LEVEL } from '../public/js/open-places.js';
import { LOCAL_CATEGORIES, AreaError } from '../public/js/overpass.js';
import { buildTiles } from '../dev/get-places.mjs';

const G = { lat: 29.6516, lon: -82.3248 };   // Gainesville
const row = (id, name, cat, lat, lon, alt = '') => [id, name, cat, alt, '3525550100', 'https://x.example.com', '', '12  Main St', 'Gainesville', '32601', lat, lon, 'FL'];

test('every category has an open-data mapping, and a typed category is normalised', () => {
  for (const k of Object.keys(LOCAL_CATEGORIES)) assert.ok(OPEN_CATEGORIES[k]?.length, k);
  assert.deepEqual(checkOpenArea({ ...G, radius_m: 5000, tag: 'Pest control service' }).cats, ['pest_control_service']);
  assert.throws(() => checkOpenArea({ ...G, radius_m: 5000, tag: 'x"; drop' }), AreaError);
  assert.throws(() => checkOpenArea({ ...G, radius_m: 90_000, category: 'roofer' }), AreaError);
});

test('tiles: names per level, no float slip, and the lookup finds leaves at any level inside the box only', () => {
  assert.equal(tileName(29.5, -82.25, 1), '1_59_-165');   // 29.5 * 2 = 59 exactly, not 58.999…
  assert.equal(tileName(29.65, -82.32, 0), '0_29_-83');
  assert.equal(tileName(29.65, -82.32, 5), '5_948_-2635');
  const a = checkOpenArea({ ...G, radius_m: 5000, category: 'roofer' });
  const here = tileName(G.lat, G.lon, MAX_LEVEL); const north = tileName(G.lat + 0.044, G.lon, MAX_LEVEL);   // 4.9 km north is in the box
  const faraway = tileName(G.lat + 1, G.lon, 0); const coarse = tileName(G.lat, G.lon - 0.2, 2);
  const got = tilesFor(a, new Set([here, north, faraway, coarse]));
  assert.ok(got.includes(here) && got.includes(north));
  assert.ok(!got.includes(faraway));
  assert.ok(got.includes(coarse) === (cellAt(G.lon - 0.2, 2) >= cellAt(G.lon - 0.052, 2)));   // only if the coarse cell reaches the box
});

test('leaves: a cell splits while it holds more than the limit, down to the deepest level', () => {
  const pts = [[29.65, -82.32], [29.651, -82.32], [29.652, -82.321], [29.1, -82.9], [40.7, -74.0]];
  const counts = new Map();
  for (const [lat, lon] of pts) for (let L = 0; L <= MAX_LEVEL; L++) { const t = tileName(lat, lon, L); counts.set(t, (counts.get(t) || 0) + 1); }
  const leaf = leafFinder(counts, 2);
  assert.equal(leaf(40.7, -74.0), tileName(40.7, -74.0, 0));        // alone in its degree: stays big
  assert.equal(leaf(29.1, -82.9), tileName(29.1, -82.9, 1));        // its degree has 4 > 2, its half-degree has 1
  assert.equal(leaf(29.65, -82.32), tileName(29.65, -82.32, MAX_LEVEL));   // three close together never get under 2
});

test('search: matches main or extra categories, keeps the circle only, nearest first, capped', async () => {
  const a = checkOpenArea({ ...G, radius_m: 5000, category: 'roofer' });
  const near = row('a', 'Near Roofing', 'roofing', G.lat + 0.001, G.lon);
  const alt = row('b', 'Big Contractor', 'contractor', G.lat + 0.01, G.lon, 'painting;roofing');
  const far = row('c', 'Far Roofing', 'roofing', G.lat + 0.3, G.lon);           // 33 km: outside
  const corner = row('d', 'Corner Roofing', 'roofing', G.lat + 0.04, G.lon + 0.05);   // in the box, outside the circle
  const other = row('e', 'Plumber', 'plumbing', G.lat, G.lon);
  const tiles = new Map();
  for (const r of [alt, near, far, corner, other]) { const n = tileName(r[10], r[11], 0); tiles.set(n, [...(tiles.get(n) || []), r]); }
  const got = await searchOpenPlaces(a, { tiles: [...tiles.keys()] }, async (n) => tiles.get(n));
  assert.deepEqual(got.results.map((b) => b.name), ['Near Roofing', 'Big Contractor']);
  const b = got.results[0];
  assert.equal(b.address, '12 Main St, Gainesville, FL 32601');
  assert.equal(b.osm_url, placeLink('Near Roofing', b.address));
  const many = Array.from({ length: MAX_OPEN_RESULTS + 5 }, (_, i) => row(`m${i}`, `R${i}`, 'roofing', G.lat, G.lon));
  const big = await searchOpenPlaces(a, { tiles: [tileName(G.lat, G.lon, 0)] }, async () => many);
  assert.equal(big.results.length, MAX_OPEN_RESULTS);
  await assert.rejects(searchOpenPlaces(a, { tiles: ['0_1_1'] }, async () => []), /covers the US/);
});

const HEAD = 'id,name,category,basic_category,alt_categories,phone,website,email,address,city,state,zip,lat,lon,confidence,sources\n';
const gz = (dir, name, text) => { const p = join(dir, name); writeFileSync(p, gzipSync(text)); return p; };

test('the tile builder: header by name, drops rows without a name or point, streams two files, tiles parse back, index lists them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'places-'));
  const f1 = gz(dir, 'a.csv.gz', HEAD
    + 'a,"Roof, Inc",roofing,,,352,https://r.example.com,,1 A St,Gainesville,FL,32601,29.65,-82.32,0.9,meta\n'
    + 'b,,roofing,,,,,,,,FL,,29.65,-82.32,0.9,meta\n'
    + 'c,No point,roofing,,,,,,,,FL,,,,0.9,meta\n');
  const f2 = gz(dir, 'b.csv.gz', HEAD.replace('category,basic_category', 'basic_category,category').replace('id,name', 'name,id')
    + 'Doc,d,doctors_office,,,,,,,,NY,,40.7,-74.0,0.9,meta\n');
  const out = join(dir, 'out');
  const index = await buildTiles([f1, f2], out, { maxRows: 1 });
  assert.equal(index.rows, 2);
  assert.deepEqual(index.tiles, [tileName(29.65, -82.32, 0), tileName(40.7, -74.0, 0)].sort());
  assert.equal(readdirSync(join(out, 't')).length, 2);
  const t = parseTile(readFileSync(join(out, 't', `${tileName(29.65, -82.32, 0)}.json`), 'utf8'));
  assert.deepEqual(t[0].slice(0, 3), ['a', 'Roof, Inc', 'roofing']);
  const ny = parseTile(readFileSync(join(out, 't', `${tileName(40.7, -74.0, 0)}.json`), 'utf8'))[0];
  assert.equal(ny[2], 'doctors_office'); assert.equal(ny[12], 'NY');   // header order read by name
  await assert.rejects(buildTiles([gz(dir, 'bad.csv.gz', 'id,name\nx,y\n')], join(dir, 'o2')), /no category column/);
});

test('open search on the Worker: checks the rows, rebuilds the link, drops rows outside the circle, then imports', async () => {
  const env = fakeEnv(); const api = await client(env);
  const search = { source: 'open', ...G, radius_m: 5000, category: 'roofer' };
  const places = [
    { name: 'Gator Roofing', phone: '352', website: 'https://g.example.com', address: '1 A St, Gainesville, FL 32601', lat: G.lat, lon: G.lon, osm_url: 'javascript:alert(1)' },
    { name: 'x'.repeat(500), lat: G.lat, lon: G.lon },
    { name: 'Far away', lat: G.lat + 1, lon: G.lon },
    { name: '', lat: G.lat, lon: G.lon }, null, { name: 'No point' },
  ];
  const r = (await api.post('/api/find/local/open', { ...search, places })).body;
  assert.deepEqual(r.results.map((b) => b.name.length), [13, 300]);
  assert.equal(r.results[0].osm_url, placeLink('Gator Roofing', '1 A St, Gainesville, FL 32601'));
  assert.equal((await api.post('/api/find/local/open', { ...search, places: Array(MAX_OPEN_RESULTS + 1).fill(places[0]) })).status, 400);
  const imp = (await api.post('/api/find/local/import', { search, new_name: 'Roofers', only: [r.results[0].osm_url] })).body;
  assert.equal(imp.added, 1);
  const again = (await api.post('/api/find/local/import', { search, table_id: imp.table_id })).body;
  assert.equal(again.added, 1);   // the second one; the first is already there
  assert.equal((await api.post('/api/find/local/import', { search: { ...search, radius_m: 7000 }, new_name: 'x' })).status, 409);
});

test('tidy: US phones in one format, tracking parameters gone, directory pages moved to Listing', async () => {
  const { tidyPhone, tidyWebsite, rowToBusiness } = await import('../public/js/open-places.js');
  for (const p of ['3529003335', '+13529003335', '352-900-3335', '1 (352) 900 3335']) assert.equal(tidyPhone(p), '(352) 900-3335');
  assert.equal(tidyPhone('+44 20 7946 0958'), '+44 20 7946 0958');
  assert.equal(tidyPhone(''), null);
  assert.deepEqual(tidyWebsite('https://beaverhomeserv.com/?utm_source=GMB&utm_medium=Website&x=1'), { website: 'https://beaverhomeserv.com/?x=1', listing: null });
  assert.deepEqual(tidyWebsite('oursolarbear.com'), { website: 'https://oursolarbear.com/', listing: null });
  assert.deepEqual(tidyWebsite('https://www.bbb.org/us/fl/gainesville/profile/roofing/x'), { website: null, listing: 'https://www.bbb.org/us/fl/gainesville/profile/roofing/x' });
  assert.equal(tidyWebsite('https://m.facebook.com/roofer').listing, 'https://m.facebook.com/roofer');
  assert.equal(tidyWebsite('https://sites.google.com/view/roofer').website, 'https://sites.google.com/view/roofer');   // their own site
  assert.equal(tidyWebsite('https://maps.google.com/?cid=1').listing, 'https://maps.google.com/?cid=1');
  assert.equal(tidyWebsite('https://notbbb.org/').website, 'https://notbbb.org/');
  const b = rowToBusiness(['x', 'R', 'roofing', '', '+13525550100', 'https://yelp.com/biz/r', '', '1 A St', 'Anchorage', '99518', 61.2, -149.9, 'AK']);
  assert.equal(b.address, '1 A St, Anchorage, AK 99518');
  assert.equal(b.phone, '(352) 555-0100'); assert.equal(b.website, null); assert.equal(b.listing, 'https://yelp.com/biz/r');
});

test('import: a Listing column only when the rows have listings; the Worker tidies what the browser sends', async () => {
  const env = fakeEnv(); const api = await client(env);
  const search = { source: 'open', ...G, radius_m: 5000, category: 'roofer' };
  await api.post('/api/find/local/open', { ...search, places: [{ name: 'A', phone: '3525550100', website: 'https://a.example.com/?gclid=9', lat: G.lat, lon: G.lon }] });
  const t1 = (await api.post('/api/find/local/import', { search, new_name: 'One' })).body;
  const full1 = (await api.get(`/api/tables/${t1.table_id}`)).body;
  assert.ok(!full1.columns.some((c) => c.name === 'Listing'));
  const row = full1.rows[0].data; const key = (n) => full1.columns.find((c) => c.name === n).key;
  assert.equal(row[key('Phone')], '(352) 555-0100'); assert.equal(row[key('Website')], 'https://a.example.com/');
  await api.post('/api/find/local/open', { ...search, places: [{ name: 'B', website: 'facebook.com/b', lat: G.lat, lon: G.lon }] });
  const t2 = (await api.post('/api/find/local/import', { search, new_name: 'Two' })).body;
  const full2 = (await api.get(`/api/tables/${t2.table_id}`)).body;
  const lk = full2.columns.find((c) => c.name === 'Listing').key;
  assert.equal(full2.rows[0].data[lk], 'https://facebook.com/b');
});
