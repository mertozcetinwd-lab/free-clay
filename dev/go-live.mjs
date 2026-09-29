/**
 * Go live in one command: deploy, prove the free functions on the real internet, prove each paid
 * function with one tiny call, and prove the deployed Worker runs a column end to end.
 *
 *   node dev/go-live.mjs                 everything below, in order
 *   node dev/go-live.mjs --dry           print the plan, touch nothing
 *   node dev/go-live.mjs --only free     just the free-function smoke (no key, no cost)
 *   node dev/go-live.mjs --only worker --target http://127.0.0.1:8787   smoke a running Worker
 *
 * KEYS are read from the environment, then from a .env in this folder (you write that file yourself; copy .env.example).
 * Nothing is printed except key NAMES. Needs either `npx wrangler login` done once, or
 * CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) set, for the deploy steps.
 *
 * COST, all on your own accounts, hard-capped by PAID_CAP_MICROS below:
 *   Hunter finder 1 call (free plan credit), Prospeo 1 call (free plan credit), Exa search 1 call
 *   (~$0.007, measured 2026-08-06), Places lookup 1 request (inside Google's 1,000 free a
 *   month; $0.035 if over), and one tiny AI prompt on Groq's free tier ($0). A missing key
 *   skips that call. Cloudflare: free plan, $0.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = fileURLToPath(new URL('..', import.meta.url));
// Keys for the smoke calls: a .env in this folder first, then the author's own monorepo .env two levels up (harmless if absent).
const REPO_ENV = [fileURLToPath(new URL('../.env', import.meta.url)), fileURLToPath(new URL('../../../.env', import.meta.url))].find((p) => existsSync(p)) || '';
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = flag('--dry');
const ONLY = opt('--only');
const PAID_CAP_MICROS = 100_000;          // $0.10 across every paid smoke call together
const KEYS = ['HUNTER_API_KEY', 'PROSPEO_API_KEY', 'EXA_API_KEY', 'GOOGLE_MAPS_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'TREG_TOKEN'];

/* ---------------------------------------------------------------- env */

const env = { ...process.env };
if (existsSync(REPO_ENV)) {
  for (const line of readFileSync(REPO_ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const have = (k) => typeof env[k] === 'string' && env[k].length > 0;
const say = (...a) => console.log(...a);
const step = (t) => say(`\n== ${t}`);

/* ---------------------------------------------------------------- wrangler */

function wrangler(cmdArgs, { input, capture = true } = {}) {
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  if (DRY) { say(`   (dry) npx wrangler ${cmdArgs.join(' ')}`); return { ok: true, out: '' }; }
  // Wrangler gets the real environment, never the .env file: .env holds narrow Cloudflare tokens
  // (DNS-only and the like) that would override `wrangler login` and fail with code 10000.
  const r = spawnSync(bin, ['wrangler', ...cmdArgs], { cwd: HERE, input, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, shell: process.platform === 'win32', stdio: capture ? 'pipe' : 'inherit' });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

async function deploy() {
  step('1. Deploy to Cloudflare (free plan)');
  const who = wrangler(['whoami']);
  if (!DRY && !/You are logged in|associated with the email|Account ID/i.test(who.out) && !process.env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Not logged in to Cloudflare. Run once: npx wrangler login   (or set CLOUDFLARE_API_TOKEN)');
  }
  // Find or create the database, then write its id into wrangler.toml (an id, not a secret).
  const list = wrangler(['d1', 'list', '--json']);
  let id = null;
  try { id = JSON.parse(list.out.slice(list.out.indexOf('['))).find((d) => d.name === 'free-clay')?.uuid; } catch { /* not JSON */ }
  if (!id && !DRY) {
    const made = wrangler(['d1', 'create', 'free-clay']);
    id = made.out.match(/database_id\s*=\s*"([0-9a-f-]{36})"/)?.[1] || made.out.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1];
    if (!id) throw new Error('Could not create the database:\n' + made.out.slice(-600));
  }
  const tomlPath = HERE + 'wrangler.toml';
  const toml = readFileSync(tomlPath, 'utf8');
  if (id && !toml.includes(id)) {
    if (!DRY) writeFileSync(tomlPath, toml.replace(/database_id = "[^"]*"/, `database_id = "${id}"`));
    say(`   database free-clay: ${id}`);
  }
  const schema = wrangler(['d1', 'execute', 'free-clay', '--remote', '--file', 'schema.sql', '-y']);
  if (!schema.ok) throw new Error('Schema failed:\n' + schema.out.slice(-600));
  say('   schema applied');
  // Every change after v1 is a numbered file in migrations/; wrangler records which ran, so this
  // applies only the new ones. Code that reads a new table must never go live before its migration.
  const mig = wrangler(['d1', 'migrations', 'apply', 'free-clay', '--remote'], { input: 'y\n' });
  if (!mig.ok) throw new Error('Migrations failed:\n' + mig.out.slice(-600));
  say('   migrations applied');

  // The app password: kept if already set on the Worker; otherwise made here and shown ONCE.
  const secrets = wrangler(['secret', 'list']);
  let password = null;
  if (DRY || !/APP_PASSWORD/.test(secrets.out)) {
    password = env.FREE_CLAY_PASSWORD || randomBytes(12).toString('base64url');
    wrangler(['secret', 'put', 'APP_PASSWORD'], { input: password + '\n' });
  }
  // Provider keys become Worker secrets, so the deployed app can use them too.
  for (const k of KEYS) if (have(k)) { wrangler(['secret', 'put', k], { input: env[k] + '\n' }); say(`   secret set: ${k}`); }

  const dep = wrangler(['deploy']);
  if (!dep.ok) throw new Error('Deploy failed:\n' + dep.out.slice(-800));
  const url = dep.out.match(/https:\/\/free-clay\.[a-z0-9-]+\.workers\.dev/)?.[0] || (DRY ? 'https://free-clay.example.workers.dev' : null);
  say(`   live at ${url}`);
  if (password && !DRY) say(`   APP_PASSWORD (shown once, put it in your password manager): ${password}`);
  return { url, password: password || env.FREE_CLAY_PASSWORD || null };
}

/* ---------------------------------------------------------------- free functions, real internet */

async function freeSmoke() {
  step('2. Free functions against the real internet ($0)');
  const { FREE } = await import('../src/functions/free.js');
  const fn = Object.fromEntries(FREE.map((f) => [f.id, f]));
  // Public, well-known sites only. Nobody is contacted; these are DNS lookups and page reads.
  const cases = [
    ['domain_alive', { domain: 'cloudflare.com' }, (d) => d.alive === true],
    ['domain_alive', { domain: 'no-such-domain-free-clay-9f8e7d6c.com' }, (d) => d.alive === false],
    ['email_provider', { domain: 'google.com' }, (d) => d.provider === 'Google Workspace'],
    ['email_provider', { domain: 'microsoft.com' }, (d) => d.provider === 'Microsoft 365'],
    ['website_check', { domain: 'example.com' }, (d) => ['live', 'parked'].includes(d.status) && d.http_status === 200],
    ['scrape_website', { url: 'https://www.iana.org/help/example-domains' }, (d) => /example/i.test(d.text || '')],
    ['find_contact_info', { domain: 'iana.org' }, () => true],
    ['email_check', { email: 'someone@gmail.com' }, (d) => d.valid === true && d.free_mail === true],
    ['email_check', { email: 'x@no-such-domain-free-clay-9f8e7d6c.com' }, (d) => d.valid === false],
  ];
  let bad = 0;
  for (const [id, input, ok] of cases) {
    if (DRY) { say(`   (dry) ${id} ${JSON.stringify(input)}`); continue; }
    try {
      const r = await fn[id].run(input, { fetch: globalThis.fetch, secret: () => { throw new Error('no key'); } });
      const pass = ok(r.data || {});
      if (!pass) bad++;
      say(`   ${pass ? 'ok  ' : 'FAIL'} ${id} ${JSON.stringify(input)} -> ${JSON.stringify(r.data).slice(0, 140)}`);
    } catch (e) { bad++; say(`   FAIL ${id} ${JSON.stringify(input)} -> ${e.message}`); }
  }
  return bad;
}

/* ---------------------------------------------------------------- paid functions, one call each */

async function paidSmoke() {
  step(`3. Paid functions, one call each (cap $${(PAID_CAP_MICROS / 1e6).toFixed(2)} total)`);
  const { BYOK } = await import('../src/functions/byok.js');
  const { EXECUTORS } = await import('../src/runner.js');
  await import('../src/kinds/ai.js');
  const fn = Object.fromEntries(BYOK.map((f) => [f.id, f]));
  const secret = (k) => { if (!have(k)) throw new Error(`${k} missing`); return env[k]; };
  // Subjects are Hunter's own documentation example and famous public places, never a lead.
  const cases = [
    ['hunter_email_finder', { first_name: 'Dustin', last_name: 'Moskovitz', domain: 'asana.com' }, 0],
    ['prospeo_enrich_person', { full_name: 'Dustin Moskovitz', domain: 'asana.com' }, 0],
    ['exa_search', { query: 'roofing contractor Gainesville Florida' }, 7_000],
    ['places_lookup', { query: 'Googleplex Mountain View CA' }, 35_000],
  ];
  let spent = 0; let bad = 0;
  for (const [id, input, est] of cases) {
    const f = fn[id];
    if (!have(f.secret)) { say(`   skip ${id}: ${f.secret} not in .env`); continue; }
    if (spent + est > PAID_CAP_MICROS) { say(`   skip ${id}: would pass the cap`); continue; }
    if (DRY) { say(`   (dry) ${id} ${JSON.stringify(input)} ~$${(est / 1e6).toFixed(4)}`); continue; }
    try {
      const r = await f.run(input, { fetch: globalThis.fetch, secret });
      const cost = r.cost_micros ?? est; spent += cost;
      say(`   ok   ${id} -> ${r.status} ${JSON.stringify(r.data).slice(0, 120)}  ($${(cost / 1e6).toFixed(4)})`);
    } catch (e) { bad++; spent += 0; say(`   FAIL ${id} -> ${e.message.slice(0, 200)}`); }
  }
  // The AI check runs on Groq (free tier, $0; scripts/llm.py). Anthropic is left out while its
  // account has no credit balance (2026-09-28 run: "Your credit balance is too low").
  if (have('GROQ_API_KEY')) {
    const col = { config: { provider: 'groq', model: 'qwen/qwen3.8-27b', prompt: 'Reply with the single word: {{w}}', max_tokens: 400 } };
    if (DRY) say('   (dry) AI column on Groq qwen/qwen3.8-27b, one tiny prompt ($0)');
    else {
      const out = await EXECUTORS.ai.run(col, { w: 'ready' }, { fetch: globalThis.fetch, secret, cols: [] });
      if (out.status !== 'done') bad++;
      say(`   ${out.status === 'done' ? 'ok  ' : 'FAIL'} ai groq qwen/qwen3.8-27b -> ${out.status} ${JSON.stringify(out.value || out.error).slice(0, 200)}  ($0, ${out.calls?.[0]?.note || ''})`);
    }
  } else say('   skip ai: GROQ_API_KEY not in .env');
  say(`   paid smoke total: ~$${(spent / 1e6).toFixed(4)}`);
  return bad;
}

/* ---------------------------------------------------------------- the deployed Worker, end to end */

async function workerSmoke(base, password) {
  step(`4. The Worker end to end: ${base}`);
  if (DRY) { say('   (dry) login, make a table, import 2 rows, add a free column, run it, read it back, delete the table'); return 0; }
  if (!password) { say('   skip: APP_PASSWORD unknown here (set FREE_CLAY_PASSWORD to smoke an existing deploy)'); return 0; }
  let cookie = '';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text(); let j; try { j = JSON.parse(text); } catch { j = text; }
    if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text.slice(0, 200)}`);
    return j;
  };
  await call('POST', '/api/login', { password });
  const t = await call('POST', '/api/tables', { name: 'go-live smoke (safe to delete)' });
  try {
    await call('POST', `/api/tables/${t.id}/import`, 'Company,Website\nCloudflare,cloudflare.com\nIANA,iana.org\n');
    const c = await call('POST', `/api/tables/${t.id}/columns`, { name: 'Email provider', kind: 'enrich', config: { fn: 'email_provider', inputs: { domain: '{{website}}' } } });
    await call('POST', `/api/tables/${t.id}/run`, { column_id: c.id, budget_micros: 0 });
    for (let i = 0; i < 10; i++) { const rep = await call('POST', '/api/run-batch'); if (!rep.remaining) break; await new Promise((r) => setTimeout(r, 500)); }
    const full = await call('GET', `/api/tables/${t.id}`);
    const vals = full.rows.map((r) => r.data.email_provider);
    const pass = vals.every(Boolean);
    say(`   ${pass ? 'ok  ' : 'FAIL'} email provider from the Worker: ${JSON.stringify(vals)}  ${JSON.stringify(full.meta.map((m) => m.status + (m.error ? ': ' + m.error : '')))}`);
    return pass ? 0 : 1;
  } finally { await call('DELETE', `/api/tables/${t.id}`).catch(() => {}); }
}

/* ---------------------------------------------------------------- main */

let failures = 0;
try {
  say(`keys found (names only): ${KEYS.filter(have).join(', ') || 'none'}`);
  let target = opt('--target'); let password = env.FREE_CLAY_PASSWORD || null;
  if (!ONLY || ONLY === 'deploy') { const d = await deploy(); target = target || d.url; password = password || d.password; }
  if (!ONLY || ONLY === 'free') failures += await freeSmoke();
  if (!ONLY || ONLY === 'paid') failures += await paidSmoke();
  if ((!ONLY || ONLY === 'worker') && target) failures += await workerSmoke(target, password);
} catch (e) { failures++; console.error('\nSTOPPED: ' + e.message); }
say(failures ? `\n${failures} problem(s). Read the lines marked FAIL above.` : '\nAll green.');
process.exit(failures ? 1 : 0);
