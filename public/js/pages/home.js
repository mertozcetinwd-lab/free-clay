/**
 * Home, laid out like Clay's (site-teardowns/clay/teardown.md, "Home"): a greeting, a "describe
 * what you want" box, four action cards, then All files with tabs, search and a row menu.
 */

import { h, mount, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, refreshTableList, setting, changed, localStorageGet, localStorageSet } from '../store.js';
import { nav } from '../nav.js';
import { toast, menu, confirmDialog, popover, modal } from '../ui/overlay.js';
import { TABLE_TEMPLATES } from '../table-templates.js';

// folder: the open folder's id, or null for the top level of All files.
const view = { tab: 'all', q: '', folder: null, sort: { key: 'last_opened_at', dir: 'desc' } };

/** Used by a table's breadcrumb: Home opens with this folder showing. */
export function openFolder(id) { view.tab = 'all'; view.q = ''; view.folder = id; }

export async function newTable(csv, name) {
  try {
    const t = await api.post('/tables', csv ? { name, csv } : { name: 'Untitled table' });
    // A table made while a folder is open lands in that folder, as it does in Clay.
    if (view.folder && view.tab === 'all' && nav.current().page === 'home') await api.patch(`/tables/${t.id}`, { folder_id: view.folder });
    await refreshTableList();
    nav.go(`/t/${t.id}`);
  } catch (e) { toast(e.message, { error: true }); }
}

function importCsv() {
  const input = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0]; input.remove();
    if (!file) return;
    if (file.size > 10_000_000) return toast('That file is over 10 MB. Split it first.', { error: true });
    newTable(await file.text(), file.name.replace(/\.csv$/i, '').slice(0, 80));
  });
  document.body.append(input); input.click();
}

/** Clay's Templates modal: pick one, get a table with its columns set up. Nothing runs. */
function fromTemplate() {
  modal({ title: 'Start from a template', width: 760, className: 'agent-new',
    body: (b) => b.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Each template makes a table with its enrichment columns set up. Nothing runs until you press Run.'),
      h('div', { class: 'tcards agent-gallery' }, TABLE_TEMPLATES.map((t) => h('button', { class: 'tcard', onClick: () => useTemplate(t) },
        h('span', { class: 'files-ic' }, icon(t.icon, 16)), h('b', null, t.name), h('span', { class: 'faint' }, t.blurb))))) });
}

async function useTemplate(t) {
  document.querySelector('.modal-scrim')?.remove();
  try {
    const made = t.sample ? await api.post('/tables/sample') : await api.post('/assist/build', { plan: t.plan });
    await refreshTableList();
    toast(t.sample ? 'Sample table ready. Its columns are set up but have not run: press Run on any column.' : 'Table ready. Add rows (paste, CSV or Find leads), then press Run on a column.');
    nav.go(`/t/${made.id}`);
  } catch (e) { toast(e.message, { error: true }); }
}

/* ---------------------------------------------------------------- describe box */

let plan = null; let planBusy = false;

function describeBox() {
  const input = h('textarea', { class: 'ask-input', id: 'ask', rows: 1, placeholder: 'Describe the list you want, like “roofers in Tampa with their website and email provider”',
    'aria-label': 'Describe the list you want',
    onKeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } } });
  const ask = async () => {
    const prompt = input.value.trim();
    if (!prompt || planBusy) return;
    planBusy = true; plan = null; changed();
    try { plan = { prompt, ...(await api.post('/assist/plan', { prompt })) }; }
    catch (e) { toast(e.message, { error: true }); }
    planBusy = false; changed();
  };
  return h('div', { class: 'ask' },
    h('div', { class: 'ask-row' }, icon('sparkle', 18), input,
      h('button', { class: 'btn primary icon', 'aria-label': 'Draft a table', title: 'Draft a table (free, runs on Groq)', onClick: ask, disabled: planBusy }, icon(planBusy ? 'clock' : 'arrow-up', 16))),
    planBusy ? h('div', { class: 'plan-card' }, h('div', { class: 'skel', style: { width: '60%' } }), h('div', { class: 'skel', style: { width: '40%', marginTop: '8px' } })) : null,
    plan ? planCard() : null);
}

function planCard() {
  const build = async () => {
    try {
      const t = await api.post('/assist/build', { plan });
      plan = null; await refreshTableList(); nav.go(`/t/${t.id}`);
      toast('Table built. Nothing has run yet: add rows, then press Run on a column.');
    } catch (e) { toast(e.message, { error: true }); }
  };
  return h('div', { class: 'plan-card' },
    h('div', { class: 'plan-h' }, h('b', null, plan.name), h('span', { class: 'faint' }, 'Draft table. Nothing runs until you press Run.')),
    h('div', { class: 'plan-cols' },
      plan.columns.map((c) => h('span', { class: 'plan-chip' }, icon('text', 13), c.name)),
      plan.enrichments.map((e) => h('span', { class: ['plan-chip', 'fx'] }, icon(e.paid ? 'key' : 'zap', 13), e.name, h('span', { class: 'faint' }, e.paid ? 'your key' : 'free')))),
    plan.notes.length ? h('ul', { class: 'plan-notes' }, plan.notes.map((n) => h('li', null, n))) : null,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onClick: build }, icon('check', 14), 'Build this table'),
      h('button', { class: 'btn', onClick: () => { plan = null; changed(); } }, 'Discard')));
}

/* ---------------------------------------------------------------- page */

export function renderHome(regions) {
  const tables = state.boot?.tables || [];
  const name = setting('profile_name', '');
  mount(regions.top, h('div', { class: 'crumbs' }, h('b', null, 'Home')));
  mount(regions.toolbar);
  const collapsed = localStorageGet('fc.home.less') === '1';

  const cards = [
    ['search', 'green', 'Find leads', 'Find businesses, companies and jobs from open data and your keys.', () => nav.go('/find')],
    ['upload', 'violet', 'Import data', 'Bring in your own list from a CSV file.', importCsv],
    ['users', 'amber', 'Build a segment', 'Save a filtered list of people or companies that updates itself.', () => nav.go('/people')],
    ['table', 'blue', 'Start from template', 'Ready-made tables for common jobs, with the enrichments set up.', fromTemplate],
  ];

  mount(regions.content, h('div', { class: 'home' },
    h('div', { class: 'home-head' },
      h('h1', { class: 'greet' }, name ? `Hey ${name}, ready to get started?` : 'Ready to get started?'),
      h('button', { class: 'btn sm', onClick: () => { localStorageSet('fc.home.less', collapsed ? '0' : '1'); changed(); } },
        collapsed ? 'Show more' : 'Show less', icon(collapsed ? 'chevron-down' : 'chevron-up', 13))),
    collapsed ? null : [
      describeBox(),
      h('div', { class: 'action-cards' }, cards.map(([ic, c, title, text, go]) => h('button', { class: 'action-card', onClick: go },
        h('span', { class: 'ac-ic', 'data-c': c }, icon(ic, 18)), h('b', null, title), h('span', null, text)))),
    ],
    filesSection(tables)));
}

function filesSection(tables) {
  const folders = state.boot?.folders || [];
  if (view.folder && !folders.some((f) => f.id === view.folder)) view.folder = null;
  const q = view.q.toLowerCase();
  // Search, Recents and Favorites list every table flat; plain All files browses by folder.
  const browsing = view.tab === 'all' && !q;
  const open = browsing && view.folder ? folders.find((f) => f.id === view.folder) : null;
  let list = tables.filter((t) => !q || t.name.toLowerCase().includes(q));
  if (browsing) list = list.filter((t) => (t.folder_id || null) === (open ? open.id : null));
  if (view.tab === 'recent') list = list.filter((t) => t.last_opened_at);
  if (view.tab === 'favorites') list = list.filter((t) => t.favorite);
  const folderRows = browsing && !open ? folders : [];
  const { key, dir } = view.tab === 'recent' ? { key: 'last_opened_at', dir: 'desc' } : view.sort;
  list = [...list].sort((a, b) => {
    const x = a[key] ?? ''; const y = b[key] ?? '';
    return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'asc' ? 1 : -1);
  });
  const th = (k, label, cls) => h('th', { class: cls, scope: 'col' }, h('button', { class: 'th-sort', onClick: () => { view.sort = { key: k, dir: view.sort.key === k && view.sort.dir === 'desc' ? 'asc' : 'desc' }; changed(); } },
    label, view.sort.key === k ? icon(view.sort.dir === 'asc' ? 'arrow-up' : 'arrow-down', 12) : null));
  const search = h('input', { id: 'files-q', placeholder: 'Search files', value: view.q, 'aria-label': 'Search files', onInput: debounce((e) => { view.q = e.target.value; changed(); }, 120) });
  const tab = (k, label) => h('button', { class: ['seg', view.tab === k && 'on'], onClick: () => { view.tab = k; changed(); } }, label);

  return h('section', { class: 'files' },
    h('div', { class: 'files-head' }, h('span', { class: 'files-ic' }, icon('file-text', 18)), h('h2', null, 'All files'), h('span', { class: 'grow' }),
      h('label', { class: 'tsearch wide' }, icon('search', 14), search),
      h('button', { class: 'btn primary', onClick: (e) => { const anchor = e.currentTarget; menu(anchor, [
        { label: 'Blank table', icon: 'table', onSelect: () => newTable() },
        { label: 'Import a CSV', icon: 'upload', onSelect: importCsv },
        { label: 'From template', icon: 'layers', onSelect: fromTemplate },
        open ? null : { label: 'Folder', icon: 'folder-plus', onSelect: () => setTimeout(() => newFolder(anchor)) },
      ].filter(Boolean), { align: 'end' }); } }, icon('plus', 15), 'New')),
    h('div', { class: 'files-bar' },
      h('div', { class: 'seg-tabs' }, tab('all', 'All files'), tab('recent', 'Recents'), tab('favorites', 'Favorites')),
      open ? h('div', { class: 'files-crumbs' }, h('button', { onClick: () => { view.folder = null; changed(); } }, 'All files'), icon('chevron-right', 13), icon('folder', 14), h('b', null, open.name)) : null),
    list.length || folderRows.length ? h('table', { class: 'files-table' },
      h('thead', null, h('tr', null, th('name', 'Name'), h('th', { class: 'c-fav' }, 'Favorite'), th('row_count', 'Rows', 'num'), th('column_count', 'Columns', 'num'),
        th('created_at', 'Created'), th('last_opened_at', 'Last opened'), h('th', { class: 'c-menu' }))),
      h('tbody', null, folderRows.map((f) => folderRow(f, tables)), list.map((t) => h('tr', { onClick: (e) => { if (!e.target.closest('button')) nav.go(`/t/${t.id}`); } },
        h('td', null, h('span', { class: 'fname' }, icon('table', 15), h('span', { class: 'ellipsis' }, t.name))),
        h('td', { class: 'c-fav' }, h('button', { class: ['star', t.favorite && 'on'], 'aria-label': t.favorite ? 'Remove from favorites' : 'Add to favorites', onClick: () => toggleFav(t) }, icon('star', 16))),
        h('td', { class: 'num' }, (t.row_count || 0).toLocaleString('en-US')),
        h('td', { class: 'num' }, t.column_count ?? ''),
        h('td', null, when(t.created_at)),
        h('td', null, t.last_opened_at ? ago(t.last_opened_at) : h('span', { class: 'faint' }, 'Never')),
        h('td', { class: 'c-menu' }, h('button', { class: 'btn ghost icon sm', 'aria-label': `Actions for ${t.name}`, onClick: (e) => rowMenu(e.currentTarget, t) }, icon('more', 16))))))) :
      h('div', { class: 'files-empty' }, view.tab === 'favorites' ? 'No favorites yet. Star a table to keep it here and in the sidebar.'
        : view.q ? 'No files match that search.' : open ? 'This folder is empty. Move a table here from its ⋯ menu, or make one with New.'
        : 'No tables yet. Start with Import data or a template above.'));
}

function folderRow(f, tables) {
  const inside = tables.filter((t) => t.folder_id === f.id);
  const openIt = () => { view.folder = f.id; changed(); };
  return h('tr', { onClick: (e) => { if (!e.target.closest('button')) openIt(); } },
    h('td', null, h('span', { class: 'fname' }, h('span', { class: 'folder-ic' }, icon('folder', 15)), h('span', { class: 'ellipsis' }, f.name),
      h('span', { class: 'faint' }, `${inside.length} ${inside.length === 1 ? 'table' : 'tables'}`))),
    h('td', { class: 'c-fav' }),
    h('td', { class: 'num' }, inside.reduce((n, t) => n + (t.row_count || 0), 0).toLocaleString('en-US')),
    h('td', { class: 'num' }),
    h('td', null, when(f.created_at)),
    h('td'),
    h('td', { class: 'c-menu' }, h('button', { class: 'btn ghost icon sm', 'aria-label': `Actions for folder ${f.name}`, onClick: (e) => {
      const anchor = e.currentTarget;
      menu(anchor, [
        { label: 'Open', icon: 'arrow-right', onSelect: openIt },
        { label: 'Rename', icon: 'pencil', onSelect: () => setTimeout(() => namePopover(anchor, f.name, 'Folder name', async (n) => { await api.patch(`/folders/${f.id}`, { name: n }); })) },
        { sep: true },
        { label: 'Remove folder', icon: 'trash', danger: true, onSelect: async () => {
          if (!(await confirmDialog({ title: `Remove the folder “${f.name}”?`, text: inside.length ? `Its ${inside.length} ${inside.length === 1 ? 'table moves' : 'tables move'} back to All files. No table is deleted.` : 'It is empty.', confirmLabel: 'Remove folder', danger: true }))) return;
          try { await api.del(`/folders/${f.id}`); refreshTableList(); } catch (err) { toast(err.message, { error: true }); }
        } },
      ], { align: 'end' });
    } }, icon('more', 16))));
}

function newFolder(anchor) {
  namePopover(anchor, '', 'Folder name', async (name) => {
    const f = await api.post('/folders', { name });
    view.tab = 'all'; view.q = ''; view.folder = f.id;
  });
}

function moveMenu(anchor, t) {
  const folders = state.boot?.folders || [];
  menu(anchor, [
    { group: 'Move to' },
    t.folder_id ? { label: 'All files (no folder)', icon: 'file-text', onSelect: () => move(t, null) } : null,
    ...folders.filter((f) => f.id !== t.folder_id).map((f) => ({ label: f.name, icon: 'folder', onSelect: () => move(t, f.id) })),
    { sep: true },
    { label: 'New folder', icon: 'folder-plus', onSelect: () => setTimeout(() => namePopover(anchor, '', 'Folder name', async (name) => {
      const f = await api.post('/folders', { name });
      await api.patch(`/tables/${t.id}`, { folder_id: f.id });
    })) },
  ].filter(Boolean), { align: 'end' });
}

async function move(t, folderId) {
  try { await api.patch(`/tables/${t.id}`, { folder_id: folderId }); await refreshTableList(); }
  catch (e) { toast(e.message, { error: true }); }
}

async function toggleFav(t) {
  try { await api.patch(`/tables/${t.id}`, { favorite: !t.favorite }); await refreshTableList(); }
  catch (e) { toast(e.message, { error: true }); }
}

function rowMenu(anchor, t) {
  menu(anchor, [
    { label: 'Open', icon: 'arrow-right', onSelect: () => nav.go(`/t/${t.id}`) },
    { label: 'Rename', icon: 'pencil', onSelect: () => setTimeout(() => namePopover(anchor, t.name, 'Table name', async (n) => { await api.patch(`/tables/${t.id}`, { name: n }); })) },
    { label: t.favorite ? 'Remove from favorites' : 'Add to favorites', icon: 'star', onSelect: () => toggleFav(t) },
    { label: 'Move to folder', icon: 'folder', onSelect: () => setTimeout(() => moveMenu(anchor, t)) },
    { sep: true },
    { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => {
      if (!(await confirmDialog({ title: `Delete “${t.name}”?`, text: 'Its queued runs stop and it moves to the Trash. You can restore it from there for 30 days.', confirmLabel: 'Delete', danger: true }))) return;
      try { await api.del(`/tables/${t.id}`); await refreshTableList(); toast(`Moved “${t.name}” to the Trash.`); } catch (e) { toast(e.message, { error: true }); }
    } },
  ], { align: 'end' });
}

/** One text field and Save, anchored to a button. save(name) throws to keep the popover open. */
function namePopover(anchor, value, label, save) {
  popover(anchor, (el, pop) => {
    const input = h('input', { class: 'input', value, placeholder: label, 'aria-label': label });
    const go = async () => { const n = input.value.trim(); if (!n) return; try { await save(n); pop.close(); refreshTableList(); } catch (e) { toast(e.message, { error: true }); } };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    el.append(h('div', { class: 'pop-body' }, input, h('button', { class: 'btn primary', onClick: go }, 'Save')));
    setTimeout(() => { input.focus(); input.select(); });
  }, { width: 280, align: 'end' });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(iso) { if (!iso) return ''; const d = new Date(iso); return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`; }
function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)} d ago`;
  return when(iso);
}
