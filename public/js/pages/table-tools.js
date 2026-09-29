/**
 * The Tools catalog, Clay's blue Tools button (site-teardowns/clay/teardown.md, 5.7): tabs For you,
 * Sources, Enrich, Signals and Exports, a search, and a page per provider with its key status.
 * Every item opens the normal column editor, preset, so nothing here can run or spend on its own.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { state } from '../store.js';
import { openPanel } from '../ui/panel.js';
import { openColumnPanel } from '../ui/column-panel.js';
import { functions, costChip, guessInputs } from '../features/enrich.js';
import { tableHooks, importCsv } from './table.js';

const TABS = [['foryou', 'For you'], ['sources', 'Sources'], ['enrich', 'Enrich'], ['signals', 'Signals'], ['exports', 'Exports']];
const CATEGORY = { email: 'Email', contact: 'Contact info', company: 'Company', web: 'Web and search', export: 'Send and export' };
const view = { tab: 'foryou', q: '', provider: null };

export function openTools() {
  openPanel({
    title: 'Tools', width: 520,
    body: (el, p) => {
      const draw = (list) => {
        const search = h('input', { id: 'tools-q', value: view.q, placeholder: 'Search tools and providers', 'aria-label': 'Search tools',
          onInput: (e) => { view.q = e.target.value; view.provider = null; draw(list); requestAnimationFrame(() => { const i = el.querySelector('#tools-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); } });
        const tabs = h('div', { class: 'seg-tabs tools-tabs', role: 'tablist' }, TABS.map(([k, label]) => h('button', {
          class: ['seg', view.tab === k && 'on'], role: 'tab', 'aria-selected': view.tab === k ? 'true' : 'false',
          onClick: () => { view.tab = k; view.provider = null; draw(list); } }, label)));
        const ctx = { list, p, redraw: () => draw(list) };
        const q = view.q.trim().toLowerCase();
        mount(el, h('label', { class: 'tsearch tools-search' }, icon('search', 14), search), q ? null : tabs,
          h('div', { class: 'tools-body' }, q ? searchResults(q, ctx) : view.provider ? providerPage(view.provider, ctx) : TAB_BODY[view.tab](ctx)));
      };
      mount(el, h('div', { class: 'faint' }, 'Loading…'));
      functions().then(draw);
    },
  });
}

/* ---------------------------------------------------------------- pieces */

const cols = () => state.t.columns;

/** Open the column editor for one function, inputs guessed from column names. */
function useFunction(f) {
  openColumnPanel(null, { preset: { kind: 'enrich', name: f.name, type: f.type, config: { fn: f.id, inputs: guessInputs(f, cols()) } } });
}

function keyState(secret) {
  const s = (state.boot.secrets || []).find((x) => x.name === secret);
  return s?.set ? 'set' : s ? 'named' : 'missing';
}

function keyBadge(secret) {
  const st = keyState(secret);
  return h('span', { class: ['key-badge', st], title: st === 'set' ? `${secret} is set on the Worker` : st === 'named' ? `${secret} is listed but not set yet` : `${secret} is not set up` },
    icon('key', 12), st === 'set' ? 'Key set' : 'Needs key');
}

function fnRow(f) {
  return h('button', { class: 'tool-row', onClick: () => useFunction(f) },
    h('span', { class: ['tool-ic', f.secret && 'keyed'] }, icon(f.secret ? 'key' : 'zap', 15)),
    h('span', { class: 'tool-text' }, h('b', null, f.name), h('span', null, f.blurb)),
    h('span', { class: 'tool-meta' }, costChip(f), f.secret ? keyBadge(f.secret) : null));
}

function actionRow(ic, title, text, onClick, meta) {
  return h('button', { class: 'tool-row', onClick },
    h('span', { class: 'tool-ic' }, icon(ic, 15)), h('span', { class: 'tool-text' }, h('b', null, title), h('span', null, text)),
    meta ? h('span', { class: 'tool-meta' }, meta) : null);
}

function note(text) { return h('div', { class: 'tools-note' }, icon('clock', 14), h('span', null, text)); }
const section = (title, ...kids) => h('div', { class: 'tools-sect' }, h('div', { class: 'pop-label' }, title), ...kids);

/* ---------------------------------------------------------------- tabs */

const TAB_BODY = {
  foryou({ list }) {
    const by = (id) => list.find((f) => f.id === id);
    const emailSteps = ['hunter_email_finder', 'prospeo_enrich_person'].map(by).filter(Boolean);
    return [
      section('Most useful',
        actionRow('sparkle', 'Use AI', 'A prompt per row on Groq (free tier), Anthropic or OpenAI, with your key.', () => openColumnPanel(null, { preset: { kind: 'ai', name: 'AI' } })),
        emailSteps.length ? actionRow('layers', 'Work email waterfall', `Try ${emailSteps.map((f) => f.provider).join(', then ')} in order and stop at the first hit.`,
          () => openColumnPanel(null, { preset: { kind: 'waterfall', name: 'Work email', type: 'email', config: { steps: emailSteps.map((f) => ({ fn: f.id, inputs: guessInputs(f, cols()), enabled: true })) } } }),
          h('span', { class: 'cost' }, 'Your keys')) : null,
        ...['scrape_website', 'find_contact_info', 'website_check', 'email_provider'].map(by).filter(Boolean).map(fnRow)),
      section('Build your own',
        actionRow('fx', 'Formula', 'Compute from other columns. Free, runs in the browser and the Worker.', () => openColumnPanel(null, { preset: { kind: 'formula' } })),
        actionRow('code', 'HTTP API', 'Call any API per row, with your keys filled in on the Worker.', () => openColumnPanel(null, { preset: { kind: 'http' } }))),
    ];
  },

  sources({ p }) {
    // Popovers these open anchor to the Tools button: the panel closes first.
    const anchor = document.querySelector('.toolbar .tbtn.primary') || document.body;
    return [
      section('Add rows to this table',
        actionRow('upload', 'Import from CSV', 'Columns are matched by name; new ones are created.', () => { p.close(); importCsv(); }),
        ...tableHooks.addRows.map((fn) => fn(anchor)).map((it) => actionRow(it.icon, it.label, it.label.includes('Google') ? 'Search Google Maps on your key and add each business as a row.' : 'Other tools POST rows here; each request is signed.', () => { p.close(); it.onSelect(); }))),
      note('Find people and Find companies at these companies arrive with Find leads (phase 6 of the Free Clay plan).'),
    ];
  },

  enrich(ctx) {
    const { list } = ctx;
    const providers = [...new Set(list.map((f) => f.provider))].sort((a, b) => (a === 'Free Clay' ? -1 : b === 'Free Clay' ? 1 : a.localeCompare(b)));
    return [
      section('Browse by provider', h('div', { class: 'provider-grid' }, providers.map((name) => {
        const fns = list.filter((f) => f.provider === name);
        const secret = fns.find((f) => f.secret)?.secret;
        return h('button', { class: 'provider-tile', onClick: () => { view.provider = name; ctx.redraw(); } },
          h('span', { class: 'provider-mark' }, name === 'Free Clay' ? icon('zap', 14) : name[0]),
          h('span', { class: 'tool-text' }, h('b', null, name === 'Free Clay' ? 'Free Clay (free)' : name), h('span', null, `${fns.length} ${fns.length === 1 ? 'tool' : 'tools'}`)),
          secret ? keyBadge(secret) : h('span', { class: 'cost free' }, 'Free'));
      }))),
      ...Object.entries(CATEGORY).map(([k, label]) => {
        const fns = list.filter((f) => f.category === k && k !== 'export');
        return fns.length ? section(label, ...fns.map(fnRow)) : null;
      }),
    ];
  },

  signals({ p }) {
    const go = (path) => { p.close(); import('../nav.js').then((m) => m.nav.go(path)); };
    return [section('Signals',
      actionRow('briefcase', 'New job posted', 'Watch companies’ public job boards. Each new role can add a row here.', () => go('/signals')),
      actionRow('globe', 'Website changed', 'Get a row when a page’s text changes, with what was added.', () => go('/signals')),
      actionRow('file-text', 'In the news', 'New Google News stories about a company or phrase.', () => go('/signals')),
      actionRow('building', 'New SEC filing', 'Form D (a private raise) or 8-K filings of public companies.', () => go('/signals'))),
      note('Pick this table as the signal’s destination and every new event becomes a row, ready for your enrichments.')];
  },

  exports({ list, p }) {
    const hook = list.find((f) => f.id === 'send_to_webhook');
    return [
      section('Export',
        actionRow('download', 'Download CSV', 'Every column, formulas included, as the rows are now.', () => { p.close(); location.href = `/api/tables/${state.t.table.id}/export.csv`; }),
        hook ? fnRow(hook) : null),
      section('Audiences',
        actionRow('users', 'Send to People', 'Add these rows to your People database. Same email = same person; new values fill blanks.', () => { p.close(); import('./audiences.js').then((m) => m.fromTableDialog('people', state.t.table)); }),
        actionRow('building', 'Send to Companies', 'Add these rows to your Companies database, matched by domain.', () => { p.close(); import('./audiences.js').then((m) => m.fromTableDialog('companies', state.t.table)); })),
      note('Workflows can send rows to People, Companies, a webhook or another table on their own, on a trigger.'),
    ];
  },
};

function providerPage(name, ctx) {
  const fns = ctx.list.filter((f) => f.provider === name);
  const secret = fns.find((f) => f.secret)?.secret;
  const st = secret ? keyState(secret) : null;
  return [
    h('button', { class: 'btn ghost sm tools-back', onClick: () => { view.provider = null; ctx.redraw(); } }, icon('arrow-left', 14), 'All providers'),
    h('div', { class: 'provider-head' }, h('span', { class: 'provider-mark lg' }, name === 'Free Clay' ? icon('zap', 18) : name[0]),
      h('div', null, h('h3', null, name === 'Free Clay' ? 'Free Clay (free)' : name),
        h('span', { class: 'faint' }, name === 'Free Clay' ? 'Built in. No key, no bill: they run on the Worker.' : 'Runs on your own account. You pay the provider directly, at their price.'))),
    secret ? h('div', { class: ['note', st === 'set' ? 'ok' : 'warn'] }, icon('key', 14),
      st === 'set' ? `${secret} is set on the Worker.`
        : h('span', null, `Needs ${secret}. In the free-clay folder on your computer run `, h('code', null, `npx wrangler secret put ${secret}`),
          st === 'named' ? ', then reload.' : ', then add the name in Settings, Keys.')) : null,
    section('Tools', ...fns.map(fnRow)),
  ];
}

function searchResults(q, ctx) {
  const hits = ctx.list.filter((f) => [f.name, f.blurb, f.provider, CATEGORY[f.category]].some((t) => String(t || '').toLowerCase().includes(q)));
  return hits.length ? section(`${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`, ...hits.map(fnRow))
    : h('div', { class: 'files-empty' }, 'No tool matches that. Try a provider name, or “email”, “website”, “company”.');
}
