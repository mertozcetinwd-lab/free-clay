import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeEnv, client, fakeFetch } from './helpers.mjs';
import { spin, clean, render, messageRefs } from '../public/js/message.js';
import { processBatch } from '../src/runner.js';

const anthropic = (texts, prompts = []) => (r) => {
  const b = JSON.parse(r.body); prompts.push(b.messages[0].content);
  return { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: texts.shift() ?? 'ok' }], usage: { input_tokens: 100, output_tokens: 20 } };
};

async function table(api, csv) {
  const t = (await api.post('/api/tables', { name: 'T', csv })).body;
  const cols = (await api.get(`/api/tables/${t.id}`)).body.columns;
  return { t, key: (name) => cols.find((c) => c.name === name).key };
}

/* ---------------------------------------------------------------- the template language */

test('spintax: one option per row, stable for that row, and every option gets used', () => {
  assert.equal(spin('{Hi|Hello|Hey} there', 'row1'), spin('{Hi|Hello|Hey} there', 'row1'));
  const seen = new Set(Array.from({ length: 60 }, (_, i) => spin('{Hi|Hello|Hey}', `r${i}`)));
  assert.deepEqual([...seen].sort(), ['Hello', 'Hey', 'Hi']);
  assert.match(spin('{Good {morning|day}|Hi}', 'x'), /^(Good morning|Good day|Hi)$/);
  assert.equal(spin('Hi {{first_name}}, {no pipe here}', 'x'), 'Hi {{first_name}}, {no pipe here}');
});

test('clean variable: legal suffixes, domains, shouting and lowercase, acronyms kept', () => {
  assert.equal(clean('Acme Roofing, LLC'), 'Acme Roofing');
  assert.equal(clean('Acme Holdings, Inc.'), 'Acme Holdings');
  assert.equal(clean('relay.app inc.'), 'relay.app');
  assert.equal(clean('https://www.Example.com/about?x=1'), 'example.com');
  assert.equal(clean('ACME ROOFING'), 'Acme Roofing');
  assert.equal(clean('max'), 'Max');
  assert.equal(clean('co-founder & ceo'), 'Co-Founder & CEO');
  assert.equal(clean('IBM'), 'IBM');
  assert.equal(clean(null), '');
});

test('render: values are pasted as text, never read as template syntax', () => {
  const data = { company: 'Evil {a|b} Co {{secret:APP_PASSWORD}}', first: 'ana' };
  const out = render('{Hi|Hi} {{clean:first}} at {{company}}', data, {}, 's');
  assert.equal(out, 'Hi Ana at Evil {a|b} Co {{secret:APP_PASSWORD}}');
  assert.equal(render('Hi {{snippet:x}}', {}, { x: 'there {{first}}' }, 's'), 'Hi there {{first}}');
  assert.deepEqual(messageRefs('{{a}} {{clean:b}} {{snippet:c}} {{a}}'), { keys: ['a', 'b'], snippets: ['c'] });
});

/* ---------------------------------------------------------------- the column */

test('message column: columns, clean variables, spintax, an if/then and an AI snippet; subject and body out', async () => {
  const env = fakeEnv(); env.ANTHROPIC_API_KEY = 'sk-test';
  const prompts = [];
  const f = fakeFetch({ 'api.anthropic.com/v1/messages': anthropic(['Your AI teammate idea is sharp.', 'Tidy roofs, tidy books.'], prompts) });
  const api = await client(env, { fetch: f });
  const { t, key } = await table(api, 'First,Company,Employees,About\nana,Acme Roofing LLC,120,Roof repair in Ocala\nben,Blue Heron Inc.,,Roofs and gutters\ncara,Gator Co,9,\n');
  const subject = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Subject' })).body;
  const bodyCol = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Body' })).body;
  const c = await api.post(`/api/tables/${t.id}/columns`, { name: 'Email', kind: 'message', config: {
    subject: `{Quick question|A question} for {{clean:${key('Company')}}}`,
    body: `{Hi|Hello} {{clean:${key('First')}}},\n\n{{snippet:opener}}\n\n{{snippet:cta}}`,
    snippets: [
      { name: 'opener', kind: 'ai', provider: 'anthropic', model: 'claude-opus-5', max_tokens: 60, prompt: `One line about {{${key('Company')}}}: {{${key('About')}}}` },
      { name: 'cta', kind: 'if', condition: `{{${key('Employees')}}} > 50`, then: 'Worth a call with your ops lead?', else: 'Worth a quick call?' },
    ],
    outputs: [{ field: 'subject', column: subject.key }, { field: 'body', column: bodyCol.key }] } });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const run = (await api.post(`/api/tables/${t.id}/run`, { column_id: c.body.id, budget_micros: 1_000_000 })).body;
  assert.ok(run.per_cell_micros > 0);                  // the AI snippet is the cost
  await api.post('/api/run-batch');
  const got = (await api.get(`/api/tables/${t.id}`)).body;
  const [a, b, cc] = got.rows.map((r) => r.data);
  assert.match(a[subject.key], /^(Quick question|A question) for Acme Roofing$/);
  assert.match(a[bodyCol.key], /^(Hi|Hello) Ana,\n\nYour AI teammate idea is sharp\.\n\nWorth a call with your ops lead\?$/);
  assert.equal(a[c.body.key], `${a[subject.key]}\n\n${a[bodyCol.key]}`);
  assert.match(b[bodyCol.key], /Worth a quick call\?$/);   // an empty if/then column does not skip the row
  const m3 = got.meta.find((m) => m.row_id === got.rows[2].id && m.column_id === c.body.id);
  assert.equal(m3.status, 'skipped'); assert.equal(m3.error, 'Some inputs are empty: About');
  assert.equal(cc[c.body.key], undefined);
  assert.deepEqual(prompts, ['One line about Acme Roofing LLC: Roof repair in Ocala', 'One line about Blue Heron Inc.: Roofs and gutters']);
  const spent = env.sql.prepare(`SELECT count(*) n, sum(cost_micros) c FROM ledger WHERE column_id=?`).get(c.body.id);
  assert.equal(spent.n, 2); assert.ok(spent.c > 0);
  // Re-running gives each row the same spintax choice.
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.body.id, scope: 'all', budget_micros: 1_000_000 });
  await api.post('/api/run-batch');
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.rows[0].data[subject.key], a[subject.key]);
});

test('message config is checked', async () => {
  const env = fakeEnv();
  const api = await client(env);
  const { t } = await table(api, 'Name\nAna\n');
  const bad = async (config) => (await api.post(`/api/tables/${t.id}/columns`, { name: 'M', kind: 'message', config })).body.error;
  assert.match(await bad({ subject: 'x', body: '' }), /Write the message body/);
  assert.match(await bad({ body: 'Hi {{snippet:nope}}' }), /not in the snippet list/);
  assert.match(await bad({ body: 'x', snippets: [{ name: 'a', kind: 'ai', provider: 'groq', model: 'qwen/qwen3.8-27b', prompt: 'Write a line' }] }), /uses no column/);
  assert.match(await bad({ body: 'x {{secret:APP_PASSWORD}}' }), /Keys cannot go in a message/);
  assert.match(await bad({ body: 'x', snippets: [{ name: 'a', kind: 'if', condition: '1 = 1', then: 'y' }, { name: 'a', kind: 'if', condition: '1 = 1', then: 'z' }] }), /Two snippets/);
  assert.match(await bad({ body: 'x', snippets: [{ name: 'a', kind: 'if', condition: '1 = 1', then: '{{snippet:b}}' }] }), /cannot use another snippet/);
  assert.match(await bad({ body: 'x', snippets: [{ name: 'a', kind: 'if', condition: '((', then: 'y' }] }), /Snippet a/);
  assert.equal((await api.post(`/api/tables/${t.id}/columns`, { name: 'Plain', kind: 'message', config: { body: 'Hello {{name}}' } })).status, 201);
});

test('a message waits for a column its clean variable reads', async () => {
  const env = fakeEnv();
  const f = fakeFetch({ 'cloudflare-dns.com': { Status: 0, Answer: [{ name: 'x', type: 1, TTL: 60, data: '10.0.0.1' }] } });
  const api = await client(env, { fetch: f });
  const { t, key } = await table(api, 'Website\nhttps://www.example.com/x\n');
  const dom = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Domain', kind: 'enrich', type: 'text', config: { fn: 'normalize_domain', inputs: { text: `{{${key('Website')}}}` } } })).body;
  const msg = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Msg', kind: 'message', config: { body: `Saw {{clean:${dom.key}}}` } })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: msg.id });
  await api.post(`/api/tables/${t.id}/run`, { column_id: dom.id });
  const first = await processBatch(env, { fetch: f });
  assert.equal(first.claimed, 1);
  await processBatch(env, { fetch: f });
  assert.equal((await api.get(`/api/tables/${t.id}`)).body.rows[0].data[msg.key], 'Saw example.com');
});

/* ---------------------------------------------------------------- try on 5 rows */

test('try on 5 rows: runs unsaved settings on the first rows, writes no cell, ledgers the cost', async () => {
  const env = fakeEnv(); env.ANTHROPIC_API_KEY = 'sk-test';
  const f = fakeFetch({ 'api.anthropic.com/v1/messages': anthropic(['one', 'two', 'three', 'four', 'five', 'six']) });
  const api = await client(env, { fetch: f });
  const { t, key } = await table(api, `Name\n${Array.from({ length: 7 }, (_, i) => `Row ${i}`).join('\n')}\n`);
  const before = (await api.get(`/api/tables/${t.id}`)).body.columns.length;
  const r = await api.post(`/api/tables/${t.id}/try`, { kind: 'ai', config: { provider: 'anthropic', model: 'claude-opus-5', max_tokens: 50, prompt: `Say hi to {{${key('Name')}}}` } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.tried, 5);
  assert.deepEqual(r.body.results.map((x) => x.value), ['one', 'two', 'three', 'four', 'five']);
  assert.ok(r.body.cost_micros > 0);
  const after = (await api.get(`/api/tables/${t.id}`)).body;
  assert.equal(after.columns.length, before);
  assert.equal(after.meta.length, 0);
  assert.equal(env.sql.prepare(`SELECT count(*) n FROM ledger WHERE note LIKE 'try:%'`).get().n, 5);
  // A worst case over the budget per run tries fewer rows, or none.
  await api.patch('/api/settings', { default_budget_micros: 1 });
  const none = await api.post(`/api/tables/${t.id}/try`, { kind: 'ai', config: { provider: 'anthropic', model: 'claude-opus-5', max_tokens: 50, prompt: `Hi {{${key('Name')}}}` } });
  assert.equal(none.status, 400); assert.match(none.body.error, /over your budget per run/);
  assert.equal((await api.post(`/api/tables/${t.id}/try`, { kind: 'ai', config: { agent_id: 1, inputs: {} } })).status, 400);
  assert.equal((await api.post(`/api/tables/${t.id}/try`, { kind: 'formula', config: { formula: '1' } })).status, 400);
});

/* ---------------------------------------------------------------- the prompt writer */

test('prompt writer: a structured draft that may only use real columns', async () => {
  const env = fakeEnv(); env.GROQ_API_KEY = 'gsk-test';
  let reply = '#CONTEXT#\nYou write openers.\n#OBJECTIVE#\nWrite one line to {{first_name}} about {{about}}.\n#INSTRUCTIONS#\nUse only the row.\n#OUTPUT#\nOne line.';
  const f = fakeFetch({ 'api.groq.com': () => ({ choices: [{ message: { content: reply } }], usage: {} }) });
  const api = await client(env, { fetch: f });
  const columns = [{ key: 'first_name', name: 'First name', type: 'text' }, { key: 'about', name: 'About', type: 'text' }];
  const ok = await api.post('/api/assist/prompt', { prompt: 'write a one-line opener', columns });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.prompt, /#OBJECTIVE#/);
  assert.deepEqual(ok.body.columns, ['first_name', 'about']);
  const sent = JSON.parse(f.calls[0].body);
  assert.match(sent.messages[0].content, /\{\{first_name\}\} = First name/);
  assert.ok(sent.max_tokens <= 900);                   // Groq free tier: 1,000 output tokens a minute
  reply = 'Write to {{ceo_name}} at {{about}}';
  const bad = await api.post('/api/assist/prompt', { prompt: 'write an opener', columns });
  assert.equal(bad.status, 422); assert.match(bad.body.error, /ceo_name/);
  reply = 'Write a nice opener.';
  assert.equal((await api.post('/api/assist/prompt', { prompt: 'write an opener', columns })).status, 422);
});

test('try shows the spintax choice the saved column will write', async () => {
  const env = fakeEnv();
  const api = await client(env);
  const { t, key } = await table(api, `Name\n${Array.from({ length: 5 }, (_, i) => `N${i}`).join('\n')}\n`);
  const config = { body: `{A|B|C|D|E|F} {{${key('Name')}}}` };
  const tried = (await api.post(`/api/tables/${t.id}/try`, { kind: 'message', name: 'Email', config })).body.results.map((r) => r.value);
  const c = (await api.post(`/api/tables/${t.id}/columns`, { name: 'Email', kind: 'message', config })).body;
  await api.post(`/api/tables/${t.id}/run`, { column_id: c.id });
  await api.post('/api/run-batch');
  assert.deepEqual((await api.get(`/api/tables/${t.id}`)).body.rows.map((r) => r.data[c.key]), tried);
});
