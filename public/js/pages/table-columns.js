/**
 * The column header menu and the Add column menu, laid out like Clay's
 * (site-teardowns/clay/teardown.md, 5.5 and 5.6).
 */

import { h } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { api } from '../api.js';
import { state, ui, putColumn, loadTable, refreshTableList } from '../store.js';
import { TYPES } from '../types.js';
import { columnRefs } from '../template.js';
import { menu, popover, toast, confirmDialog } from '../ui/overlay.js';
import { openColumnPanel } from '../ui/column-panel.js';
import { addFilter } from './table-toolbar.js';

const COLORS = ['blue', 'violet', 'green', 'amber', 'red', 'pink', 'teal', 'gray'];

/** Index in the table's own column order, for Insert left / right. */
const posOf = (c) => state.t.columns.findIndex((x) => x.id === c.id);

async function patch(c, body) {
  try { putColumn(await api.patch(`/columns/${c.id}`, body)); }
  catch (e) { toast(e.message, { error: true }); }
}

/** o: {onSort, onHide, onDelete, extra: [items]} from the table page. */
export function columnMenu(anchor, c, o) {
  const users = state.t.columns.filter((x) => x.id !== c.id && columnRefs(x).has(c.key));
  const sorted = ui().sort?.col === c.key ? ui().sort.dir : null;
  menu(anchor, [
    { label: 'Rename', icon: 'pencil', onSelect: () => setTimeout(() => textPopover(anchor, c.name, 'Column name', (v) => patch(c, { name: v }))) },
    { label: 'Edit column', icon: 'sliders', onSelect: () => openColumnPanel(c) },
    ...(o.extra || []),
    { sep: true },
    { label: 'Insert 1 column left', icon: 'arrow-left', onSelect: () => setTimeout(() => addColumnMenu(anchor, { position: posOf(c) })) },
    { label: 'Insert 1 column right', icon: 'arrow-right', onSelect: () => setTimeout(() => addColumnMenu(anchor, { position: posOf(c) + 1 })) },
    { label: c.description ? 'Edit description' : 'Add description', icon: 'file-text', onSelect: () => setTimeout(() => textPopover(anchor, c.description || '', 'What this column holds', (v) => patch(c, { description: v }), { multiline: true, allowEmpty: true })) },
    { label: 'Change color', icon: 'sparkle', onSelect: () => setTimeout(() => colorPicker(anchor, c)) },
    { group: `Type: ${TYPES[c.type] || c.type}` },
    { label: users.length ? `Used in ${users.length} column${users.length === 1 ? '' : 's'}` : 'Used in no other column', icon: 'link', onSelect: () => { if (users.length) setTimeout(() => usedIn(anchor, users)); } },
    { label: 'Duplicate', icon: 'layers', onSelect: () => duplicate(c) },
    { sep: true },
    { label: 'Sort A → Z', icon: 'arrow-up', checked: sorted === 'asc', onSelect: () => o.onSort({ col: c.key, dir: 'asc' }) },
    { label: 'Sort Z → A', icon: 'arrow-down', checked: sorted === 'desc', onSelect: () => o.onSort({ col: c.key, dir: 'desc' }) },
    sorted ? { label: 'Clear sort', icon: 'x', onSelect: () => o.onSort(null) } : null,
    c.kind !== 'formula' ? { label: 'Dedupe on this column', icon: 'filter', onSelect: () => dedupe(c) } : null,
    { label: 'Filter on this column', icon: 'filter', onSelect: () => addFilter(anchor, c.key) },
    { label: c.pinned ? 'Unpin' : 'Pin to the left', icon: 'columns', onSelect: () => patch(c, { pinned: !c.pinned }) },
    { label: 'Hide from this view', icon: 'eye-off', onSelect: () => o.onHide(c) },
    { sep: true },
    { label: 'Delete column', icon: 'trash', danger: true, onSelect: () => o.onDelete(c) },
  ].filter(Boolean), { width: 250 });
}

function textPopover(anchor, value, label, save, { multiline = false, allowEmpty = false } = {}) {
  popover(anchor, (el, pop) => {
    const input = multiline
      ? h('textarea', { class: 'input', rows: 3, placeholder: label, 'aria-label': label, style: { minHeight: '72px' } }, value)
      : h('input', { class: 'input', value, placeholder: label, 'aria-label': label });
    const go = async () => { const v = input.value.trim(); if (!v && !allowEmpty) return; await save(v || null); pop.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); go(); } });
    el.append(h('div', { class: 'pop-body' }, input, h('button', { class: 'btn primary', onClick: go }, 'Save')));
    setTimeout(() => { input.focus(); if (!multiline) input.select(); });
  }, { width: 280 });
}

function colorPicker(anchor, c) {
  popover(anchor, (el, pop) => {
    el.append(h('div', { class: 'pop-body' },
      h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Column color' },
        COLORS.map((k) => h('button', { class: ['swatch', c.color === k && 'on'], 'data-c': k, role: 'radio', 'aria-checked': c.color === k ? 'true' : 'false', 'aria-label': k, title: k,
          onClick: () => { patch(c, { color: k }); pop.close(); } })),
        h('button', { class: ['swatch', 'none', !c.color && 'on'], role: 'radio', 'aria-checked': c.color ? 'false' : 'true', 'aria-label': 'No color', title: 'No color',
          onClick: () => { patch(c, { color: null }); pop.close(); } }, icon('x', 12)))));
  }, { width: 220 });
}

function usedIn(anchor, users) {
  menu(anchor, [{ group: 'These columns read it' }, ...users.map((u) => ({ label: u.name, icon: typeIcon(u.type, u.kind), onSelect: () => openColumnPanel(u) }))], { width: 260 });
}

async function duplicate(c) {
  try { await api.post(`/columns/${c.id}/duplicate`); await loadTable(state.t.table.id); toast(`Duplicated “${c.name}”.${c.kind === 'data' ? '' : ' The copy has not run yet.'}`); }
  catch (e) { toast(e.message, { error: true }); }
}

async function dedupe(c) {
  if (!(await confirmDialog({ title: `Remove duplicate rows by “${c.name}”?`, text: 'For each value, the oldest row stays and later rows with the same value are deleted. Case and spaces are ignored; empty cells are never duplicates. This cannot be undone.', confirmLabel: 'Remove duplicates', danger: true }))) return;
  try {
    const r = await api.post(`/tables/${state.t.table.id}/dedupe`, { key: c.key });
    toast(r.removed ? `Removed ${r.removed.toLocaleString('en-US')} duplicate row${r.removed === 1 ? '' : 's'}.` : 'No duplicates found.');
    if (r.removed) { await loadTable(state.t.table.id); refreshTableList(); }
  } catch (e) { toast(e.message, { error: true }); }
}

/* ---------------------------------------------------------------- Add column (Clay 5.6) */

/** position: where the column goes in the table's order; omitted = last. */
export function addColumnMenu(anchor, { position } = {}) {
  const p = (preset) => () => openColumnPanel(null, { preset: { ...preset, position } });
  const text = state.t.columns.filter((c) => c.kind !== 'formula' && ['text', 'url', 'email'].includes(c.type)).slice(0, 2);
  const merge = text.length === 2 ? `{{${text[0].key}}} & " " & {{${text[1].key}}}` : '';
  menu(anchor, [
    { group: 'Smart' },
    { label: 'Add enrichment', icon: 'zap', onSelect: p({ kind: 'enrich' }) },
    { label: 'Use AI', icon: 'sparkle', onSelect: p({ kind: 'ai' }) },
    { label: 'Waterfall', icon: 'layers', onSelect: p({ kind: 'waterfall' }) },
    { label: 'Formula', icon: 'fx', onSelect: p({ kind: 'formula' }) },
    { label: 'HTTP API', icon: 'code', onSelect: p({ kind: 'http' }) },
    { label: 'Merge columns', icon: 'braces', onSelect: p({ kind: 'formula', name: 'Merged', config: { formula: merge } }) },
    { group: 'Data types' },
    ...['text', 'number', 'currency', 'date', 'url', 'email'].map((t) => ({ label: TYPES[t], icon: typeIcon(t, 'data'), onSelect: p({ kind: 'data', type: t, name: TYPES[t] }) })),
    { group: 'Choice' },
    ...['checkbox', 'select', 'multi_select'].map((t) => ({ label: TYPES[t], icon: typeIcon(t, 'data'), onSelect: p({ kind: 'data', type: t, name: TYPES[t] }) })),
  ], { width: 240 });
}

