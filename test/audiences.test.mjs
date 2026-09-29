import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client } from './helpers.mjs';
import { cleanRecord, recordKey, filterSql } from '../src/audiences.js';
import { guessMap } from '../public/js/audience-fields.js';

test('records: cleaned, typed, keyed by email or domain', () => {
  const p = cleanRecord('people', { email: ' Ana@Example.COM ', first_name: 'Ana', last_name: 'Testrow', junk: 'x', phone: '' });
  assert.deepEqual(p, { first_name: 'Ana', last_name: 'Testrow', email: 'ana@example.com', domain: 'example.com', full_name: 'Ana Testrow' });
  assert.equal(recordKey('people', p), 'e:ana@example.com');
  // Free mail does not become the company domain.
  assert.equal(cleanRecord('people', { email: 'bob@gmail.com' }).domain, undefined);
  assert.equal(recordKey('people', cleanRecord('people', { full_name: 'Bob  Smith', company: 'Acme' })), 'n:bob smith|acme');
  assert.equal(recordKey('people', cleanRecord('people', { full_name: 'Nobody' })), null);
  const c = cleanRecord('companies', { name: 'Acme', website: 'https://www.Acme.com/about', employees: '1,200' });
  assert.equal(c.domain, 'acme.com');
  assert.equal(c.employees, 1200);
  assert.equal(recordKey('companies', c), 'd:acme.com');
  assert.equal(cleanRecord('people', { email: 'not an email' }).email, undefined);
});

test('upsert: the same person twice is one record, new values fill blanks, old values stay', async () => {
  const env = fakeEnv(); const api = await client(env);
  let r = (await api.post('/api/audiences/people/upsert', { source: 'Test', records: [
    { email: 'ana@example.com', first_name: 'Ana' },
    { email: 'ANA@example.com', title: 'Owner' },          // same person in one batch
    { email: 'ben@example.org', full_name: 'Ben' },
    { full_name: 'No Key' },                                 // not enough to tell who: skipped
  ] })).body;
  assert.deepEqual(r, { added: 2, updated: 0, skipped: 1 });
  r = (await api.post('/api/audiences/people/upsert', { source: 'Later', records: [{ email: 'ana@example.com', first_name: 'Anna', phone: '555' }] })).body;
  assert.deepEqual(r, { added: 0, updated: 1, skipped: 0 });
  const list = (await api.get('/api/audiences/people?sort=email&dir=asc')).body;
  assert.equal(list.total, 2);
  const ana = list.records[0];
  assert.equal(ana.data.first_name, 'Ana');          // kept: it was already filled
  assert.equal(ana.data.title, 'Owner');
  assert.equal(ana.data.phone, '555');               // filled: it was empty
  assert.equal(ana.sources.first_name.source, 'Test');
  assert.equal(ana.sources.phone.source, 'Later');
  // overwrite: new values win
  await api.post('/api/audiences/people/upsert', { records: [{ email: 'ana@example.com', first_name: 'Anna' }], overwrite: true });
  assert.equal((await api.get(`/api/audiences/people/${ana.id}`)).body.data.first_name, 'Anna');
});

test('filters and search run in SQL with bound values; unknown fields are refused', async () => {
  const env = fakeEnv(); const api = await client(env);
  await api.post('/api/audiences/companies/upsert', { records: [
    { name: 'Gator Roofing', domain: 'gator.example.com', employees: 12, city: 'Gainesville' },
    { name: 'Swamp HVAC', domain: 'swamp.example.com', employees: 40, city: 'Ocala' },
    { name: 'Oak Plumbing', domain: 'oak.example.com', city: 'Gainesville' },
  ] });
  const q = async (filters, extra = '') => (await api.get(`/api/audiences/companies?filters=${encodeURIComponent(JSON.stringify(filters))}${extra}`)).body;
  assert.equal((await q([{ field: 'city', op: 'equals', value: 'gainesville' }])).total, 2);
  assert.equal((await q([{ field: 'employees', op: 'gt', value: '20' }])).total, 1);
  assert.equal((await q([{ field: 'employees', op: 'empty' }])).total, 1);
  assert.equal((await q([{ field: 'name', op: 'contains', value: 'roof' }])).total, 1);
  assert.equal((await q([{ field: 'name', op: 'starts_with', value: 'oak' }])).total, 1);
  assert.equal((await q([{ field: 'name', op: 'not_contains', value: 'roof' }])).total, 2);
  assert.equal((await q([], '&q=ocala')).total, 1);
  assert.equal((await api.get(`/api/audiences/companies?filters=${encodeURIComponent(JSON.stringify([{ field: "name') OR 1=1 --", op: 'equals', value: 'x' }]))}`)).status, 400);
  assert.equal((await api.get('/api/audiences/robots')).status, 404);
  // A value that looks like SQL is only ever a value.
  const { args } = filterSql('companies', { filters: [{ field: 'name', op: 'equals', value: "x' OR '1'='1" }] });
  assert.ok(args.includes("x' or '1'='1"));
  assert.equal((await q([{ field: 'name', op: 'equals', value: "x' OR '1'='1" }])).total, 0);
});

test('segments save filters and count live; edits re-key and refuse clashes; delete', async () => {
  const env = fakeEnv(); const api = await client(env);
  await api.post('/api/audiences/people/upsert', { records: [
    { email: 'a@acme.com', title: 'Owner' }, { email: 'b@acme.com', title: 'Office manager' }, { email: 'c@beta.com', title: 'Owner' }] });
  const s = (await api.post('/api/segments', { kind: 'people', name: 'Owners', filters: [{ field: 'title', op: 'equals', value: 'owner' }] })).body;
  assert.equal((await api.get('/api/segments')).body[0].count, 2);
  assert.equal((await api.get(`/api/audiences/people?segment=${s.id}`)).body.total, 2);
  assert.equal((await api.get(`/api/audiences/companies?segment=${s.id}`)).status, 400);
  assert.equal((await api.post('/api/segments', { kind: 'people', name: '' })).status, 400);
  const all = (await api.get('/api/audiences/people?sort=email&dir=asc')).body.records;
  assert.equal((await api.patch(`/api/audiences/people/${all[0].id}`, { data: { email: 'b@acme.com' } })).status, 409);
  const moved = (await api.patch(`/api/audiences/people/${all[0].id}`, { data: { email: 'new@acme.com', title: null } })).body;
  assert.equal(moved.data.email, 'new@acme.com');
  assert.equal(moved.data.title, undefined);
  assert.equal(moved.sources.email.source, 'Edited by hand');
  assert.equal((await api.get('/api/segments')).body[0].count, 1);
  await api.post('/api/audiences/people/delete', { ids: [all[1].id] });
  assert.equal((await api.get('/api/audiences/people')).body.total, 2);
  const stats = (await api.get('/api/audiences/stats')).body;
  assert.equal(stats.people.total, 2);
  assert.equal(stats.people.filled.email, 2);
  await api.del(`/api/segments/${s.id}`);
  assert.equal((await api.get('/api/segments')).body.length, 0);
});

test('a table goes into People by column names, and People come back out as a table', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = (await api.post('/api/tables', { name: 'Leads', csv: 'First name,Last name,Work Email,Company\nAna,Testrow,ana@example.com,Example Roofing\nBen,Testrow,ben@example.org,Example HVAC\n' })).body;
  const cols = (await api.get(`/api/tables/${t.id}`)).body.columns;
  assert.deepEqual(Object.keys(guessMap('people', cols)).sort(), ['company', 'email', 'first_name', 'last_name']);
  const r = (await api.post('/api/audiences/people/from-table', { table_id: t.id })).body;
  assert.equal(r.added, 2);
  const ana = (await api.get('/api/audiences/people?q=ana')).body.records[0];
  assert.equal(ana.data.full_name, 'Ana Testrow');
  assert.equal(ana.sources.email.source, 'Table: Leads');
  const out = (await api.post('/api/audiences/people/to-table', { name: 'Back out' })).body;
  const back = (await api.get(`/api/tables/${out.table_id}`)).body;
  assert.equal(back.rows.length, 2);
  assert.ok(back.columns.some((c) => c.name === 'Email'));
  assert.equal((await api.post('/api/audiences/people/from-table', { table_id: t.id, map: { email: 'nope' } })).status, 400);
  assert.equal((await api.post('/api/audiences/people/to-table', { q: 'nobody-matches' })).status, 400);
});

test('a CSV goes straight into Companies', async () => {
  const env = fakeEnv(); const api = await client(env);
  const r = (await api.post('/api/audiences/companies/import?name=list.csv', 'Company Name,Website,City\nAcme,https://acme.example.com,Tampa\nBeta,beta.example.com,Miami\n')).body;
  assert.equal(r.added, 2);
  assert.deepEqual(r.matched.sort(), ['city', 'name', 'website']);
  const acme = (await api.get('/api/audiences/companies?q=acme')).body.records[0];
  assert.equal(acme.data.domain, 'acme.example.com');
  assert.equal(acme.sources.name.source, 'CSV: list.csv');
  assert.equal((await api.post('/api/audiences/companies/import', 'Foo,Bar\n1,2\n')).status, 400);
});

test('Find leads results save into Companies from the saved search, not from the browser', async () => {
  const { fakeFetch } = await import('./helpers.mjs');
  const env = fakeEnv();
  const api = await client(env, { fetch: fakeFetch({}) });
  const places = [
    { name: 'Gator Ridge Roofing', lat: 29.652, lon: -82.325, phone: '+1 352 555 0100', website: 'https://gatorroof.example.com/?utm_source=x', address: '10 SW 2nd Ave', city: 'Gainesville' },
    { name: 'Swamp City Roofers', lat: 29.653, lon: -82.326, website: 'https://swamp.example.com' },
  ];
  const search = { source: 'open', lat: 29.6516, lon: -82.3248, radius_m: 5000, category: 'roofer' };
  const found = await api.post('/api/find/local/open', { ...search, places });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  const r = (await api.post('/api/find/local/to-companies', { search })).body;
  assert.equal(r.added, 2);
  const g = (await api.get('/api/audiences/companies?q=gator')).body.records[0];
  assert.equal(g.data.domain, 'gatorroof.example.com');
  assert.equal(g.sources.name.source, 'Find leads: local businesses');
  assert.equal((await api.post('/api/find/local/to-companies', { search: { ...search, radius_m: 4000 } })).status, 409);
});

test('every table template builds through the checked plan builder', async () => {
  const { TABLE_TEMPLATES } = await import('../public/js/table-templates.js');
  const env = fakeEnv(); const api = await client(env);
  for (const t of TABLE_TEMPLATES.filter((x) => x.plan)) {
    const r = await api.post('/api/assist/build', { plan: t.plan });
    assert.equal(r.status, 201, `${t.id}: ${JSON.stringify(r.body)}`);
    const table = (await api.get(`/api/tables/${r.body.id}`)).body;
    assert.equal(table.columns.filter((c) => c.kind === 'enrich').length, t.plan.enrichments.length, `${t.id} lost an enrichment`);
  }
});
