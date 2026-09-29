/**
 * The table toolbar, laid out like Clay's (site-teardowns/clay/teardown.md, 5.3): 28px outlined
 * buttons for Auto-run, Views, Columns, Rows, Filter, Sort and Search, then the blue Tools button.
 * Tools loads on first click: table-tools.js imports the table page, which imports this file.
 * Filters, sort and hidden columns live in ui() until saved as a view.
 */

import { h, mount, debounce } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { api } from '../api.js';
import { state, ui, changed, setting } from '../store.js';
import { OPERATORS, operatorGroup, NO_VALUE_OPS, COMPUTED } from '../logic.js';
import { menu, listbox, popover, toast, confirmDialog } from '../ui/overlay.js';

export const BUILT_IN = [['all', 'All rows'], ['errored', 'Errored rows'], ['enriched', 'Fully enriched rows']];

const tbtn = (ic, label, onClick, { on, id, title } = {}) =>
  h('button', { class: ['tbtn', on && 'on'], id, title, onClick }, ic ? icon(ic, 14) : null, label);

/** Row counts for the Rows button: shown after the row limit, of all rows in the view. */
export function renderToolbar(el, { shown, matched }) {
  const t = state.t; const u = ui();
  const saved = t.views.find((v) => String(v.id) === String(u.view));
  const viewName = saved ? saved.name : (BUILT_IN.find(([k]) => k === u.view) || BUILT_IN[0])[1];
  const hiddenN = t.columns.length - visibleCount();
  const auto = setting('auto_run', false);
  const sortCol = u.sort && t.columns.find((c) => c.key === u.sort.col);
  const search = h('input', { id: 'tsearch', placeholder: 'Search', value: u.search, 'aria-label': 'Search rows',
    onInput: debounce((e) => { u.search = e.target.value; changed(); }, 120) });

  mount(el,
    h('div', { class: 'tb-left' },
      tbtn(null, [h('span', { class: ['dot', auto ? 'on' : 'off'] }), auto ? 'Auto-run' : 'Manual'], toggleAuto,
        { title: auto ? 'Cells re-run when their inputs change or rows are added' : 'Nothing runs until you press Run' }),
      h('span', { class: 'vsep' }),
      tbtn('list', [viewName, icon('chevron-down', 12)], viewsMenu, { on: u.view !== 'all' }),
      tbtn('columns', `${t.columns.length - hiddenN}/${t.columns.length}`, columnsPopover, { on: hiddenN > 0, title: 'Show and hide columns' }),
      tbtn('rows', `${shown.toLocaleString('en-US')}/${matched.toLocaleString('en-US')}`, rowsPopover, { on: !!u.rowLimit, title: 'Row limit' }),
      tbtn('filter', u.filters.length ? `Filter · ${u.filters.length}` : 'Filter', (e) => addFilter(e.currentTarget), { on: u.filters.length > 0 }),
      tbtn('sort', sortCol ? `${sortCol.name} ${u.sort.dir === 'asc' ? 'A→Z' : 'Z→A'}` : 'Sort', sortMenu, { on: !!sortCol }),
      h('label', { class: 'tsearch tb' }, icon('search', 13), search),
      u.filters.length ? h('div', { class: 'fchips' }, u.filters.map((f, i) => filterChip(f, i))) : null),
    h('div', { class: 'tb-right' },
      h('button', { class: 'tbtn primary', onClick: () => import('./table-tools.js').then((m) => m.openTools()) }, icon('zap', 14), 'Tools')));
}

function visibleCount() {
  const t = state.t; const u = ui();
  const saved = t.views.find((v) => String(v.id) === String(u.view));
  const hidden = new Set([...(saved?.config.hidden || []), ...(u.hidden || [])]);
  return t.columns.filter((c) => !hidden.has(c.key)).length;
}

/* ---------------------------------------------------------------- auto-run */

async function toggleAuto() {
  const on = setting('auto_run', false);
  if (on && !(await confirmDialog({ title: 'Switch to manual?', text: 'New rows will not run on their own, and columns will not re-run when their inputs change. Runs already queued keep going until you stop them.', confirmLabel: 'Switch to manual' }))) return;
  if (!on && !(await confirmDialog({ title: 'Turn on auto-run?', text: 'New rows and changed inputs will queue the columns that allow auto-run, in every table. Paid columns still stop at their run budget.', confirmLabel: 'Turn on' }))) return;
  try { state.boot.settings = await api.patch('/settings', { auto_run: !on }); changed(); }
  catch (e) { toast(e.message, { error: true }); }
}

/* ---------------------------------------------------------------- views */

function viewsMenu(e) {
  const t = state.t; const u = ui();
  const saved = t.views.find((v) => String(v.id) === String(u.view));
  const pick = (k) => () => { u.view = k; u.selection.clear(); changed(); };
  const dirty = u.filters.length || u.sort || (u.hidden || []).length;
  const anchor = e.currentTarget;
  menu(anchor, [
    { group: 'Views' },
    ...BUILT_IN.map(([k, l]) => ({ label: l, checked: String(u.view) === k, onSelect: pick(k) })),
    ...(t.views.length ? [{ sep: true }, { group: 'Saved' }] : []),
    ...t.views.map((v) => ({ label: v.name, checked: String(u.view) === String(v.id), onSelect: pick(v.id) })),
    { sep: true },
    { label: dirty ? 'Save as a new view' : 'Save as a new view (add a filter, sort or hidden column first)', icon: 'plus', onSelect: () => { if (dirty) setTimeout(() => saveView(anchor)); } },
    saved ? { label: `Rename “${saved.name}”`, icon: 'pencil', onSelect: () => setTimeout(() => renameView(anchor, saved)) } : null,
    saved ? { label: `Delete “${saved.name}”`, icon: 'trash', danger: true, onSelect: () => deleteView(saved) } : null,
  ].filter(Boolean), { width: 280 });
}

function saveView(anchor) {
  namePopover(anchor, '', 'View name', async (name) => {
    const u = ui();
    const v = await api.post(`/tables/${state.t.table.id}/views`, { name, config: { filters: u.filters, sort: u.sort, hidden: u.hidden || [] } });
    state.t.views.push(v); u.filters = []; u.sort = null; u.hidden = []; u.view = v.id;
  });
}

function renameView(anchor, v) {
  namePopover(anchor, v.name, 'View name', async (name) => { await api.patch(`/views/${v.id}`, { name }); v.name = name; });
}

async function deleteView(v) {
  if (!(await confirmDialog({ title: `Delete the view “${v.name}”?`, text: 'Only the saved filters, sort and hidden columns go. No rows are deleted.', confirmLabel: 'Delete view', danger: true }))) return;
  try { await api.del(`/views/${v.id}`); state.t.views = state.t.views.filter((x) => x.id !== v.id); ui().view = 'all'; changed(); }
  catch (e) { toast(e.message, { error: true }); }
}

function namePopover(anchor, value, label, save) {
  popover(anchor, (el, pop) => {
    const input = h('input', { class: 'input', value, placeholder: label, 'aria-label': label });
    const go = async () => { const n = input.value.trim(); if (!n) return; try { await save(n); pop.close(); changed(); } catch (e) { toast(e.message, { error: true }); } };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    el.append(h('div', { class: 'pop-body' }, input, h('button', { class: 'btn primary', onClick: go }, 'Save')));
    setTimeout(() => { input.focus(); input.select(); });
  }, { width: 260 });
}

/* ---------------------------------------------------------------- columns and rows */

function columnsPopover(e) {
  const t = state.t; const u = ui();
  const saved = t.views.find((v) => String(v.id) === String(u.view));
  const byView = new Set(saved?.config.hidden || []);
  const cols = t.columns.map((c) => ({
    label: c.name, icon: typeIcon(c.type, c.kind),
    checked: !byView.has(c.key) && !(u.hidden || []).includes(c.key),
    hint: byView.has(c.key) ? 'hidden by view' : undefined,
    onSelect() {
      if (byView.has(c.key)) return;
      const hidden = new Set(u.hidden || []);
      hidden.has(c.key) ? hidden.delete(c.key) : hidden.add(c.key);
      u.hidden = [...hidden]; this.checked = !hidden.has(c.key); changed();
    },
  }));
  const showAll = { label: 'Show all columns', icon: 'eye', onSelect: () => { u.hidden = []; cols.forEach((it, i) => { it.checked = !byView.has(t.columns[i].key); }); changed(); } };
  listbox(e.currentTarget, { items: [showAll, { sep: true }, ...cols], placeholder: 'Find a column', keepOpen: true, width: 280 });
}

function rowsPopover(e) {
  const u = ui();
  popover(e.currentTarget, (el, pop) => {
    const input = h('input', { class: 'input', type: 'number', min: '1', step: '1', value: u.rowLimit || '', placeholder: 'No limit', 'aria-label': 'Row limit' });
    const apply = () => { const n = Math.floor(Number(input.value)); u.rowLimit = n > 0 ? n : null; pop.close(); changed(); };
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') apply(); });
    el.append(h('div', { class: 'pop-body stack' },
      h('b', null, 'Row limit'), h('span', { class: 'faint' }, 'Show only the first rows of this view. Leave empty for all rows.'),
      input,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onClick: apply }, 'Apply'),
        h('button', { class: 'btn', onClick: () => { u.rowLimit = null; pop.close(); changed(); } }, 'Show all rows'))));
    setTimeout(() => input.focus());
  }, { width: 280 });
}

/* ---------------------------------------------------------------- filter and sort */

export function opsFor(col) {
  const base = OPERATORS[operatorGroup(col.type)];
  return COMPUTED.includes(col.kind) ? [...base, ...OPERATORS.status] : base;
}

export function addFilter(anchor, key) {
  const add = (col) => {
    ui().filters.push({ col: col.key, op: opsFor(col)[0][0], value: '' });
    changed();
    requestAnimationFrame(() => document.querySelectorAll('.fchip')[ui().filters.length - 1]?.querySelector('.val')?.click());
  };
  if (key) return add(state.t.columns.find((c) => c.key === key));
  listbox(anchor, {
    placeholder: 'Filter by…',
    items: state.t.columns.map((c) => ({ label: c.name, icon: typeIcon(c.type, c.kind), value: c.key })),
    onPick: (it) => add(state.t.columns.find((c) => c.key === it.value)),
  });
}

function sortMenu(e) {
  const u = ui(); const anchor = e.currentTarget;
  listbox(anchor, {
    placeholder: 'Sort by…',
    items: [
      ...(u.sort ? [{ label: 'Clear sort', icon: 'x', onSelect: () => { u.sort = null; changed(); } }, { sep: true }] : []),
      ...state.t.columns.flatMap((c) => [
        { label: `${c.name}`, sub: 'A → Z', icon: typeIcon(c.type, c.kind), checked: u.sort?.col === c.key && u.sort.dir === 'asc', onSelect: () => { u.sort = { col: c.key, dir: 'asc' }; changed(); } },
        { label: `${c.name}`, sub: 'Z → A', icon: typeIcon(c.type, c.kind), checked: u.sort?.col === c.key && u.sort.dir === 'desc', onSelect: () => { u.sort = { col: c.key, dir: 'desc' }; changed(); } },
      ]),
    ],
    width: 280,
  });
}

function filterChip(f, i) {
  const u = ui();
  const col = state.t.columns.find((c) => c.key === f.col);
  if (!col) return null;
  const ops = opsFor(col);
  const opLabel = (ops.find(([k]) => k === f.op) || ops[0])[1];
  const needsValue = !NO_VALUE_OPS.includes(f.op);
  return h('div', { class: 'fchip' },
    h('button', { onClick: (e) => menu(e.currentTarget, ops.map(([k, l]) => ({ label: l, checked: k === f.op, onSelect: () => { f.op = k; changed(); } }))) },
      h('span', null, col.name), h('span', { class: 'op' }, opLabel)),
    needsValue ? h('button', { class: ['val', !f.value && 'empty'], onClick: (e) => popover(e.currentTarget, (el, pop) => {
      const input = h('input', { class: 'input', value: f.value || '', type: col.type === 'date' ? 'date' : 'text', placeholder: 'Value',
        onInput: debounce((ev) => { f.value = ev.target.value; changed(); }, 150),
        onKeydown: (ev) => { if (ev.key === 'Enter') pop.close(); } });
      el.append(h('div', { class: 'pop-body' }, input));
      setTimeout(() => input.focus());
    }, { width: 240 }) }, f.value || 'value') : null,
    h('button', { 'aria-label': 'Remove filter', onClick: () => { u.filters.splice(i, 1); changed(); } }, icon('x', 13)));
}
