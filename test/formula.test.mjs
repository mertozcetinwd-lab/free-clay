import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, evaluate, checkFormula, computeRow, conditionTrue } from '../public/js/formula.js';
import { fakeEnv, client, fakeFetch, dns } from './helpers.mjs';

const run = (src, data = {}) => evaluate(parse(src), data, { now: Date.parse('2026-09-27T12:00:00Z') });

test('arithmetic, precedence and concatenation', () => {
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('-2 * -3'), 6);
  assert.equal(run('10 % 4'), 2);
  assert.equal(run('"a" & 1 & TRUE'), 'a1TRUE');
  assert.equal(run('{{a}} + {{b}}', { a: '$1,200', b: 3 }), 1203);
});

test('comparisons and logic, with lazy IF / AND / OR', () => {
  assert.equal(run('{{n}} >= 10 AND {{n}} < 20', { n: 15 }), true);
  assert.equal(run('"Acme" = "acme"'), true);
  assert.equal(run('2 <> 3'), true);
  assert.equal(run('NOT({{x}})', { x: '' }), true);
  assert.equal(run('IF({{n}} > 0, "pos", 1 / 0)', { n: 5 }), 'pos');   // the other branch never runs
  assert.equal(run('OR(TRUE, 1 / 0)'), true);
  assert.equal(run('IF(FALSE, 1)'), null);
});

test('text functions', () => {
  assert.equal(run('UPPER(LEFT({{n}}, 3))', { n: 'acme roofing' }), 'ACM');
  assert.equal(run('PROPER("mary o\'brien-smith")'), "Mary O'Brien-Smith");
  assert.equal(run('SPLIT("a, b, c", ",", 2)'), 'b');
  assert.equal(run('DOMAIN("https://www.Acme.com/about")'), 'acme.com');
  assert.equal(run('DOMAIN("bob@acme.co.uk")'), 'acme.co.uk');
  assert.equal(run('CONTAINS("Roofing Co", "roof")'), true);
  assert.equal(run('FIRSTWORD("  Ann Lee ")'), 'Ann');
  assert.equal(run('COALESCE({{a}}, {{b}}, "none")', { b: 'x' }), 'x');
  assert.equal(run('LEN({{missing}})'), 0);
});

test('numbers and dates', () => {
  assert.equal(run('ROUND(10 / 3, 2)'), 3.33);
  assert.equal(run('MAX(1, {{a}}, 7)', { a: 9 }), 9);
  assert.equal(run('TODAY()'), '2026-09-27');
  assert.equal(run('DATEADD("2026-09-27", 5)'), '2026-10-02');
  assert.equal(run('DATEDIFF("9/1/2026", "2026-09-27")'), 26);
  assert.equal(run('YEAR({{d}})', { d: 'Sep 27, 2026' }), 2026);
});

test('errors are readable and never escape as exceptions from computeRow', () => {
  assert.match(checkFormula('1 +'), /ends too early/);
  assert.match(checkFormula('FOO(1)'), /Unknown function FOO/);
  assert.match(checkFormula('website'), /Columns are written/);
  assert.match(checkFormula('IF(1)'), /IF takes 2 to 3 arguments/);
  assert.match(checkFormula('"open'), /not closed/);
  assert.equal(checkFormula(''), 'The formula is empty');
  assert.throws(() => run('1 / 0'), /Division by zero/);
  assert.throws(() => run('{{a}} * 2', { a: 'lots' }), /needs a number/);
});

test('there is no way to reach JavaScript from a formula', () => {
  for (const src of ['constructor', 'this', 'process.exit(1)', 'globalThis', '{{__proto__}}.x', 'eval("1")', '`x`', 'a[0]']) {
    assert.ok(checkFormula(src), `should reject: ${src}`);
  }
  assert.equal(run('{{constructor}}', {}), null);
  assert.throws(() => run(Array(80).fill('(').join('') + '1' + Array(80).fill(')').join('')), /nested too deeply/);
});

test('computeRow: formulas can use formulas, cycles become cell errors', () => {
  const cols = [
    { key: 'a', kind: 'data' },
    { key: 'f2', kind: 'formula', config: { formula: '{{f1}} * 2' } },
    { key: 'f1', kind: 'formula', config: { formula: '{{a}} + 1' } },
    { key: 'c1', kind: 'formula', config: { formula: '{{c2}}' } },
    { key: 'c2', kind: 'formula', config: { formula: '{{c1}}' } },
    { key: 'bad', kind: 'formula', config: { formula: '1 +' } },
  ];
  const out = computeRow({ data: { a: 4 } }, cols);
  assert.equal(out.f1, 5); assert.equal(out.f2, 10);
  assert.match(out._errors.c1, /refers to itself/);
  assert.match(out._errors.bad, /ends too early/);
  assert.equal(conditionTrue('{{a}} > 3', { a: 4 }), true);
  assert.equal(conditionTrue('1 +', {}), false);
});

test('API: formula columns are validated, computed in exports and never stored', async () => {
  const env = fakeEnv(); const api = await client(env);
  const t = (await api.post('/api/tables', { name: 'F' })).body;
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Website', type: 'url' });
  assert.equal((await api.post(`/api/tables/${t.id}/columns`, { name: 'D', kind: 'formula', config: { formula: 'DOMAIN(' } })).status, 400);
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Domain', kind: 'formula', config: { formula: 'DOMAIN({{website}})' } });
  await api.post(`/api/tables/${t.id}/rows`, { data: { name: 'Acme', website: 'https://www.acme.example.com/x', domain: 'ignored' } });
  assert.equal(env.sql.prepare('SELECT data FROM rows').get().data, '{"name":"Acme","website":"https://www.acme.example.com/x"}');
  const csv = (await api.get(`/api/tables/${t.id}/export.csv`)).body;
  assert.equal(csv.split('\r\n')[1], 'Acme,https://www.acme.example.com/x,acme.example.com');
});

test('API: a run condition gates spending, and inputs can come from a formula column', async () => {
  const f = fakeFetch({ 'cloudflare-dns.com': dns([[1, '1.1.1.1']]) });
  const env = fakeEnv(); const api = await client(env, { fetch: f });
  const t = (await api.post('/api/tables', { name: 'F' })).body;
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Website', type: 'url' });
  await api.post(`/api/tables/${t.id}/columns`, { name: 'Domain', kind: 'formula', config: { formula: 'DOMAIN({{website}})' } });
  assert.equal((await api.post(`/api/tables/${t.id}/columns`, { name: 'x', kind: 'enrich', config: { fn: 'domain_alive', inputs: { domain: '{{domain}}' }, condition: 'LEN(' } })).status, 400);
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Alive', kind: 'enrich', type: 'checkbox',
    config: { fn: 'domain_alive', inputs: { domain: '{{domain}}' }, condition: 'NOT(CONTAINS({{name}}, "skip"))' } })).body;
  await api.post(`/api/tables/${t.id}/rows`, { rows: [{ name: 'Acme', website: 'https://www.acme.example.com' }, { name: 'skip me', website: 'b.example.com' }] });
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  const full = (await api.get(`/api/tables/${t.id}`)).body;
  assert.deepEqual(full.meta.map((m) => m.status), ['done', 'skipped']);
  assert.equal(f.calls.length, 1);
  assert.ok(f.calls[0].url.includes('name=acme.example.com'));
});
