/**
 * One table: the top bar, the toolbar (table-toolbar.js), the grid, the bulk bar and the keyboard.
 */

import { h, mount, isTyping } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, ui, loadTable, putRow, putColumn, dropColumn, changed, refreshTableList } from '../store.js';
import { applyFilters, searchRows, sortRows, builtInView } from '../logic.js';
import { renderToolbar } from './table-toolbar.js';
import { renderBottom } from './table-bottom.js';
import { applyCells, undo, redo, rangeBounds, clearChanges, fillChanges, setView } from './table-ops.js';
import { openRowPanel } from './table-row.js';
import { columnMenu, addColumnMenu } from './table-columns.js';
import { renderGrid, revealFocus } from '../ui/grid.js';
import { editCell } from '../ui/editor.js';
import { menu, toast, confirmDialog, hasLayer } from '../ui/overlay.js';
import { panelOpen } from '../ui/panel.js';
import { computeRow } from '../formula.js';
import { nav } from '../nav.js';
import { openFolder } from './home.js';

/**
 * Rows as the grid shows them, formula columns filled in. Cached per row object: a row is replaced
 * (not mutated) when it changes, and the cache key includes every formula, so edits invalidate it.
 */
const computedCache = new WeakMap();
export function withFormulas(rows, cols) {
  const formulas = cols.filter((c) => c.kind === 'formula');
  if (!formulas.length) return rows;
  const sig = JSON.stringify(formulas.map((c) => [c.key, c.config.formula]));
  return rows.map((r) => {
    const hit = computedCache.get(r);
    if (hit && hit.sig === sig) return hit.row;
    const row = { ...r, data: computeRow(r, cols), source: r };
    computedCache.set(r, { sig, row });
    return row;
  });
}

/** Extension points for later features (run control adds buttons and bulk actions here). */
export const tableHooks = { toolbar: [], bulk: [], columnActions: [], footer: [], afterLoad: [], afterRun: [], addRows: [] };

/** The rows the grid shows right now, in order. */
export function visibleRows() {
  const t = state.t; const u = ui();
  const saved = t.views.find((v) => String(v.id) === String(u.view));
  const cols = t.columns;
  const all = withFormulas(t.rows, cols);
  let rows = saved ? all : builtInView(u.view, all, cols, t.meta);
  const filters = saved ? [...(saved.config.filters || []), ...u.filters] : u.filters;
  rows = applyFilters(rows, filters, cols, t.meta);
  rows = searchRows(rows, u.search, cols);
  return sortRows(rows, u.sort || saved?.config.sort, cols);
}

export function visibleColumns() {
  const t = state.t; const u = ui();
  const saved = t.views.find((v) => String(v.id) === String(u.view));
  const hidden = new Set([...(saved?.config.hidden || []), ...(u.hidden || [])]);
  // Pinned columns come first, where the grid freezes them (Clay's "Pin").
  const shown = t.columns.filter((c) => !hidden.has(c.key));
  return [...shown.filter((c) => c.pinned), ...shown.filter((c) => !c.pinned)];
}

let lastDrawn = null;

export function renderTable(regions, id) {
  if (!state.t || state.t.table.id !== id) {
    mount(regions.content, h('div', { class: 'loading' }, h('div', { class: 'skel', style: { width: '40%' } })));
    loadTable(id).then(() => tableHooks.afterLoad.forEach((fn) => fn())).catch((e) => mount(regions.content, h('div', { class: 'empty' }, h('h2', null, 'Could not open this table'), h('p', null, e.message))));
    return;
  }
  const t = state.t; const u = ui();
  const cols = visibleColumns();
  const matched = visibleRows();
  const rows = u.rowLimit ? matched.slice(0, u.rowLimit) : matched;

  /* ---------- top bar: Home / folder / table, like Clay's breadcrumb */
  const listed = state.boot?.tables.find((x) => x.id === t.table.id);
  const folder = listed?.folder_id ? (state.boot.folders || []).find((f) => f.id === listed.folder_id) : null;
  mount(regions.top,
    h('div', { class: 'crumbs' }, crumbLink('/', 'Home'), h('span', { class: 'sep' }, '/'),
      folder ? [crumbLink('/', folder.name, () => openFolder(folder.id)), h('span', { class: 'sep' }, '/')] : null,
      h('span', { class: 'title' }, icon('table', 15),
        h('span', { class: 'tname', contentEditable: 'true', spellcheck: 'false', role: 'textbox', 'aria-label': 'Table name',
          onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } },
          onBlur: (e) => renameTable(e.currentTarget.textContent) }, t.table.name))),
    h('span', { class: 'grow' }),
    tableHooks.toolbar.map((fn) => fn()),
    h('button', { class: 'btn', onClick: (e) => menu(e.currentTarget, [
      { label: 'Import a CSV', icon: 'upload', onSelect: importCsv },
      ...tableHooks.addRows.map((fn) => fn(e.currentTarget)),
      { label: 'New empty row', icon: 'plus', onSelect: addRow },
    ], { width: 250 }) }, icon('plus', 15), 'Add rows', icon('chevron-down', 13)),
    h('a', { class: 'btn hide-phone', href: `/api/tables/${t.table.id}/export.csv`, download: '' }, icon('download', 15), 'Export'),
    h('button', { class: 'btn ghost icon', 'aria-label': 'Table menu', onClick: (e) => tableMenu(e.currentTarget) }, icon('more', 16)));

  /* ---------- toolbar (pages/table-toolbar.js) */
  renderToolbar(regions.toolbar, { shown: rows.length, matched: matched.length });

  /* ---------- grid */
  const sc = regions.content;
  // Read before the redraw clears it; a different table starts at the top.
  const scroll = lastDrawn === t.table.id ? { top: sc.scrollTop, left: sc.scrollLeft, height: sc.clientHeight } : { top: 0, left: 0, height: sc.clientHeight };
  lastDrawn = t.table.id;
  const wrap = h('div', { class: 'grid-wrap' });
  mount(regions.content, wrap);
  if (!t.columns.length) {
    wrap.append(h('div', { class: 'empty' }, h('h2', null, 'No columns yet'), h('button', { class: 'btn primary', onClick: (e) => addColumnMenu(e.currentTarget) }, 'Add a column')));
  } else {
    setView({ rows, cols });
    renderGrid(wrap, {
      cols, rows, meta: t.meta, ui: u, range: rangeBounds(rows, cols, u), scroll,
      onSelection: changed,
      columnMenu: (anchor, c) => columnMenu(anchor, c, {
        extra: tableHooks.columnActions.flatMap((fn) => fn(c) || []),
        onSort: (srt) => { u.sort = srt; changed(); },
        onHide: (col) => { u.hidden = [...(u.hidden || []), col.key]; changed(); },
        onDelete: deleteColumn,
      }),
      onAddColumn: (anchor) => addColumnMenu(anchor),
      onResize: async (c, w) => { try { putColumn(await api.patch(`/columns/${c.id}`, { width: w })); } catch (e) { toast(e.message, { error: true }); } },
      onFocus: (f) => { u.focus = f; u.rangeEnd = null; changed(); },
      onRange: (end) => { u.rangeEnd = end; changed(); },
      onFillTo: (rowId) => {
        const b = rangeBounds(rows, cols, u); const i = rows.findIndex((r) => r.id === rowId);
        if (!b || i < b.r0) return;   // fill runs downward only
        u.rangeEnd = { row: rowId, col: cols[b.c1].key };
        if (u.focus.col !== cols[b.c0].key || u.focus.row !== rows[b.r0].id) u.focus = { row: rows[b.r0].id, col: cols[b.c0].key };
        changed();
      },
      onFill: () => { const b = rangeBounds(rows, cols, u); if (b && b.r1 > b.r0) applyCells(fillChanges(rows, cols, b), { label: 'fill' }).catch(() => {}); },
      onExpand: (r) => openRowPanel(r.id),
      onAddRows: (n) => addRows(n),
      onWindow: changed,
      onStartEdit: (r, c) => startEdit(r, c),
      onEditCell: (r, c, v) => saveCell(r, c, v),
      onAddRow: addRow,
    });
    if (rows.length === 0 && t.rows.length > 0) wrap.append(h('div', { class: 'empty small' }, h('p', null, 'No rows match this view.')));
    if (t.rows.length === 0) {
      wrap.append(h('div', { class: 'empty small' }, h('h2', null, 'An empty table'),
        h('p', null, 'Import a CSV, paste rows in with the API, or add a row by hand.'),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onClick: importCsv }, icon('upload', 15), 'Import CSV'),
          h('button', { class: 'btn', onClick: addRow }, icon('plus', 15), 'New row'))));
    }
  }
  tableHooks.footer.forEach((fn) => fn(regions.content, rows));
  regions.bottom.hidden = false;
  renderBottom(regions.bottom, { onDelete: deleteTable });

  /* ---------- bulk bar */
  const selected = [...u.selection].filter((id) => t.rows.some((r) => r.id === id));
  if (selected.length) {
    regions.content.append(h('div', { class: 'bulkbar', role: 'toolbar', 'aria-label': 'Selected rows' },
      h('span', null, `${selected.length} selected`),
      tableHooks.bulk.map((fn) => fn(selected)),
      h('button', { class: 'btn sm danger', onClick: () => deleteRows(selected) }, icon('trash', 14), 'Delete'),
      h('button', { class: 'btn ghost icon sm', 'aria-label': 'Clear selection', onClick: () => { u.selection.clear(); changed(); } }, icon('x', 14))));
  }
  revealFocus(wrap);
}

/* ---------------------------------------------------------------- actions */

const crumbLink = (path, label, before) => h('a', { href: path, onClick: (e) => { e.preventDefault(); before?.(); nav.go(path); } }, label);

async function renameTable(name) {
  name = name.trim();
  if (!name || name === state.t.table.name) return changed();
  try { await api.patch(`/tables/${state.t.table.id}`, { name }); state.t.table.name = name; refreshTableList(); }
  catch (e) { toast(e.message, { error: true }); changed(); }
}

function tableMenu(anchor) {
  menu(anchor, [
    { label: 'Add column', icon: 'plus', onSelect: () => setTimeout(() => addColumnMenu(anchor)) },
    { label: 'Show hidden columns', icon: 'columns', onSelect: () => { ui().hidden = []; changed(); } },
    { label: 'Export as CSV', icon: 'download', onSelect: () => { location.href = `/api/tables/${state.t.table.id}/export.csv`; } },
    { sep: true },
    { label: 'Delete table', icon: 'trash', danger: true, onSelect: deleteTable },
  ]);
}

async function deleteTable() {
  const ok = await confirmDialog({ title: 'Delete this table?', text: `Queued runs on “${state.t.table.name}” stop and it moves to the Trash. You can restore it from there for 30 days.`, confirmLabel: 'Delete table', danger: true });
  if (!ok) return;
  await api.del(`/tables/${state.t.table.id}`);
  state.t = null;
  await refreshTableList();
  history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate'));
}

async function deleteColumn(c) {
  const ok = await confirmDialog({ title: `Delete “${c.name}”?`, text: 'Its values are removed from every row. This cannot be undone.', confirmLabel: 'Delete column', danger: true });
  if (!ok) return;
  try { await api.del(`/columns/${c.id}`); dropColumn(c.id); } catch (e) { toast(e.message, { error: true }); }
}

async function deleteRows(ids) {
  const ok = await confirmDialog({ title: `Delete ${ids.length} row${ids.length === 1 ? '' : 's'}?`, text: 'This cannot be undone.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api.post(`/tables/${state.t.table.id}/rows/delete`, { ids });
    const gone = new Set(ids);
    state.t.rows = state.t.rows.filter((r) => !gone.has(r.id));
    ui().selection.clear(); changed(); refreshTableList();
  } catch (e) { toast(e.message, { error: true }); }
}

async function addRow() {
  try {
    const res = await api.post(`/tables/${state.t.table.id}/rows`, { data: {} });
    const row = res.rows[0];
    putRow(row);
    const first = visibleColumns()[0];
    if (first) { ui().focus = { row: row.id, col: first.key }; ui().rangeEnd = null; ui()._reveal = true; }
    refreshTableList();
  } catch (e) { toast(e.message, { error: true }); }
}

async function addRows(n) {
  try {
    const res = await api.post(`/tables/${state.t.table.id}/rows`, { rows: Array.from({ length: n }, () => ({})) });
    res.rows.forEach((r) => state.t.rows.push(r));
    changed(); refreshTableList();
  } catch (e) { toast(e.message, { error: true }); }
}

/** One cell edit. Goes through applyCells so it can be undone like a paste. */
export async function saveCell(row, col, value) {
  const before = row.data[col.key] ?? null;
  await applyCells([{ id: row.id, key: col.key, before, after: value ?? null }], { label: 'edit' }).catch(() => {});
}

function startEdit(row, col, initial) {
  if (col.kind === 'formula') return toast('A formula column is computed. Edit the formula instead.');
  const td = document.querySelector(`td[data-r="${row.id}"][data-k="${col.key}"]`);
  if (!td) return;
  editCell(td, row, col, { rows: state.t.rows, initial, save: (v) => saveCell(row, col, v), move: (dx, dy) => moveFocus(dx, dy) });
}

const shownRows = () => { const u = ui(); const all = visibleRows(); return u.rowLimit ? all.slice(0, u.rowLimit) : all; };

/** Arrows move the focus; with shift they grow the range from the focus instead. */
function moveFocus(dx, dy, extend = false) {
  const u = ui(); const cols = visibleColumns(); const rows = shownRows();
  if (!rows.length || !cols.length) return;
  const from = extend ? (u.rangeEnd || u.focus) : u.focus;
  let ri = rows.findIndex((r) => r.id === from?.row); let ci = cols.findIndex((c) => c.key === from?.col);
  if (ri < 0 || ci < 0) { ri = 0; ci = 0; } else if (extend) {
    ri = Math.max(0, Math.min(rows.length - 1, ri + dy)); ci = Math.max(0, Math.min(cols.length - 1, ci + dx));
  } else {
    ci += dx; ri += dy;
    if (ci >= cols.length) { ci = 0; ri++; } else if (ci < 0) { ci = cols.length - 1; ri--; }
    ri = Math.max(0, Math.min(rows.length - 1, ri));
  }
  const at = { row: rows[ri].id, col: cols[ci].key };
  if (extend && u.focus) u.rangeEnd = at; else { u.focus = at; u.rangeEnd = null; }
  u._reveal = true;
  changed();
}

export function importCsv() {
  const input = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files[0]; input.remove();
    if (!file) return;
    if (file.size > 10_000_000) return toast('That file is over 10 MB. Split it first.', { error: true });
    try {
      const res = await api.post(`/tables/${state.t.table.id}/import`, await file.text());
      toast(`Imported ${res.added.toLocaleString('en-US')} rows` + (res.created_columns.length ? `, new columns: ${res.created_columns.join(', ')}` : ''));
      await loadTable(state.t.table.id); refreshTableList();
    } catch (e) { toast(e.message, { error: true }); }
  });
  document.body.append(input); input.click();
}

/* ---------------------------------------------------------------- keyboard */

export function tableKeys(e) {
  if (!state.t || isTyping(e) || hasLayer()) return false;
  const u = ui();
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
    e.preventDefault();
    if (e.key === 'y' || e.shiftKey) redo(); else undo();
    return true;
  }
  if (mod || e.altKey) return false;
  const moves = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], Tab: [e.shiftKey ? -1 : 1, 0] };
  if (moves[e.key]) {
    if (!u.focus && e.key === 'Tab') return false;
    e.preventDefault(); moveFocus(...moves[e.key], e.shiftKey && e.key !== 'Tab'); return true;
  }
  if (!u.focus) return false;
  const row = state.t.rows.find((r) => r.id === u.focus.row);
  const col = state.t.columns.find((c) => c.key === u.focus.col);
  if (!row || !col) return false;
  if (e.key === 'Escape' && !panelOpen()) { if (u.rangeEnd) u.rangeEnd = null; else u.focus = null; changed(); return true; }
  if (e.key === 'Enter') { e.preventDefault(); startEdit(row, col); return true; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    const rows = shownRows(); const cols = visibleColumns();
    const b = rangeBounds(rows, cols, u);
    if (b) applyCells(clearChanges(rows, cols, b), { label: 'clear' }).catch(() => {});
    return true;
  }
  if (e.key === ' ' && col.type === 'checkbox' && col.kind === 'data') { e.preventDefault(); saveCell(row, col, !row.data[col.key]); return true; }
  if (e.key.length === 1 && !['select', 'multi_select', 'checkbox'].includes(col.type)) { e.preventDefault(); startEdit(row, col, e.key); return true; }
  return false;
}
