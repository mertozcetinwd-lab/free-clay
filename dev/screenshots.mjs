/**
 * Screenshots of every page, light and dark, with a real browser (Chrome or Edge in headless
 * mode, driven over the DevTools protocol with Node's built-in WebSocket: no packages to install).
 * Used for docs/screenshots and as a quick visual check after a change.
 *
 *   node dev/preview.mjs --memory --fake-opendata     then   node dev/demo.mjs
 *   node dev/screenshots.mjs [http://localhost:8787] [password] [--only name,name] [--out docs/screenshots]
 *
 * Needs Node 22+ and Chrome or Edge installed. Set CHROME=/path/to/chrome if it is somewhere else.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const BASE = (positional[0] || 'http://localhost:8787').replace(/\/+$/, '');
const PASSWORD = positional[1] || 'preview';
const OUT = opt('--out') || fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const ONLY = opt('--only') ? opt('--only').split(',') : null;
const PORT = 9333 + Math.floor(Math.random() * 500);

const CANDIDATES = [process.env.CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) { console.error('No Chrome or Edge found. Set CHROME=/path/to/chrome'); process.exit(1); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'fc-shots-'));
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--disable-gpu', '--window-size=1440,900', 'about:blank'], { stdio: 'ignore' });

let ws; let seq = 0; const pending = new Map(); const waiters = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
    } catch { /* not up yet */ }
    await wait(200);
  }
  if (!ws) throw new Error('Could not reach the headless browser');
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method) for (const w of [...waiters]) if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.res(msg.params); }
  };
}
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const once = (method, ms = 15000) => Promise.race([new Promise((res) => waiters.push({ method, res })), wait(ms)]);
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

async function go(path, settle = 1500) {
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: BASE + path });
  await loaded; await wait(settle);
}

async function shot(name, { width = 1440, height = 900, mobile = false } = {}) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await wait(400);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`  ${name}.png`);
}

// Small helpers that run inside the page.
const CLICK = (text, sel = 'button') => `{ const el = [...document.querySelectorAll('${sel}')].find((b) => b.textContent.trim().includes(${JSON.stringify(text)})); if (!el) throw new Error('no ${sel} with ' + ${JSON.stringify(text)}); el.click(); }`;
const TYPE = (id, value) => `{ const i = document.getElementById(${JSON.stringify(id)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }`;
const SLEEP = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;

/** name, path, what to do before the picture, and which themes. */
const PAGES = [
  ['home', '/', ''],
  ['find-local', '/find', `${TYPE('find-place', 'Gainesville, FL')} ${SLEEP(200)} document.querySelector('#find-place').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); ${SLEEP(2500)} ${CLICK('Search')} ${SLEEP(6000)}`],
  ['find-people', '/find', `${CLICK('People')} ${SLEEP(500)} ${TYPE('pp-title', 'owner')} ${TYPE('pp-location', 'Florida')} ${CLICK('Find people')} ${SLEEP(3000)}`],
  ['table', '/t/2', `${SLEEP(1500)}`],
  ['tools', '/t/2', `${SLEEP(1200)} ${CLICK('Tools')} ${SLEEP(1200)}`],
  ['people', '/people', ''],
  ['companies', '/companies', ''],
  ['agents', '/agents', ''],
  ['agent-builder', '/agents/1', `${SLEEP(800)} const r = document.querySelector('.ag-runs .ag-run'); if (r) r.click(); ${SLEEP(600)} document.querySelector('.ag-result details')?.setAttribute('open', '');`],
  ['workflow', '/workflows/1', `${SLEEP(2500)}`],
  ['workflow-runs', '/workflows/1', `${SLEEP(1500)} ${CLICK('Runs')} ${SLEEP(1500)} document.querySelector('.wf-runs tbody tr')?.click(); ${SLEEP(800)}`],
  ['signals', '/signals', ''],
  ['mcp', '/mcp', ''],
  ['api', '/api', ''],
  ['keys', '/settings/keys', ''],
  ['exports', '/exports', ''],
  ['message-column', '/t/1', `${SLEEP(1500)} const { state } = await import('/js/store.js'); const { openColumnPanel } = await import('/js/ui/column-panel.js'); openColumnPanel(null, { preset: { kind: 'message', name: 'First email', config: { subject: '{Quick question|A question} for {{clean:company}}', body: '{Hi|Hello} {{clean:first_name}},\\n\\n{{snippet:opener}}\\n\\n{{snippet:ask}}', snippets: [{ name: 'opener', kind: 'ai', provider: 'groq', model: 'qwen/qwen3.8-27b', max_tokens: 200, prompt: 'One friendly sentence about what {{company}} does, from {{website}}.' }, { name: 'ask', kind: 'if', condition: 'CONTAINS({{company}}, \"Roof\")', then: 'Do storm weeks swamp your phones?', else: 'Worth a quick call?' }] } } }); ${SLEEP(1200)}`],
  ['message-try', '/t/1', `${SLEEP(1500)} const { state } = await import('/js/store.js'); const { openColumnPanel } = await import('/js/ui/column-panel.js'); openColumnPanel(null, { preset: { kind: 'message', name: 'First email', config: { subject: '{Quick question|A question} for {{clean:company}}', body: '{Hi|Hello} {{clean:first_name}},\\n\\n{{snippet:opener}}\\n\\n{{snippet:ask}}', snippets: [{ name: 'opener', kind: 'ai', provider: 'groq', model: 'qwen/qwen3.8-27b', max_tokens: 200, prompt: 'One friendly sentence about what {{company}} does, from {{website}}.' }, { name: 'ask', kind: 'if', condition: 'CONTAINS({{company}}, \"Roof\")', then: 'Do storm weeks swamp your phones?', else: 'Worth a quick call?' }] } } }); ${SLEEP(1000)} ${CLICK('Try on 5 rows')} ${SLEEP(4000)}`],
  ['ai-prompt-writer', '/t/1', `${SLEEP(1500)} const { openColumnPanel } = await import('/js/ui/column-panel.js'); openColumnPanel(null, { preset: { kind: 'ai', name: 'Opener' } }); ${SLEEP(800)} { const i = document.querySelector('[aria-label="Describe the prompt"]'); i.value = 'write a two-sentence opener to the owner'; } ${CLICK('Write the prompt')} ${SLEEP(2500)}`],
];
const DARK = ['home', 'find-local', 'table', 'agent-builder', 'workflow', 'people', 'signals', 'mcp'];
const PHONE = ['home', 'table', 'people'];

try {
  mkdirSync(OUT, { recursive: true });
  await connect();
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  const login = await fetch(`${BASE}/api/login`, { method: 'POST', body: JSON.stringify({ password: PASSWORD }) });
  const session = (login.headers.get('set-cookie') || '').match(/fc_session=([^;]+)/)?.[1];
  if (!session) throw new Error(`Login failed (${login.status}). Is the preview running with password ${PASSWORD}?`);
  await send('Network.setCookie', { name: 'fc_session', value: decodeURIComponent(session), url: BASE });
  for (const theme of ['light', 'dark']) {
    await go('/', 300);
    await js(`localStorage.setItem('fc.theme', '${theme}'); localStorage.setItem('fc.side', '');`);
    for (const [name, path, act] of PAGES) {
      if (ONLY && !ONLY.includes(name)) continue;
      if (theme === 'dark' && !DARK.includes(name)) continue;
      // Size first: a resize after the scene closes any open popover (Try on 5 rows, menus).
      await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await go(path);
      if (act) { try { await js(act); } catch (e) { console.log(`  (${name}: ${e.message})`); } }
      await shot(theme === 'dark' ? `${name}-dark` : name);
    }
  }
  for (const [name, path, act] of PAGES.filter(([n]) => PHONE.includes(n) && (!ONLY || ONLY.includes(n)))) {
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await js(`localStorage.setItem('fc.theme', 'light');`);
    await go(path);
    if (act) { try { await js(act); } catch { /* best effort */ } }
    await shot(`${name}-phone`, { width: 390, height: 844, mobile: true });
  }
} finally {
  try { ws?.close(); } catch { /* closed */ }
  proc.kill();
  await wait(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may hold it for a moment */ }
}
