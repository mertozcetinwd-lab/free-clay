#!/usr/bin/env node
/**
 * free-clay: Free Clay from a terminal (LOAM-PLAN.md phase 10). One file, Node 18+ (built-in fetch), no
 * packages. It calls the same REST API as the app with an API token (made on the API page).
 *
 *   FREE_CLAY_URL=https://your-worker.workers.dev  FREE_CLAY_TOKEN=loam_...  node bin/free-clay.mjs <command>
 *
 * Commands print JSON or CSV to stdout, so they pipe into jq, a file or another tool.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const HELP = `free-clay <command>

  tables                              list tables
  rows <table> [--limit N]            rows of a table as JSON (values by column name)
  import <file.csv> [--name "Name"]   new table from a CSV (or --table <id> to add to one)
  run <table> <column> [--all] [--budget 0.50]
                                      run a column (by id or name) on empty rows, or all rows
  export <table>                      the table as CSV
  people [text]                       search People        companies [text]   search Companies
  agents                              list agents
  agent <id> key=value ...            run an agent once, e.g. agent 1 domain=example.com
  workflows                           list workflows
  workflow <id> key=value ...         run a workflow on one item
  events                              recent signal events
  spend                               what paid providers cost this month

  Needs FREE_CLAY_URL and FREE_CLAY_TOKEN in the environment.`;

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--all'));

function die(msg) { process.stderr.write(`free-clay: ${msg}\n`); process.exit(1); }

async function call(method, path, body, raw = false) {
  const base = (process.env.FREE_CLAY_URL || '').replace(/\/+$/, '');
  const token = process.env.FREE_CLAY_TOKEN || '';
  if (!base || !token) die('set FREE_CLAY_URL and FREE_CLAY_TOKEN (make a token on the API and CLI page)');
  const headers = { authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); if (typeof body !== 'string') headers['content-type'] = 'application/json'; }
  const res = await fetch(`${base}/api/v1${path}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) { let m = text; try { m = JSON.parse(text).error || text; } catch { /* not JSON */ } die(`${res.status}: ${m}`); }
  return raw ? text : JSON.parse(text);
}

const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n');
const pairs = (list) => Object.fromEntries(list.map((p) => { const i = p.indexOf('='); return i > 0 ? [p.slice(0, i), p.slice(i + 1)] : [p, '']; }));

async function columnId(table, col) {
  const t = await call('GET', `/tables/${table}`);
  const c = t.columns.find((x) => String(x.id) === String(col) || x.name.toLowerCase() === String(col).toLowerCase() || x.key === col);
  if (!c) die(`no column "${col}" in table ${table}. Columns: ${t.columns.map((x) => x.name).join(', ')}`);
  return c.id;
}

const commands = {
  async tables() { out((await call('GET', '/bootstrap')).tables.map(({ id, name, row_count, column_count }) => ({ id, name, rows: row_count, columns: column_count }))); },
  async rows() {
    const [id] = positional;
    if (!id) die('rows <table id>');
    const t = await call('GET', `/tables/${id}`);
    const limit = Number(flag('limit')) || t.rows.length;
    out(t.rows.slice(0, limit).map((r) => ({ id: r.id, ...Object.fromEntries(t.columns.map((c) => [c.name, r.data[c.key] ?? null])) })));
  },
  async import() {
    const [file] = positional;
    if (!file) die('import <file.csv> [--name "Name"] [--table <id>]');
    const csv = await readFile(file, 'utf8');
    const into = flag('table');
    if (into) out(await call('POST', `/tables/${into}/import`, csv));
    else out(await call('POST', '/tables', { name: String(flag('name') || basename(file, '.csv')).slice(0, 80), csv }));
  },
  async run() {
    const [table, col] = positional;
    if (!table || !col) die('run <table id> <column id or name> [--all] [--budget 0.50]');
    const body = { column_id: await columnId(table, col), scope: flag('all') ? 'all' : 'empty' };
    if (flag('budget')) body.budget_micros = Math.round(Number(flag('budget')) * 1e6);
    const q = await call('POST', `/tables/${table}/run`, body);
    process.stderr.write(`queued ${q.queued} cells, up to $${(q.est_micros / 1e6).toFixed(4)}. Draining…\n`);
    for (let i = 0; i < 200; i++) {
      const r = await call('POST', '/run-batch', {});
      if (!r.remaining) break;
    }
    out({ queued: q.queued, done: true });
  },
  async export() { const [id] = positional; if (!id) die('export <table id>'); out(await call('GET', `/tables/${id}/export.csv`, undefined, true)); },
  async people() { out(await call('GET', `/audiences/people?q=${encodeURIComponent(positional.join(' '))}&limit=100`)); },
  async companies() { out(await call('GET', `/audiences/companies?q=${encodeURIComponent(positional.join(' '))}&limit=100`)); },
  async agents() { out((await call('GET', '/agents')).map(({ id, name, inputs, model, provider }) => ({ id, name, inputs, model: `${provider}/${model}` }))); },
  async agent() {
    const [id, ...kv] = positional;
    if (!id) die('agent <id> key=value ...');
    const r = await call('POST', `/agents/${id}/run`, { input: pairs(kv) });
    out({ status: r.status, output: r.output, cost_usd: r.cost_micros / 1e6, error: r.error || undefined });
  },
  async workflows() { out((await call('GET', '/workflows')).map(({ id, name, status, runs }) => ({ id, name, status, runs }))); },
  async workflow() {
    const [id, ...kv] = positional;
    if (!id) die('workflow <id> key=value ...');
    const q = await call('POST', `/workflows/${id}/run`, { item: pairs(kv) });
    for (let i = 0; i < 50; i++) { const r = await call('POST', '/workflows/drain', {}); if (!r.remaining) break; }
    out({ ...q, last_run: (await call('GET', `/workflows/${id}/runs`))[0] });
  },
  async events() { out(await call('GET', '/signals/events?limit=50')); },
  async spend() { out(await call('GET', '/spend')); },
};

if (!cmd || cmd === 'help' || cmd === '--help' || !commands[cmd]) { process.stdout.write(HELP + '\n'); process.exit(cmd && !['help', '--help'].includes(cmd) ? 1 : 0); }
await commands[cmd]();
