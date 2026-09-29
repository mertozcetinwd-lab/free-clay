import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch } from './helpers.mjs';
import { wikidataQuery, checkWikidataSearch, fromWikidata, MAX_SEC_DETAILS } from '../src/opendata/companies.js';
import { toSlug, MAX_SLUGS } from '../src/opendata/jobs.js';

async function setup(routes, { contact = true } = {}) {
  const f = fakeFetch(routes);
  const env = fakeEnv(); const api = await client(env, { fetch: f });
  if (contact) await api.patch('/api/settings', { contact_email: 'me@example.com' });
  return { f, env, api };
}

const binding = (id, name, extra = {}) => ({ c: { value: `http://www.wikidata.org/entity/Q${id}` }, cLabel: { value: name },
  ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, { value: v }])) });
const WIKI = { results: { bindings: [
  binding(1, 'Acme Roofing', { site: 'https://www.acmeroof.example.com/', emp: '120', inc: '1987-01-01T00:00:00Z', hqLabel: 'Tampa', indLabel: 'roofing' }),
  binding(1, 'Acme Roofing', { site: 'https://acme2.example.com/', emp: '150' }),   // same company, a second row
  binding(2, 'Q2'),                                                                    // no English label
  { c: { value: 'https://evil.example.com/Q3' }, cLabel: { value: 'Not Wikidata' } },
] } };

test('wikidata: the query escapes the industry, matches the state by ISO code, and rows merge per company', () => {
  const s = checkWikidataSearch({ industry: 'Construction', state: 'fl' });
  assert.deepEqual(s, { source: 'wikidata', industry: 'construction', state: 'FL' });
  const q = wikidataQuery(s);
  assert.match(q, /mwapi:search "construction"/); assert.match(q, /wdt:P300 "US-FL"/);
  assert.match(wikidataQuery(checkWikidataSearch({ industry: "O'Neil & Sons" })), /mwapi:search "o'neil & sons"/);
  assert.match(wikidataQuery(checkWikidataSearch({ industry: 'software' })), /wdt:P17 wd:Q30/);   // all states: US
  assert.throws(() => checkWikidataSearch({ industry: 'x" } ; DROP' }), /industry/);
  assert.throws(() => checkWikidataSearch({ industry: 'software', state: 'ZZ' }), /state/);
  const rows = fromWikidata(WIKI);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { name: 'Acme Roofing', website: 'https://www.acmeroof.example.com/', domain: 'acmeroof.example.com', industry: 'roofing',
    employees: 150, founded: 1987, hq: 'Tampa', state: null, ticker: null, exchange: null, phone: null, source_url: 'https://www.wikidata.org/entity/Q1' });
});

test('wikidata search: one request, cached, then imported with dedupe by source link', async () => {
  const { f, api } = await setup({ 'query.wikidata.org': WIKI });
  const r = (await api.post('/api/find/companies/wikidata', { industry: 'roofing', state: 'FL' })).body;
  assert.equal(r.results.length, 1); assert.equal(r.results[0].state, 'FL');
  await api.post('/api/find/companies/wikidata', { industry: 'Roofing', state: 'fl' });
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].headers.get('user-agent'), /FreeClay\/1\.0.*me@example\.com/);
  const search = { source: 'wikidata', industry: 'roofing', state: 'FL' };
  const imp = (await api.post('/api/find/companies/import', { search, new_name: 'FL roofers' })).body;
  assert.equal(imp.added, 1);
  assert.equal((await api.post('/api/find/companies/import', { search, table_id: imp.table_id })).body.added, 0);
  const t = (await api.get(`/api/tables/${imp.table_id}`)).body;
  const col = (n) => t.columns.find((c) => c.name === n);
  assert.equal(col('Employees').type, 'number'); assert.equal(t.rows[0].data[col('Domain').key], 'acmeroof.example.com');
});

test('wikidata errors are clear and not cached', async () => {
  let n = 0;
  const { api } = await setup({ 'query.wikidata.org': () => (++n === 1 ? new Response('busy', { status: 429 }) : WIKI) });
  const bad = await api.post('/api/find/companies/wikidata', { industry: 'roofing' });
  assert.equal(bad.status, 503); assert.match(bad.body.error, /rate-limiting/);
  assert.equal((await api.post('/api/find/companies/wikidata', { industry: 'roofing' })).body.results.length, 1);
});

const TICKERS = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [
  [354950, 'HOME DEPOT, INC.', 'HD', 'NYSE'], [1, 'Depot Holdings', 'DPT', 'OTC'], [320193, 'Apple Inc.', 'AAPL', 'Nasdaq'],
  [354950, 'HOME DEPOT, INC.', 'HD-PB', 'NYSE'],   // second share class
] };
const SUBMISSION = { sicDescription: 'Retail-Lumber & Other Building Materials Dealers', phone: '770-433-8211', website: 'https://www.homedepot.com',
  addresses: { business: { street1: '2455 Paces Ferry Road', city: 'Atlanta', stateOrCountry: 'GA', zipCode: '30339' } } };

test('sec: needs the contact email, ranks the exact ticker first, one row per company, details capped and merged', async () => {
  const none = await setup({ 'sec.gov': TICKERS }, { contact: false });
  assert.match((await none.api.post('/api/find/companies/sec', { q: 'hd' })).body.error, /contact email/);
  assert.equal(none.f.calls.length, 0);
  const { f, api } = await setup({ 'company_tickers_exchange.json': TICKERS, 'CIK0000354950.json': SUBMISSION });
  const r = (await api.post('/api/find/companies/sec', { q: 'HD' })).body;
  assert.deepEqual(r.results.map((c) => c.ticker), ['HD']);
  const d = (await api.post('/api/find/companies/sec', { q: 'depot' })).body.results;
  assert.deepEqual(d.map((c) => c.name), ['Depot Holdings', 'HOME DEPOT, INC.']);   // starts-with before contains
  assert.match(d[1].source_url, /CIK=0000354950/);
  const big = Array.from({ length: MAX_SEC_DETAILS + 1 }, (_, i) => i + 1);
  assert.equal((await api.post('/api/find/companies/sec-details', { search: { q: 'depot' }, ciks: big })).status, 400);
  const det = (await api.post('/api/find/companies/sec-details', { search: { q: 'depot' }, ciks: [354950] })).body.results;
  assert.deepEqual([det[1].industry, det[1].state, det[1].domain, det[1].phone], ['Retail-Lumber & Other Building Materials Dealers', 'GA', 'homedepot.com', '770-433-8211']);
  await api.post('/api/find/companies/sec-details', { search: { q: 'depot' }, ciks: [354950] });
  assert.equal(f.calls.filter((c) => c.url.includes('CIK0000354950')).length, 1);   // cached per company
  const imp = (await api.post('/api/find/companies/import', { search: { source: 'sec', q: 'depot' }, new_name: 'x', only: [det[1].source_url] })).body;
  assert.equal(imp.added, 1);
});

const GH = { jobs: [{ title: 'Roofing Estimator', location: { name: 'Tampa, FL' }, departments: [{ name: 'Sales' }], first_published: '2026-09-01T10:00:00Z', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' },
  { title: 'Engineer', location: { name: 'Remote' }, absolute_url: 'javascript:alert(1)' },
  { title: 'Backend Engineer', location: { name: 'Remote' }, departments: [{ name: 'Engineering' }], absolute_url: 'https://boards.greenhouse.io/acme/jobs/3' }] };
const LEVER = [{ text: 'Account Executive', categories: { location: 'NYC', team: 'Sales' }, createdAt: Date.parse('2026-09-10'), hostedUrl: 'https://jobs.lever.co/beta/2' }];

test('jobs: slugs from domains and board links; each tried on all three boards; keyword filter; cached; imported once', async () => {
  assert.equal(toSlug('https://www.discord.com/careers'), 'discord');
  assert.equal(toSlug('notion.so'), 'notion');
  assert.equal(toSlug('https://jobs.lever.co/netflix'), 'netflix');
  assert.equal(toSlug('https://boards-api.greenhouse.io/v1/boards/gitlab/jobs'), 'gitlab');
  const { f, api } = await setup({
    'greenhouse.io/v1/boards/acme/': GH, 'lever.co/v0/postings/acme': () => new Response('', { status: 404 }), 'ashbyhq.com/posting-api/job-board/acme': () => new Response('', { status: 404 }),
    'greenhouse.io/v1/boards/beta/': () => new Response('', { status: 404 }), 'lever.co/v0/postings/beta': LEVER, 'ashbyhq.com/posting-api/job-board/beta': () => new Response('', { status: 404 }),
    'greenhouse.io/v1/boards/gamma/': () => new Response('', { status: 404 }), 'lever.co/v0/postings/gamma': () => new Response('', { status: 404 }), 'ashbyhq.com/posting-api/job-board/gamma': () => new Error('down'),
  }, { contact: false });
  const r = (await api.post('/api/find/jobs', { companies: 'acme.com, beta, Gamma' })).body;
  assert.deepEqual(r.results.map((j) => [j.company, j.title, j.ats]), [['acme', 'Roofing Estimator', 'greenhouse'], ['acme', 'Backend Engineer', 'greenhouse'], ['beta', 'Account Executive', 'lever']]);
  assert.equal(r.results[0].posted, '2026-09-01');
  assert.deepEqual(r.boards, { acme: 'greenhouse, 2 open', beta: 'lever, 1 open', gamma: 'no public board found' });
  const k = (await api.post('/api/find/jobs', { companies: 'acme beta gamma', keyword: 'sales' })).body;
  assert.deepEqual(k.results.map((j) => j.title), ['Roofing Estimator', 'Account Executive']);   // department counts too
  assert.equal(f.calls.length, 9);    // second search answered from each board's cache
  const imp = (await api.post('/api/find/jobs/import', { search: { companies: 'acme,beta,gamma' }, new_name: 'Hiring' })).body;
  assert.equal(imp.added, 3);
  assert.equal((await api.post('/api/find/jobs/import', { search: { companies: 'acme,beta,gamma' }, table_id: imp.table_id })).body.added, 0);
  const many = Array.from({ length: MAX_SLUGS + 1 }, (_, i) => `co${i}`).join(',');
  assert.equal((await api.post('/api/find/jobs', { companies: many })).status, 400);
});
