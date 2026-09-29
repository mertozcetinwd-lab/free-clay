import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client } from './helpers.mjs';
import { scheduled } from '../src/index.js';

async function tableWithData(api, name = 'A') {
  const t = (await api.post('/api/tables', { name })).body;
  await api.post(`/api/tables/${t.id}/rows`, { rows: [{ name: 'x' }, { name: 'y' }] });
  return t;
}

test('folders: create, move a table in and out, rename, and removing one keeps its tables', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await tableWithData(api);
  const f = (await api.post('/api/folders', { name: ' Roofers ' })).body;
  assert.equal(f.name, 'Roofers');
  assert.equal((await api.post('/api/folders', { name: '  ' })).status, 400);
  await api.patch(`/api/tables/${t.id}`, { folder_id: f.id });
  let boot = (await api.get('/api/bootstrap')).body;
  assert.equal(boot.tables[0].folder_id, f.id);
  assert.deepEqual(boot.folders.map((x) => x.name), ['Roofers']);
  assert.equal((await api.patch(`/api/tables/${t.id}`, { folder_id: 999 })).status, 404);
  assert.equal((await api.patch(`/api/tables/${t.id}`, { folder_id: 'x' })).status, 400);
  await api.patch(`/api/folders/${f.id}`, { name: 'Tampa' });
  assert.equal((await api.get('/api/bootstrap')).body.folders[0].name, 'Tampa');
  await api.del(`/api/folders/${f.id}`);
  boot = (await api.get('/api/bootstrap')).body;
  assert.equal(boot.folders.length, 0);
  assert.equal(boot.tables.length, 1);
  assert.equal(boot.tables[0].folder_id, null);
  await api.patch(`/api/tables/${t.id}`, { folder_id: null });
});

test('trash: a deleted table is listed, restores whole, and only trashed tables can be restored', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await tableWithData(api);
  assert.equal((await api.post(`/api/trash/${t.id}/restore`)).status, 404);
  await api.del(`/api/tables/${t.id}`);
  assert.equal((await api.get('/api/bootstrap')).body.tables.length, 0);
  const trash = (await api.get('/api/trash')).body;
  assert.equal(trash.days, 30);
  assert.equal(trash.tables[0].id, t.id); assert.equal(trash.tables[0].row_count, 2);
  await api.post(`/api/trash/${t.id}/restore`);
  assert.equal((await api.get('/api/trash')).body.tables.length, 0);
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.rows.length, 2);
});

test('trash: a restored table whose folder was removed comes back to the top level', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = await tableWithData(api);
  const f = (await api.post('/api/folders', { name: 'F' })).body;
  await api.patch(`/api/tables/${t.id}`, { folder_id: f.id });
  await api.del(`/api/tables/${t.id}`);
  await api.del(`/api/folders/${f.id}`);
  env.sql.prepare('UPDATE tables SET folder_id=? WHERE id=?').run(f.id, t.id);   // a stale pointer
  await api.post(`/api/trash/${t.id}/restore`);
  assert.equal((await api.get('/api/bootstrap')).body.tables[0].folder_id, null);
});

test('delete forever removes the table and its rows but keeps the ledger; live tables cannot be purged', async () => {
  const env = fakeEnv(); const api = await client(env);
  const keep = await tableWithData(api, 'Keep');
  const t = await tableWithData(api, 'Gone');
  env.sql.prepare(`INSERT INTO ledger (ts, table_id, provider, cost_micros, outcome) VALUES (?, ?, 'x', 5, 'done')`).run(new Date().toISOString(), t.id);
  assert.equal((await api.del(`/api/trash/${t.id}`)).status, 404);
  await api.del(`/api/tables/${t.id}`);
  await api.del(`/api/trash/${t.id}`);
  const n = (q, id) => env.sql.prepare(q).get(id).n;
  assert.equal(n('SELECT count(*) AS n FROM tables WHERE id=?', t.id), 0);
  assert.equal(n('SELECT count(*) AS n FROM rows WHERE table_id=?', t.id), 0);
  assert.equal(n('SELECT count(*) AS n FROM columns WHERE table_id=?', t.id), 0);
  assert.equal(n('SELECT count(*) AS n FROM ledger WHERE table_id=?', t.id), 1);
  assert.equal(n('SELECT count(*) AS n FROM rows WHERE table_id=?', keep.id), 2);
});

test('the cron purges only tables older than 30 days in the trash', async () => {
  const env = fakeEnv(); const api = await client(env);
  const old = await tableWithData(api, 'Old');
  const fresh = await tableWithData(api, 'Fresh');
  await api.del(`/api/tables/${old.id}`); await api.del(`/api/tables/${fresh.id}`);
  const now = new Date('2026-10-30T12:00:00Z');
  env.sql.prepare('UPDATE tables SET deleted_at=? WHERE id=?').run('2026-09-29T12:00:00Z', old.id);    // 31 days
  env.sql.prepare('UPDATE tables SET deleted_at=? WHERE id=?').run('2026-10-02T12:00:00Z', fresh.id);  // 28 days
  await scheduled({}, env, {}, { now });
  const ids = (await api.get('/api/trash')).body.tables.map((x) => x.id);
  assert.deepEqual(ids, [fresh.id]);
  assert.equal(env.sql.prepare('SELECT count(*) AS n FROM rows WHERE table_id=?').get(old.id).n, 0);
});
