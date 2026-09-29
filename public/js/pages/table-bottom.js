/**
 * The bottom bar under a table, like Clay's (site-teardowns/clay/teardown.md, 5.1 and 5.4).
 * Left: one tab per table in the same folder (a folder is Free Clay's workbook) and "+ Add".
 * Right: run status and Stop (features/run.js), spend (features/spend.js), History, Table settings.
 */

import { h, mount } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { api } from '../api.js';
import { state, changed, loadTable, refreshTableList } from '../store.js';
import { nav } from '../nav.js';
import { menu, listbox, toast, confirmDialog } from '../ui/overlay.js';
import { openPanel } from '../ui/panel.js';

/** Features add status chips ({() => node}) and History menu items ({() => [items]}) here. */
export const bottomHooks = { status: [], history: [] };

export function renderBottom(el, { onDelete }) {
  const t = state.t;
  const tables = state.boot?.tables || [];
  const me = tables.find((x) => x.id === t.table.id);
  const folderId = me?.folder_id || null;
  const tabs = folderId ? tables.filter((x) => x.folder_id === folderId) : [me || { id: t.table.id, name: t.table.name }];
  const status = bottomHooks.status.map((fn) => fn()).filter(Boolean);

  mount(el,
    h('div', { class: 'bb-tabs', role: 'tablist', 'aria-label': 'Tables in this folder' },
      tabs.map((x) => {
        const on = x.id === t.table.id;
        return h('div', { class: ['bb-tab', on && 'on'], role: 'tab', 'aria-selected': on ? 'true' : 'false' },
          h('a', { href: `/t/${x.id}`, onClick: (e) => { e.preventDefault(); if (!on) nav.go(`/t/${x.id}`); } }, icon('table', 13), h('span', { class: 'ellipsis' }, x.name)),
          on ? h('button', { class: 'bb-tab-menu', 'aria-label': `Menu for ${x.name}`, onClick: (e) => menu(e.currentTarget, [
            { label: 'Rename', icon: 'pencil', onSelect: () => focusName() },
            { label: 'Table settings', icon: 'sliders', onSelect: openSettings },
            { sep: true },
            { label: 'Delete table', icon: 'trash', danger: true, onSelect: onDelete },
          ], { align: 'start' }) }, icon('chevron-up', 12)) : null);
      }),
      h('button', { class: 'bb-add', onClick: () => addTable(folderId), title: folderId ? 'New table in this folder' : 'New table' }, icon('plus', 13), 'Add')),
    h('span', { class: 'grow' }),
    h('div', { class: 'bb-right' },
      status.length ? status : h('span', { class: 'bb-status' }, icon('check', 13), 'Table up to date'),
      h('button', { class: 'tbtn', onClick: historyMenu }, icon('clock', 13), 'History', icon('chevron-up', 12)),
      h('button', { class: 'tbtn icon', 'aria-label': 'Table settings', title: 'Table settings', onClick: openSettings }, icon('sliders', 14))));
}

function focusName() {
  const el = document.querySelector('.tname');
  if (!el) return;
  el.focus();
  const r = document.createRange(); r.selectNodeContents(el);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

async function addTable(folderId) {
  try {
    const t = await api.post('/tables', { name: 'Untitled table' });
    if (folderId) await api.patch(`/tables/${t.id}`, { folder_id: folderId });
    await refreshTableList();
    nav.go(`/t/${t.id}`);
  } catch (e) { toast(e.message, { error: true }); }
}

function historyMenu(e) {
  const anchor = e.currentTarget;
  menu(anchor, [
    ...bottomHooks.history.flatMap((fn) => fn() || []),
    { sep: true },
    { label: 'Deduplicate rows…', icon: 'layers', onSelect: () => setTimeout(() => dedupeNow(anchor)) },
  ], { width: 300, align: 'end' });
}

/** Pick a column, confirm, remove repeats. The oldest row for each value stays. */
function dedupeNow(anchor) {
  const cols = state.t.columns.filter((c) => c.kind !== 'formula');
  listbox(anchor, {
    placeholder: 'Deduplicate on which column?',
    items: cols.map((c) => ({ label: c.name, icon: typeIcon(c.type, c.kind), value: c.key })),
    align: 'end',
    onPick: async (it) => {
      if (!(await confirmDialog({ title: `Remove duplicate rows by “${it.label}”?`, text: 'For each value, the oldest row stays and later rows with the same value are deleted. Case and spaces are ignored; empty cells are never duplicates. This cannot be undone.', confirmLabel: 'Remove duplicates', danger: true }))) return;
      try {
        const r = await api.post(`/tables/${state.t.table.id}/dedupe`, { key: it.value });
        toast(r.removed ? `Removed ${r.removed.toLocaleString('en-US')} duplicate row${r.removed === 1 ? '' : 's'}.` : 'No duplicates found.');
        if (r.removed) { await loadTable(state.t.table.id); refreshTableList(); }
      } catch (err) { toast(err.message, { error: true }); }
    },
  });
}

/* ---------------------------------------------------------------- table settings */

export function openSettings() {
  const t = state.t;
  openPanel({
    title: 'Table settings', width: 460,
    body: (el) => {
      const name = h('input', { class: 'input', id: 'ts-name', value: t.table.name, maxLength: 80 });
      const desc = h('textarea', { class: 'input', id: 'ts-desc', rows: 3, style: { minHeight: '72px', resize: 'vertical' }, maxLength: 500, placeholder: 'What this table holds, for you and for AI tools that read it' }, t.table.description || '');
      const dedupe = h('select', { class: 'input', id: 'ts-dedupe' },
        h('option', { value: '' }, 'Off'),
        t.columns.filter((c) => c.kind !== 'formula').map((c) => h('option', { value: c.key, selected: c.key === t.table.dedupe_key }, c.name)));
      const save = async () => {
        const body = { name: name.value.trim(), description: desc.value, dedupe_key: dedupe.value || null };
        if (!body.name) return toast('A table needs a name', { error: true });
        try {
          const r = await api.patch(`/tables/${t.table.id}`, body);
          if (r.removed) toast(`Auto-dedupe removed ${r.removed.toLocaleString('en-US')} duplicate row${r.removed === 1 ? '' : 's'}.`);
          await loadTable(t.table.id); await refreshTableList(); changed();
          toast('Saved.');
        } catch (e) { toast(e.message, { error: true }); }
      };
      el.append(
        h('label', { class: 'label', for: 'ts-name' }, 'Name'), name,
        h('label', { class: 'label', for: 'ts-desc' }, 'Description'), desc,
        h('label', { class: 'label', for: 'ts-dedupe' }, 'Auto-dedupe'),
        h('p', { class: 'faint', style: { margin: '0 0 6px' } }, 'Keep one row per value in this column. New rows that repeat a value already in the table are removed as they arrive, from CSV, the webhook, Google Maps or by hand. Turning it on also cleans the rows already here.'),
        dedupe,
        h('label', { class: 'label' }, 'Runs'),
        h('p', { class: 'faint', style: { margin: 0 } }, 'Auto-run is the toolbar switch and applies to every table. Each run still stops at its own budget.'),
        h('div', { class: 'row', style: { marginTop: '16px' } }, h('button', { class: 'btn primary', onClick: save }, 'Save changes')));
    },
  });
}
