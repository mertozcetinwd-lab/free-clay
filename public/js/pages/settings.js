/** Settings: appearance and run defaults, provider keys (names only), and spend. */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, changed, applyTheme, localStorageSet, setting } from '../store.js';
import { nav } from '../nav.js';
import { toast, confirmDialog } from '../ui/overlay.js';
import { fmtMicros } from '../types.js';
import { KEYS } from '../keys.js';

/** section key -> {label, icon, render(el)}. Later features add sections (spend is added by run control). */
export const SECTIONS = {
  general: { label: 'General', icon: 'sliders', render: renderGeneral },
  keys: { label: 'Keys', icon: 'key', render: renderKeys },
  data: { label: 'Data sources', icon: 'globe', render: renderData },
  ai: { label: 'AI context', icon: 'sparkle', render: renderAi },
};

export function renderSettings(regions, route) {
  const sec = SECTIONS[route.section] ? route.section : 'general';
  mount(regions.top, h('div', { class: 'title' }, 'Settings'), h('span', { class: 'grow' }),
    h('div', { class: 'seg-ctl' }, Object.entries(SECTIONS).map(([k, s]) => h('button', { class: k === sec && 'on', onClick: () => nav.go(k === 'general' ? '/settings' : `/settings/${k}`) }, s.label))));
  mount(regions.toolbar);
  const wrap = h('div', { class: 'set-wrap' });
  mount(regions.content, wrap);
  Promise.resolve(SECTIONS[sec].render(wrap)).catch((e) => wrap.append(h('p', { class: 'bad' }, e.message)));
}

async function save(patch) {
  try { state.boot.settings = await api.patch('/settings', patch); changed(); }
  catch (e) { toast(e.message, { error: true }); }
}

function renderGeneral(el) {
  const theme = setting('theme', 'system');
  const tile = (k, label) => h('button', { class: ['theme-tile', theme === k && 'on'], onClick: () => { localStorageSet('fc.theme', k); save({ theme: k }).then(applyTheme); } },
    h('div', { class: ['prev', k] }, h('i'), h('i')), h('span', null, label));
  const auto = setting('auto_run', false);
  const budget = h('input', { class: 'input', id: 'budget', type: 'number', min: '0', step: '0.01', style: { width: '120px' },
    value: (setting('default_budget_micros', 1_000_000) / 1e6).toFixed(2),
    onChange: (e) => { const n = Math.round(Number(e.target.value) * 1e6); if (Number.isInteger(n) && n >= 0) save({ default_budget_micros: n }); } });
  const who = h('input', { class: 'input', id: 'profile-name', value: setting('profile_name', ''), placeholder: 'Your first name', style: { width: '240px' },
    onChange: (e) => save({ profile_name: e.target.value.trim().slice(0, 60) }) });
  el.append(
    h('h1', null, 'General'),
    h('div', { class: 'set-sect' }, h('h2', null, 'Your name'), h('p', null, 'Used in the greeting on Home and in the profile menu.'), who),
    h('div', { class: 'set-sect' }, h('h2', null, 'Appearance'), h('p', null, 'Light, dark, or follow this device.'),
      h('div', { class: 'theme-tiles' }, tile('light', 'Light'), tile('dark', 'Dark'), tile('system', 'System'))),
    h('div', { class: 'set-sect' }, h('h2', null, 'Runs'),
      h('p', null, 'Nothing runs until you press Run. Clay turns auto-run on by default; here it starts off, so a CSV import never spends money on its own.'),
      h('div', { class: 'kv' },
        h('div', null, h('b', null, 'Auto-run columns that allow it'), h('div', { class: 'faint' }, 'When a row changes, re-run columns that have auto-run switched on.')),
        h('button', { class: 'switch', role: 'switch', 'aria-checked': auto ? 'true' : 'false', 'aria-label': 'Auto-run', onClick: () => save({ auto_run: !auto }) }),
        h('div', null, h('b', null, 'Default budget per run'), h('div', { class: 'faint' }, 'A run stops before it would spend more than this. You can change it on each run.')),
        h('div', { class: 'row' }, h('span', { class: 'muted' }, '$'), budget))));
}

function renderKeys(el) {
  const secrets = state.boot.secrets || [];
  const name = h('input', { class: 'input', placeholder: 'HUNTER_API_KEY', 'aria-label': 'Secret name', style: { width: '240px' } });
  const add = async () => {
    try { await api.post('/secrets', { name: name.value }); state.boot = await api.get('/bootstrap'); changed(); }
    catch (e) { toast(e.message, { error: true }); }
  };
  el.append(h('h1', null, 'Keys'),
    h('p', { class: 'lead' }, 'Keys never go in the database or the browser. Each one is a Cloudflare secret you set from your terminal. List the name here so columns can use it.'),
    h('div', { class: 'set-sect' },
      h('h2', null, 'Your keys'),
      secrets.length ? h('div', { class: 'klist' }, secrets.map((s) => h('div', { class: 'krow' },
        h('span', { class: ['dot'], 'data-c': s.set ? 'green' : 'amber' }), h('code', null, s.name),
        h('span', { class: 'faint grow' }, s.set ? 'Set on the Worker' : 'Not set yet. Run the command below, then reload.'),
        h('button', { class: 'btn ghost icon sm', 'aria-label': `Remove ${s.name}`, onClick: async () => {
          if (!(await confirmDialog({ title: `Forget ${s.name}?`, text: 'Columns that use it will stop working. The secret itself stays on Cloudflare until you delete it with wrangler.', confirmLabel: 'Forget', danger: true }))) return;
          await api.del(`/secrets/${s.name}`); state.boot = await api.get('/bootstrap'); changed();
        } }, icon('trash', 14))))) : h('p', { class: 'faint' }, 'No keys yet. The free functions need none.'),
      h('div', { class: 'row', style: { marginTop: '12px' } }, name, h('button', { class: 'btn', onClick: add }, icon('plus', 14), 'Add key name'))),
    h('div', { class: 'set-sect' }, h('h2', null, 'Keys Free Clay can use'),
      h('p', null, 'None is required. Start with Groq (free) and treg (one token for thousands of paid tools at the provider\u2019s price). For each key: get it from the link, then run the command in the free-clay folder on your computer and add the name above.'),
      h('div', { class: 'keys-guide' }, KEYS.map((k) => {
        const s = secrets.find((x) => x.name === k.name);
        return h('div', { class: 'key-card' },
          h('div', { class: 'row' }, h('span', { class: 'dot', 'data-c': s?.set ? 'green' : s ? 'amber' : 'gray' }), h('b', null, k.label), k.recommended ? h('span', { class: 'pill' }, 'start here') : null,
            h('span', { class: 'grow' }), h('a', { class: 'btn sm', href: k.url, target: '_blank', rel: 'noopener noreferrer' }, 'Get the key')),
          h('div', { class: 'faint' }, k.unlocks), h('div', { class: 'faint' }, k.cost), k.how ? h('div', { class: 'faint' }, k.how) : null,
          h('pre', { class: 'code' }, `npx wrangler secret put ${k.name}`),
          s?.set ? null : h('button', { class: 'btn ghost sm', onClick: async () => { try { await api.post('/secrets', { name: k.name }); state.boot = await api.get('/bootstrap'); changed(); } catch (e) { toast(e.message, { error: true }); } } },
            icon('plus', 13), s ? 'Listed: run the command, then reload' : `List ${k.name}`));
      })),
      h('p', { class: 'faint' }, 'Wrangler asks for the value and sends it straight to Cloudflare. It never appears in this app, your repo or your chat. An AI coding agent should hand you the terminal for this step, never ask you to paste a key.')));
}

/* ---------------------------------------------------------------- AI context */

/** Clay's "AI context" (teardown-v2, Settings): what agents know about your business. */
function renderAi(el) {
  const box = h('textarea', { class: 'textarea', id: 'ai-context', rows: 10, maxlength: 4000, style: { width: '100%', maxWidth: '720px' },
    placeholder: 'We are a small web and AI agency in Gainesville, Florida. We help home-service businesses (roofers, HVAC, plumbers) answer every call.\nOur ideal customer: 2 to 50 staff, Florida, has a website, gets calls from Google.\nWe never contact: franchises of national chains, businesses that sell alcohol.' },
    setting('ai_context', ''));
  el.append(h('h1', null, 'AI context'),
    h('p', { class: 'lead' }, 'What your agents know about your business: who you are, who you sell to, who to skip. Agents with “Use business context” switched on get it with every run. It is sent to the AI provider the agent uses.'),
    h('div', { class: 'set-sect' }, h('h2', null, 'About your business'), box,
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onClick: () => save({ ai_context: box.value.slice(0, 4000) }).then(() => toast('Saved.')) }, 'Save'),
        h('span', { class: 'faint' }, 'Up to 4,000 characters.'))));
}

/* ---------------------------------------------------------------- data sources */

let probe = null; let probing = false;

function renderData(el) {
  const email = h('input', { class: 'input', id: 'contact-email', type: 'email', value: setting('contact_email', ''), placeholder: 'you@yourbusiness.com', style: { width: '300px' },
    onChange: (e) => {
      const v = e.target.value.trim();
      if (v && !/^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i.test(v)) return toast('That does not look like an email address.', { error: true });
      save({ contact_email: v });
    } });
  const run = async () => {
    probing = true; changed();
    try { probe = await api.post('/admin/probe'); } catch (e) { toast(e.message, { error: true }); }
    probing = false; changed();
  };
  el.append(h('h1', null, 'Data sources'),
    h('p', { class: 'lead' }, 'Find leads uses free public data: OpenStreetMap for local businesses, SEC filings, Wikidata and GLEIF for companies, public job boards, GDELT for news. No keys, no bills.'),
    h('div', { class: 'set-sect' }, h('h2', null, 'Contact email'),
      h('p', null, 'OpenStreetMap’s place search and SEC EDGAR ask every app to say who it is, with an email, so they can reach you instead of blocking you. It goes only in the User-Agent of requests to those services. Leave it empty and those two stay off.'),
      email),
    h('div', { class: 'set-sect' }, h('h2', null, 'Check the sources'),
      h('p', null, 'Sends one small request to each service from your Worker and shows what came back. Nine requests, all free.'),
      h('button', { class: 'btn', disabled: probing, onClick: run }, icon(probing ? 'clock' : 'refresh', 14), probing ? 'Checking…' : 'Run check'),
      probe ? h('div', { class: 'probe' },
        h('div', { class: 'faint' }, `Checked ${new Date(probe.checked_at).toLocaleString()}`),
        h('table', { class: 'files-table probe-table' },
          h('thead', null, h('tr', null, h('th', null, 'Service'), h('th', null, 'Result'), h('th', { class: 'num' }, 'Time'), h('th', null, 'Rate-limit headers'))),
          h('tbody', null, probe.results.map((r) => h('tr', { class: 'no-open' },
            h('td', null, r.name),
            h('td', null, h('span', { class: 'dot', 'data-c': r.ok ? 'green' : r.skipped ? 'amber' : 'red' }), ' ', r.skipped ? r.note : r.status ? `${r.status}${r.ok ? ' OK' : ''}` : r.note),
            h('td', { class: 'num' }, r.ms !== undefined ? `${r.ms} ms` : ''),
            h('td', { class: 'faint' }, Object.entries(r.limits || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || '—')))))) : null));
}

export const money = fmtMicros;
