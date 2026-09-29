import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client } from './helpers.mjs';

async function setup() {
  const env = fakeEnv();
  const api = await client(env);
  const t = (await api.post('/api/tables', { name: 'Roofers' })).body;
  return { env, api, t };
}

test('a new table starts with one Name column and shows in bootstrap', async () => {
  const { api, t } = await setup();
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.deepEqual(full.columns.map((c) => [c.key, c.kind, c.type]), [['name', 'data', 'text']]);
  assert.deepEqual(full.rows, []);
  const boot = (await api.get('/api/bootstrap')).body;
  assert.deepEqual(boot.tables.map((x) => [x.name, x.row_count]), [['Roofers', 0]]);
});

test('columns get unique keys and bad kinds or types are refused', async () => {
  const { api, t } = await setup();
  const a = await api.post(`/api/tables/${t.id}/columns`, { name: 'Name', type: 'text' });
  assert.equal(a.body.key, 'name_2');
  assert.equal((await api.post(`/api/tables/${t.id}/columns`, { name: 'X', type: 'weird' })).status, 400);
  assert.equal((await api.post(`/api/tables/${t.id}/columns`, { name: 'X', kind: 'magic' })).status, 400);
  assert.equal((await api.post(`/api/tables/${t.id}/columns`, { name: '' })).status, 400);
});

test('rows are coerced to their column types on write', async () => {
  const { api, t } = await setup();
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Revenue', type: 'currency' });
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Founded', type: 'date' });
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Active', type: 'checkbox' });
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Tags', type: 'multi_select' });
  const r = await api.post(`/api/tables/${t.id}/rows`, { data: { name: 'Acme', revenue: '$1,250.50', founded: '9/27/2026', active: 'yes', tags: 'a, b, a', junk: 'dropped' } });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.rows[0].data, { name: 'Acme', revenue: 1250.5, founded: '2026-09-27', active: true, tags: ['a', 'b'] });
});

test('a row patch sets and clears single cells without touching the others', async () => {
  const { api, t } = await setup();
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Email', type: 'email' });
  const row = (await api.post(`/api/tables/${t.id}/rows`, { data: { name: 'Acme', email: 'A@Acme.com' } })).body.rows[0];
  let p = await api.patch(`/api/rows/${row.id}`, { data: { email: null } });
  assert.deepEqual(p.body.data, { name: 'Acme' });
  p = await api.patch(`/api/rows/${row.id}`, { data: { email: ' Bob@Acme.com ' } });
  assert.deepEqual(p.body.data, { name: 'Acme', email: 'bob@acme.com' });
});

test('a value that does not fit its type is kept as text, never lost', async () => {
  const { api, t } = await setup();
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Employees', type: 'number' });
  const row = (await api.post(`/api/tables/${t.id}/rows`, { data: { employees: 'about 40' } })).body.rows[0];
  assert.equal(row.data.employees, 'about 40');
});

test('CSV import maps aliased headers, makes new typed columns and keeps quoted commas', async () => {
  const { api, t } = await setup();
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Website', type: 'url' });
  const csv = 'Company Name,Company Website,Work Email,Employees\r\n"Acme, Inc",acme.example.com,ann@acme.example.com,12\r\nBeta,beta.example.com,bob@beta.example.com,40\r\n';
  const r = await api.post(`/api/tables/${t.id}/import`, csv);
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 2);
  assert.deepEqual(r.body.created_columns, ['Company Name', 'Work Email', 'Employees']);
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  const byName = Object.fromEntries(full.columns.map((c) => [c.name, c]));
  assert.equal(byName['Work Email'].type, 'email');
  assert.equal(byName.Employees.type, 'number');
  assert.equal(full.rows[0].data.website, 'acme.example.com');
  assert.equal(full.rows[0].data.company_name, 'Acme, Inc');
  assert.equal(full.rows[1].data.employees, 40);
});

test('a new table can be created straight from a CSV', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = (await api.post('/api/tables', { name: 'From CSV', csv: 'Domain,City\nacme.example.com,Tampa\n' })).body;
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.deepEqual(full.columns.map((c) => c.name), ['Domain', 'City']);
  assert.equal(full.rows.length, 1);
});

test('CSV export is formula-safe', async () => {
  const { api, t } = await setup();
  await api.post(`/api/tables/${t.id}/rows`, { rows: [{ name: '=HYPERLINK("http://evil")' }, { name: 'Plain, with comma' }] });
  const r = await api.get(`/api/tables/${t.id}/export.csv`);
  assert.equal(r.body, `Name\r\n"'=HYPERLINK(""http://evil"")"\r\n"Plain, with comma"\r\n`);
});

test('deleting a column removes its values from every row', async () => {
  const { env, api, t } = await setup();
  const col = (await api.post(`/api/tables/${t.id}/columns`, { name: 'City' })).body;
  await api.post(`/api/tables/${t.id}/rows`, { data: { name: 'A', city: 'Tampa' } });
  assert.equal((await api.del(`/api/columns/${col.id}`)).status, 200);
  assert.equal(env.sql.prepare('SELECT data FROM rows').get().data, '{"name":"A"}');
});

test('rows delete in bulk and only from their own table', async () => {
  const { api, t } = await setup();
  const other = (await api.post('/api/tables', { name: 'Other' })).body;
  const mine = (await api.post(`/api/tables/${t.id}/rows`, { rows: [{ name: 'a' }, { name: 'b' }] })).body.rows;
  const theirs = (await api.post(`/api/tables/${other.id}/rows`, { data: { name: 'c' } })).body.rows;
  await api.post(`/api/tables/${t.id}/rows/delete`, { ids: [mine[0].id, theirs[0].id] });
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.rows.length, 1);
  assert.equal((await api.get(`/api/tables/${other.id}`)).body.rows.length, 1);
});

test('columns reorder, rename and resize', async () => {
  const { api, t } = await setup();
  const b = (await api.post(`/api/tables/${t.id}/columns`, { name: 'B' })).body;
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  await api.put(`/api/tables/${t.id}/columns/order`, { ids: [b.id, full.columns[0].id] });
  await api.patch(`/api/columns/${b.id}`, { name: 'Bee', width: 5 });
  const after = (await api.get(`/api/tables/${t.id}`)).body.columns;
  assert.deepEqual(after.map((c) => [c.name, c.width]), [['Bee', 60], ['Name', null]]);
});

test('saved views round-trip and deleted tables disappear', async () => {
  const { api, t } = await setup();
  const v = (await api.post(`/api/tables/${t.id}/views`, { name: 'Tampa', config: { filters: [{ col: 'city', op: 'is', value: 'Tampa' }] } })).body;
  await api.patch(`/api/views/${v.id}`, { name: 'Tampa only' });
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.views[0].name, 'Tampa only');
  await api.del(`/api/tables/${t.id}`);
  assert.equal((await api.get(`/api/tables/${t.id}`)).status, 404);
});

test('secret names are validated and the password can never be referenced', async () => {
  const { api } = await setup();
  assert.equal((await api.post('/api/secrets', { name: 'APP_PASSWORD' })).status, 400);
  assert.equal((await api.post('/api/secrets', { name: 'bad name' })).status, 400);
  assert.equal((await api.post('/api/secrets', { name: 'hunter_api_key' })).status, 201);
  assert.deepEqual((await api.get('/api/bootstrap')).body.secrets.map((s) => s.name), ['HUNTER_API_KEY']);
});

test('the first import into a fresh table replaces its empty default Name column, later imports never do', async () => {
  const { api, t } = await setup();
  await api.post(`/api/tables/${t.id}/import`, 'Company,Website\nAcme,acme.example.com\n');
  let cols = (await api.get(`/api/tables/${t.id}`)).body.columns.map((c) => c.name);
  assert.deepEqual(cols, ['Company', 'Website']);
  const t2 = (await api.post('/api/tables', { name: 'Two' })).body;
  await api.post(`/api/tables/${t2.id}/import`, 'Full Name,City\nAnn Lee,Tampa\n');
  cols = (await api.get(`/api/tables/${t2.id}`)).body.columns.map((c) => c.name);
  assert.deepEqual(cols, ['Name', 'City']);            // "Full Name" filled the Name column, so it stays
});
