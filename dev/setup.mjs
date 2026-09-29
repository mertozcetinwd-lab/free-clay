/**
 * Set up Free Clay on your own Cloudflare account, in one command:
 *
 *   npm run setup                         asks as it goes
 *   npm run setup -- --states FL,GA       open data for these states only
 *   npm run setup -- --all-states         all 50 states + DC (about 1.2 GB download, 3.1 GB of tiles)
 *   npm run setup -- --no-data            skip the open-data download (Find leads, Local businesses stays empty)
 *   npm run setup -- --keys-from-env      read provider keys from a .env file in this folder
 *   npm run setup -- --yes                no questions: defaults everywhere, keys skipped unless --keys-from-env
 *   npm run setup -- --dry                print what would happen, change nothing
 *
 * What only a PERSON can do (the script stops and hands you the terminal):
 *   1. `npx wrangler login` opens a browser so you can sign in to Cloudflare (free account).
 *   2. For each key you add, wrangler asks for the value and sends it straight to Cloudflare.
 *      It is never printed, logged, or seen by this script or by an AI agent helping you.
 *
 * Safe to run again: every step checks what is already there (database, tables, secrets, data).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { KEYS } from '../public/js/keys.js';

const HERE = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DRY = flag('--dry'); const YES = flag('--yes') || !process.stdin.isTTY;
const DB = 'free-clay';
const say = (...a) => console.log(...a);
const step = (n, t) => say(`\n\x1b[1m${n}. ${t}\x1b[0m`);
const you = (t) => say(`\x1b[33m   YOU: ${t}\x1b[0m`);
const rl = YES ? null : createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = '') => (YES ? def : ((await rl.question(`   ${q} `)).trim() || def));
const yes = async (q, def = false) => { const a = (await ask(`${q} [${def ? 'Y/n' : 'y/N'}]`, def ? 'y' : 'n')).toLowerCase(); return a.startsWith('y'); };

function run(cmd, cmdArgs, { input, inherit = false, allowFail = false } = {}) {
  if (DRY) { say(`   (dry) ${cmd} ${cmdArgs.join(' ')}`); return { ok: true, out: '' }; }
  const bin = process.platform === 'win32' && cmd === 'npx' ? 'npx.cmd' : cmd;
  const r = spawnSync(bin, cmdArgs, { cwd: HERE, input, encoding: 'utf8', shell: process.platform === 'win32', stdio: inherit ? 'inherit' : 'pipe',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  const out = (r.stdout || '') + (r.stderr || '');
  if (r.status !== 0 && !allowFail) { say(out.slice(-1200)); throw new Error(`${cmd} ${cmdArgs.slice(0, 3).join(' ')} failed`); }
  return { ok: r.status === 0, out };
}
const wrangler = (a, o) => run('npx', ['wrangler', ...a], o);

function readEnvFile() {
  const file = HERE + '.env';
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function main() {
  say('\x1b[1mFree Clay setup\x1b[0m: a Clay-style lead workspace on your own Cloudflare account (free plan).');
  say('Nothing here costs money. Keys are optional; each provider bills you directly, only when you run it.');

  step(1, 'Check this computer');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 20) throw new Error(`Node ${process.versions.node} is too old. Install Node 22 or newer from https://nodejs.org, then run this again.`);
  say(`   Node ${process.versions.node}${maj < 22 || (maj === 22 && min < 5) ? ' (fine for deploying; tests and the local preview need 22.5+)' : ''}`);
  if (!existsSync(HERE + 'node_modules/wrangler')) { say('   Installing wrangler (Cloudflare’s command line)…'); run('npm', ['install'], { inherit: true }); }

  step(2, 'Cloudflare account');
  let who = wrangler(['whoami'], { allowFail: true });
  if (!DRY && !/You are logged in|associated with the email/i.test(who.out)) {
    you('sign in to Cloudflare. A browser window opens; approve it, then come back here. (A free account is enough: https://dash.cloudflare.com/sign-up)');
    if (YES) throw new Error('Not logged in to Cloudflare. Run: npx wrangler login   then run setup again.');
    wrangler(['login'], { inherit: true });
    who = wrangler(['whoami']);
  }
  say(`   ${(who.out.match(/associated with the email ([^\s.]+@[^\s]+?)\.?\s/) || [])[1] ? 'Logged in.' : 'Logged in (or dry run).'}`);

  step(3, 'Database (Cloudflare D1, free plan: up to 500 MB a database)');
  let id = null;
  const list = wrangler(['d1', 'list', '--json'], { allowFail: true });
  try { id = JSON.parse(list.out.slice(list.out.indexOf('['))).find((d) => d.name === DB)?.uuid || null; } catch { /* not JSON */ }
  if (!id && !DRY) {
    const made = wrangler(['d1', 'create', DB]);
    id = made.out.match(/"?database_id"?\s*[=:]\s*"([0-9a-f-]{36})"/)?.[1] || null;
    if (!id) throw new Error('Could not read the new database id from wrangler. Run: npx wrangler d1 list');
    say(`   created ${DB}`);
  } else say(`   ${DB} ${id ? 'already exists' : '(dry)'}`);
  const tomlPath = HERE + 'wrangler.toml';
  const toml = readFileSync(tomlPath, 'utf8');
  if (id && !toml.includes(id)) { if (!DRY) writeFileSync(tomlPath, toml.replace(/database_id = "[^"]*"/, `database_id = "${id}"`)); say('   wrote its id into wrangler.toml'); }
  wrangler(['d1', 'execute', DB, '--remote', '--file', 'schema.sql', '-y']);
  wrangler(['d1', 'migrations', 'apply', DB, '--remote'], { input: 'y\n' });
  say('   tables ready');

  step(4, 'App password (the only login to your Free Clay)');
  const secrets = wrangler(['secret', 'list'], { allowFail: true }).out;
  let password = null;
  if (DRY || !/"APP_PASSWORD"/.test(secrets)) {
    password = randomBytes(12).toString('base64url');
    wrangler(['secret', 'put', 'APP_PASSWORD'], { input: password + '\n' });
    say('   set (shown at the end, once)');
  } else say('   already set');

  step(5, 'Provider keys (all optional)');
  const envFile = flag('--keys-from-env') ? readEnvFile() : {};
  const set = new Set(KEYS.map((k) => k.name).filter((n) => new RegExp(`"${n}"`).test(secrets)));
  for (const k of KEYS) {
    if (set.has(k.name)) { say(`   ✓ ${k.name} (${k.label}) is set`); continue; }
    if (envFile[k.name]) { wrangler(['secret', 'put', k.name], { input: envFile[k.name] + '\n' }); set.add(k.name); say(`   ✓ ${k.name} set from .env`); continue; }
    say(`   ${k.label}${k.recommended ? ' (recommended)' : ''}: ${k.unlocks}\n      Cost: ${k.cost}\n      Get it: ${k.url}`);
    if (!YES && await yes(`Add ${k.name} now?`, false)) {
      you(`paste the key when wrangler asks (it is hidden and goes straight to Cloudflare).`);
      if (wrangler(['secret', 'put', k.name], { inherit: true, allowFail: true }).ok) set.add(k.name);
    } else say(`      Later: npx wrangler secret put ${k.name}`);
  }
  if (set.size && !DRY) {
    const values = [...set].map((n) => `('${n}', 'added by setup', '${new Date().toISOString()}')`).join(', ');
    wrangler(['d1', 'execute', DB, '--remote', '--command', `INSERT OR IGNORE INTO secrets_index (name, note, created_at) VALUES ${values}`], { allowFail: true });
    say(`   listed in Settings, Keys: ${[...set].join(', ')}`);
  }

  step(6, 'Free business data for Find leads (Overture Maps, 15.5 million US places)');
  let states = opt('--states') || (flag('--all-states') ? 'ALL' : null);
  if (flag('--no-data')) states = 'NONE';
  if (!states) states = (await ask('Which states? Two-letter codes like FL,GA, or ALL, or NONE [FL]:', 'FL')).toUpperCase();
  if (states !== 'NONE') {
    say(`   Downloading from github.com/mertozcetinwd-lab/free-clay-data and building map tiles (${states === 'ALL' ? 'about 1.2 GB; takes a few minutes' : 'one state is 10 to 100 MB'})…`);
    run('node', ['dev/get-places.mjs', ...(states === 'ALL' ? [] : ['--states', states])], { inherit: true });
  } else say('   skipped. Later: node dev/get-places.mjs --states FL   then   npx wrangler deploy');

  step(7, 'Deploy');
  const dep = wrangler(['deploy']);
  const url = dep.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0] || (DRY ? 'https://free-clay.YOU.workers.dev' : null);
  say(`   live at ${url || '(see the wrangler output above)'}`);

  say('\n\x1b[1mDone.\x1b[0m');
  say(`   Open:      ${url}`);
  if (password && !DRY) say(`   Password:  ${password}   \x1b[33m(shown once: put it in your password manager)\x1b[0m`);
  say('   Next:');
  say('     - Settings > Data sources: add a contact email (OpenStreetMap place search and SEC ask for one), then Run check.');
  say('     - Settings > AI context: describe your business, so agents write and score for you.');
  say('     - MCP page: make a token and connect Claude, Cursor or ChatGPT.');
  say('   Docs: README.md, docs/SETUP.md, docs/KEYS.md, docs/TROUBLESHOOTING.md');
}

main().catch((e) => { say(`\n\x1b[31mStopped: ${e.message}\x1b[0m\nFix that, then run npm run setup again: finished steps are skipped.`); process.exitCode = 1; })
  .finally(() => rl?.close());
