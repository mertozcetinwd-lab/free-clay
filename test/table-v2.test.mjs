import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client } from './helpers.mjs';

async function table(api) {
  const t = (await api.post('/api/tables', { name: 'T' })).body;
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Website', type: 'text' });
  return t;
}
const rowsOf = async (api, id) => (await api.get(`/api/tables/${id}`)).body.rows;

test('dedupe keeps the oldest row per value, trimmed and case-blind, and never counts empty values', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await table(api);
  await api.post(`/api/tables/${t.id}/rows`, { rows: [
    { name: 'a', website: 'acme.com' }, { name: 'b', website: ' ACME.com ' }, { name: 'c', website: 'other.com' },
    { name: 'd' }, { name: 'e' }, { name: 'f', website: 'acme.com' }] });
  const r = (await api.post(`/api/tables/${t.id}/dedupe`, { key: 'website' })).body;
  assert.equal(r.removed, 2);
  assert.deepEqual((await rowsOf(api, t.id)).map((x) => x.data.name), ['a', 'c', 'd', 'e']);
  assert.equal((await api.post(`/api/tables/${t.id}/dedupe`, { key: 'nope' })).status, 400);
});

test('auto-dedupe: setting it cleans the table, later inserts are checked, and the response lists only kept rows', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await table(api);
  await api.post(`/api/tables/${t.id}/rows`, { rows: [{ website: 'a.com' }, { website: 'a.com' }] });
  const set = (await api.patch(`/api/tables/${t.id}`, { dedupe_key: 'website', description: '  Roofers ' })).body;
  assert.equal(set.removed, 1);
  const add = (await api.post(`/api/tables/${t.id}/rows`, { rows: [{ website: 'A.com' }, { website: 'b.com' }] })).body;
  assert.equal(add.added, 1);
  assert.deepEqual(add.rows.map((x) => x.data.website), ['b.com']);
  await api.post(`/api/tables/${t.id}/import`, 'Website\nb.com\nc.com\n');
  assert.deepEqual((await rowsOf(api, t.id)).map((x) => x.data.website), ['a.com', 'b.com', 'c.com']);
  const full = (await api.get(`/api/tables/${t.id}`)).body.table;
  assert.equal(full.description, 'Roofers'); assert.equal(full.dedupe_key, 'website');
  assert.equal((await api.patch(`/api/tables/${t.id}`, { dedupe_key: 'zzz' })).status, 400);
});

test('deleting the dedupe column switches auto-dedupe off', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await table(api);
  await api.patch(`/api/tables/${t.id}`, { dedupe_key: 'website' });
  const col = (await api.get(`/api/tables/${t.id}`)).body.columns.find((c) => c.key === 'website');
  await api.del(`/api/columns/${col.id}`);
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.table.dedupe_key, null);
  const add = (await api.post(`/api/tables/${t.id}/rows`, { rows: [{ name: 'x' }, { name: 'x' }] })).body;
  assert.equal(add.added, 2);
});

test('bulk patch: many rows in one statement, typed values, clears, object values replace, other tables untouched', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await table(api);
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Employees', type: 'number' });
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Meta', type: 'json' });
  const other = await table(api);
  const theirs = (await api.post(`/api/tables/${other.id}/rows`, { rows: [{ name: 'keep' }] })).body.rows[0];
  const mine = (await api.post(`/api/tables/${t.id}/rows`, { rows: [{ name: 'a', website: 'a.com', meta: { x: 1, y: 2 } }, { name: 'b' }, { name: 'c' }] })).body.rows;
  let queries = 0; const prep = env.DB.prepare.bind(env.DB); env.DB.prepare = (q) => { if (/^UPDATE rows/.test(q.trim())) queries++; return prep(q); };
  const r = (await api.patch(`/api/tables/${t.id}/rows/bulk`, { rows: [
    { id: mine[0].id, data: { website: null, employees: '12', meta: { z: 3 } } },
    { id: mine[1].id, data: { name: 'B2', website: 'b.com' } },
    { id: mine[2].id, data: { nope: 'x' } },
    { id: theirs.id, data: { name: 'hijack' } }] })).body;
  assert.equal(queries, 1);
  assert.equal(r.updated, 2);
  const rows = await rowsOf(api, t.id);
  assert.deepEqual(rows[0].data, { name: 'a', employees: 12, meta: { z: 3 } });
  assert.deepEqual(rows[1].data, { name: 'B2', website: 'b.com' });
  assert.equal((await rowsOf(api, other.id))[0].data.name, 'keep');
  assert.equal((await api.patch(`/api/tables/${t.id}/rows/bulk`, { rows: [{ id: 'x', data: {} }] })).status, 400);
  assert.equal((await api.patch(`/api/tables/${t.id}/rows/bulk`, { rows: [] })).status, 400);
});

test('bulk patch with auto-run on queues the changed rows only', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await table(api);
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Alive', kind: 'enrich', type: 'text', config: { fn: 'domain_alive', inputs: { domain: '{{website}}' }, auto: true } });
  const rows = (await api.post(`/api/tables/${t.id}/rows`, { rows: [{ website: 'a.com' }, { website: 'b.com' }, { website: 'c.com' }] })).body.rows;
  await api.patch('/api/settings', { auto_run: true });
  await api.patch(`/api/tables/${t.id}/rows/bulk`, { rows: [{ id: rows[0].id, data: { website: 'x.com' } }, { id: rows[2].id, data: { website: 'y.com' } }] });
  const jobs = env.sql.prepare(`SELECT row_id FROM cell_jobs WHERE status='queued' ORDER BY row_id`).all().map((j) => j.row_id);
  assert.deepEqual(jobs, [rows[0].id, rows[2].id]);
});

test('columns: insert at a position, description, color and pin, bad values refused', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await table(api);   // name, website
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Middle', position: 1 })).body;
  const order = async () => (await api.get(`/api/tables/${t.id}`)).body.columns.map((x) => x.name);
  assert.deepEqual(await order(), ['Name', 'Middle', 'Website']);
  const p = (await api.patch(`/api/columns/${c.id}`, { description: ' The middle ', color: 'green', pinned: true })).body;
  assert.equal(p.description, 'The middle'); assert.equal(p.color, 'green'); assert.equal(p.pinned, 1);
  assert.equal((await api.patch(`/api/columns/${c.id}`, { name: 'Mid' })).body.color, 'green');   // other fields survive
  assert.equal((await api.patch(`/api/columns/${c.id}`, { color: 'chartreuse' })).status, 400);
  assert.equal((await api.patch(`/api/columns/${c.id}`, { pinned: 'yes' })).status, 400);
  assert.equal((await api.post(`/api/tables/${t.id}/columns`, { name: 'X', position: -1 })).status, 400);
});

test('duplicate: placed right after, settings copied, data values copied (objects stay objects), computed values not', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await table(api);
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Meta', type: 'json' });
  await api.post(`/api/tables/${t.id}/rows`, { rows: [{ name: 'a', website: 'a.com', meta: { x: [1, 2] } }, { name: 'b' }] });
  const cols = (await api.get(`/api/tables/${t.id}`)).body.columns;
  const web = cols.find((x) => x.key === 'website'); const meta = cols.find((x) => x.key === 'meta');
  await api.patch(`/api/columns/${web.id}`, { color: 'red', description: 'Site' });
  const copy = (await api.post(`/api/columns/${web.id}/duplicate`)).body;
  const mcopy = (await api.post(`/api/columns/${meta.id}/duplicate`)).body;
  assert.equal(copy.name, 'Website (copy)'); assert.equal(copy.color, 'red'); assert.equal(copy.description, 'Site');
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.deepEqual(full.columns.map((x) => x.name), ['Name', 'Website', 'Website (copy)', 'Meta', 'Meta (copy)']);
  assert.equal(full.rows[0].data[copy.key], 'a.com');
  assert.deepEqual(full.rows[0].data[mcopy.key], { x: [1, 2] });
  assert.equal(full.rows[1].data[copy.key], undefined);
  const ai = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Alive', kind: 'enrich', type: 'text', config: { fn: 'domain_alive', inputs: { domain: '{{website}}' } } })).body;
  env.sql.prepare(`UPDATE rows SET data=json_set(data, '$.alive', 'yes')`).run();
  const aicopy = (await api.post(`/api/columns/${ai.id}/duplicate`)).body;
  assert.equal(aicopy.config.fn, 'domain_alive');
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.rows[0].data[aicopy.key], undefined);
});

test('catalog: every function has a known category and a provider, and keyed ones name their key', async () => {
  const env = fakeEnv(); const api = await client(env);
  const list = (await api.get('/api/functions')).body;
  const { CATEGORIES } = await import('../src/functions/index.js');
  assert.ok(list.length >= 15);
  for (const f of list) {
    assert.ok(CATEGORIES[f.category], `${f.id} has category ${f.category}`);
    assert.ok(f.provider);
    if (f.secret) assert.notEqual(f.provider, 'Free Clay'); else assert.equal(f.provider, 'Free Clay');
  }
  assert.equal(list.find((f) => f.id === 'hunter_email_finder').provider, 'Hunter');
});
