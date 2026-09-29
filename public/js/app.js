/**
 * Start-up, login, the shell (sidebar + page), routing and the global keyboard.
 * Pages are plain functions that fill three regions (top bar, toolbar, content) from the store;
 * any change to the store re-renders the current page on the next animation frame.
 */

import { h, mount, isTyping } from './dom.js';
import { icon } from './icons.js';
import { api, setUnauthorizedHandler } from './api.js';
import { state, loadBoot, subscribe, applyTheme, localStorageGet, localStorageSet, setting } from './store.js';
import { nav } from './nav.js';
import { hasLayer, closePopover } from './ui/overlay.js';
import { closePanel } from './ui/panel.js';
import { renderHome, newTable } from './pages/home.js';
import { renderTable, tableKeys } from './pages/table.js';
import { renderSettings } from './pages/settings.js';
import { renderTrash, leaveTrash } from './pages/trash.js';
import { renderFind } from './pages/find.js';
import { renderAudience, leaveAudience } from './pages/audiences.js';
import { renderAgents, leaveAgents } from './pages/agents.js';
import { renderWorkflows, leaveWorkflows } from './pages/workflows.js';
import { renderSignals, leaveSignals } from './pages/signals.js';
import { renderMcp, renderApi, leaveDeveloper } from './pages/developer.js';
import { renderExports, leaveExports } from './pages/exports.js';
import { BRAND } from './brand.js';
import { fmtMicros } from './types.js';
import { menu } from './ui/overlay.js';
import './features.js';

const root = document.getElementById('root');
let shell = null; let route = {}; let pending = false;

/* ---------------------------------------------------------------- routing */

function parse() {
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] === 't' && Number(parts[1])) return { page: 'table', id: Number(parts[1]) };
  if (parts[0] === 'settings') return { page: 'settings', section: parts[1] || 'general' };
  if (parts[0] === 'trash') return { page: 'trash' };
  if (parts[0] === 'find') return { page: 'find' };
  if (parts[0] === 'people' || parts[0] === 'companies') return { page: 'audience', kind: parts[0] };
  if (parts[0] === 'agents') return { page: 'agents', id: Number(parts[1]) || null };
  if (parts[0] === 'workflows') return { page: 'workflows', id: Number(parts[1]) || null };
  if (parts[0] === 'signals') return { page: 'signals' };
  if (parts[0] === 'mcp') return { page: 'mcp' };
  if (parts[0] === 'api') return { page: 'api' };
  if (parts[0] === 'exports') return { page: 'exports' };
  return { page: 'home' };
}

nav.current = () => route;
nav.go = (path) => {
  closePopover();
  if (location.pathname !== path) { closePanel(); history.pushState(null, '', path); }
  shell?.app.classList.remove('side-open');
  render();
};

/* ---------------------------------------------------------------- shell */

function buildShell() {
  const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Main' });
  const top = h('header', { class: 'topbar' });
  const toolbar = h('div', { class: 'toolbar' });
  const content = h('div', { class: 'content', id: 'content' });
  const bottom = h('div', { class: 'bottombar' });
  const main = h('main', { class: 'main' }, top, toolbar, content, bottom);
  const app = h('div', { class: 'app' }, sidebar, main);
  if (localStorageGet('fc.side') === 'hidden') app.classList.add('side-hidden');
  mount(root, app);
  shell = { app, sidebar, top, toolbar, content, bottom, main };
}

function link(path, children, { active, cls = 'nav' } = {}) {
  return h('a', { class: [cls, active && 'active'], href: path, 'aria-current': active ? 'page' : null,
    onClick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); nav.go(path); } }, children);
}

/** Grouped like Clay's sidebar (site-teardowns/clay/teardown.md, section 2). */
function renderSidebar() {
  const tables = state.boot?.tables || [];
  const at = (page, extra = {}) => route.page === page && Object.entries(extra).every(([k, v]) => route[k] === v);
  const item = (path, ic, label, active, badge) => link(path, [icon(ic, 16), h('span', { class: 'grow ellipsis' }, label), badge || null], { active });
  const favs = tables.filter((t) => t.favorite);
  mount(shell.sidebar,
    h('div', { class: 'ws' }, h('img', { class: 'ws-mark', src: BRAND.logo, alt: '' }), h('span', { class: 'ws-name ellipsis grow' }, BRAND.name),
      h('button', { class: 'btn ghost icon sm', 'aria-label': 'Hide sidebar', title: 'Hide sidebar', onClick: () => {
        shell.app.classList.add('side-hidden'); localStorageSet('fc.side', 'hidden'); render();
      } }, icon('sidebar', 15))),
    item('/', 'home', 'Home', at('home')),
    item('/find', 'search', 'Find leads', at('find')),
    h('div', { class: 'side-sep' }),
    h('div', { class: 'side-label' }, 'Audiences'),
    item('/people', 'users', 'People', at('audience', { kind: 'people' })),
    item('/companies', 'building', 'Companies', at('audience', { kind: 'companies' })),
    h('div', { class: 'side-sep' }),
    h('div', { class: 'side-label' }, 'Orchestration'),
    item('/signals', 'activity', 'Signals', route.page === 'signals'),
    item('/agents', 'sparkle', 'Agents', route.page === 'agents'),
    item('/workflows', 'layers', 'Workflows', route.page === 'workflows'),
    item('/mcp', 'link', 'MCP', route.page === 'mcp'),
    item('/api', 'code', 'API and CLI', route.page === 'api'),
    favs.length ? [h('div', { class: 'side-sep' }), h('div', { class: 'side-label' }, 'Favorites'),
      favs.map((t) => item(`/t/${t.id}`, 'star', t.name, at('table', { id: t.id })))] : null,
    h('div', { class: 'side-foot' },
      item('/exports', 'download', 'Exports', route.page === 'exports'),
      item('/trash', 'trash', 'Trash', at('trash')),
      item('/settings', 'sliders', 'Settings', at('settings'))));
}

/** Top-bar right side on every page: this month's spend and the profile menu. */
export function topRight() {
  const name = setting('profile_name', '') || 'You';
  return h('div', { class: 'top-right' },
    h('a', { class: 'spend-chip', href: '/settings/spend', title: 'Spend this month, all tables', onClick: (e) => { e.preventDefault(); nav.go('/settings/spend'); } },
      icon('dollar', 13), fmtMicros(state.boot?.month_micros || 0), h('span', { class: 'faint' }, 'this month')),
    h('button', { class: 'avatar-btn', 'aria-label': 'Profile menu', onClick: (e) => menu(e.currentTarget, [
      { group: name },
      { label: 'Settings', icon: 'sliders', onSelect: () => nav.go('/settings') },
      { label: 'Keys', icon: 'key', onSelect: () => nav.go('/settings/keys') },
      { label: 'Spend', icon: 'dollar', onSelect: () => nav.go('/settings/spend') },
      { sep: true },
      { label: 'Log out', icon: 'logout', onSelect: logout },
    ], { align: 'end' }) }, name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()));
}

/* ---------------------------------------------------------------- render */

/** Re-rendering while someone types in an unlabelled field would eat their input; wait for blur. */
function shouldDefer() {
  const a = document.activeElement;
  if (!a || !shell) return false;
  const inApp = shell.main.contains(a) || shell.sidebar.contains(a);
  return inApp && (a.isContentEditable || (['INPUT', 'TEXTAREA'].includes(a.tagName) && !a.id));
}

function render() {
  if (!shell) return;
  if (shouldDefer()) { pending = true; return; }
  pending = false;
  route = parse();
  const focusId = document.activeElement?.id;
  const sel = focusId ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
  if (shell.app.classList.contains('side-hidden')) {
    if (!shell.app.querySelector('.side-show')) shell.main.prepend(h('button', { class: 'btn ghost icon side-show', 'aria-label': 'Show sidebar', title: 'Show sidebar',
      onClick: (e) => { shell.app.classList.remove('side-hidden'); e.currentTarget.remove(); localStorageSet('fc.side', ''); render(); } }, icon('sidebar', 15)));
    shell.top.style.paddingLeft = '48px';
  } else { shell.app.querySelector('.side-show')?.remove(); shell.top.style.paddingLeft = ''; }
  renderSidebar();
  const regions = { top: shell.top, toolbar: shell.toolbar, content: shell.content, bottom: shell.bottom };
  shell.toolbar.hidden = route.page !== 'table';
  shell.bottom.hidden = route.page !== 'table' || !state.t || state.t.table.id !== route.id;
  if (route.page === 'table') renderTable(regions, route.id);
  else if (route.page === 'settings') renderSettings(regions, route);
  else if (route.page === 'trash') renderTrash(regions);
  else if (route.page === 'find') renderFind(regions);
  else if (route.page === 'audience') renderAudience(regions, route.kind);
  else if (route.page === 'agents') renderAgents(regions, route.id);
  else if (route.page === 'workflows') renderWorkflows(regions, route.id);
  else if (route.page === 'signals') renderSignals(regions);
  else if (route.page === 'mcp') renderMcp(regions);
  else if (route.page === 'api') renderApi(regions);
  else if (route.page === 'exports') renderExports(regions);
  else renderHome(regions);
  if (route.page !== 'trash') leaveTrash();
  if (route.page !== 'audience') leaveAudience();
  if (route.page !== 'agents') leaveAgents();
  if (route.page !== 'workflows') leaveWorkflows();
  if (route.page !== 'signals') leaveSignals();
  if (route.page !== 'mcp' && route.page !== 'api') leaveDeveloper();
  if (route.page !== 'exports') leaveExports();
  if (route.page !== 'table') shell.top.append(h('span', { class: 'grow' }), topRight());
  const t = route.page === 'table' ? state.boot?.tables.find((x) => x.id === route.id)?.name : route.page === 'settings' ? 'Settings'
    : route.page === 'trash' ? 'Trash' : route.page === 'find' ? 'Find leads' : route.page === 'audience' ? (route.kind === 'people' ? 'People' : 'Companies') : route.page === 'agents' ? 'Agents' : ({ workflows: 'Workflows', signals: 'Signals', mcp: 'MCP', api: 'API and CLI', exports: 'Exports' })[route.page] || 'Home';
  document.title = `${t || 'Table'} · ${BRAND.name}`;
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el && document.activeElement !== el) { el.focus(); if (sel && el.setSelectionRange) try { el.setSelectionRange(...sel); } catch { /* not a text input */ } }
  }
}

document.addEventListener('focusout', () => { if (pending) setTimeout(() => { if (pending && !shouldDefer()) render(); }); });
window.addEventListener('popstate', () => { closePopover(); closePanel(); render(); });

document.addEventListener('keydown', (e) => {
  if (!shell) return;
  if (route.page === 'table' && tableKeys(e)) return;
  if (hasLayer() || isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/' && route.page === 'table') { e.preventDefault(); document.getElementById('tsearch')?.focus(); }
});

/* ---------------------------------------------------------------- login and boot */

async function logout() {
  await api.post('/logout').catch(() => {});
  renderLogin();
}

function renderLogin(message) {
  shell = null; closePanel();
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Password', 'aria-label': 'Password', id: 'pw' });
  const err = h('div', { class: 'field-error', role: 'alert', hidden: !message }, message || '');
  const btn = h('button', { class: 'btn primary', type: 'submit', style: { height: '34px' } }, 'Continue');
  const form = h('form', { class: 'stack', onSubmit: async (e) => {
    e.preventDefault();
    btn.disabled = true; err.hidden = true;
    try { await api.post('/login', { password: input.value }); await boot(); }
    catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; input.select(); }
  } }, input, err, btn);
  mount(root, h('div', { class: 'login' }, h('div', { class: 'login-card' },
    h('img', { class: 'login-mark', src: BRAND.logo, alt: BRAND.name }),
    h('div', null, h('h1', null, `Sign in to ${BRAND.name}`), h('p', null, 'Enter the password you set with ', h('code', null, 'wrangler secret put APP_PASSWORD'), '.')),
    form,
    h('div', { class: 'login-foot' }, `${BRAND.tagline} Your data, on your own Cloudflare account.`))));
  requestAnimationFrame(() => input.focus());
}

function renderProblem(title, text) {
  mount(root, h('div', { class: 'login' }, h('div', { class: 'login-card' }, h('h1', null, title), h('p', null, text))));
}

async function boot() {
  try { await api.get('/me'); }
  catch (e) {
    if (e.status === 401) return renderLogin();
    return renderProblem('Setup is not finished', e.message);
  }
  try { await loadBoot(); }
  catch (e) { return renderProblem('Could not load your data', e.message + (/no such table/i.test(e.message) ? ' Run: npx wrangler d1 execute free-clay --remote --file schema.sql' : '')); }
  buildShell();
  render();
}

setUnauthorizedHandler(() => { if (shell) renderLogin('Your session ended. Sign in again.'); });
subscribe(render);
applyTheme();
boot();
