/** Trash: deleted tables, restorable until the cron purges them (src/files.js, TRASH_DAYS). */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { refreshTableList, changed } from '../store.js';
import { nav } from '../nav.js';
import { toast, confirmDialog } from '../ui/overlay.js';

let data = null; let loading = false;

async function load() {
  loading = true;
  try { data = await api.get('/trash'); }
  catch (e) { toast(e.message, { error: true }); data = { days: 30, tables: [] }; }
  loading = false; changed();
}

function daysLeft(iso, days) {
  const left = Math.ceil((Date.parse(iso) + days * 86400_000 - Date.now()) / 86400_000);
  return left <= 1 ? 'Deleted for good within a day' : `${left} days left`;
}

async function restore(t) {
  try {
    await api.post(`/trash/${t.id}/restore`);
    await refreshTableList(); await load();
    toast(`Restored “${t.name}”.`);
  } catch (e) { toast(e.message, { error: true }); }
}

async function purge(t) {
  if (!(await confirmDialog({ title: `Delete “${t.name}” forever?`, text: 'Its rows and columns are removed for good. What it cost stays in your spend report.', confirmLabel: 'Delete forever', danger: true }))) return;
  try { await api.del(`/trash/${t.id}`); await load(); }
  catch (e) { toast(e.message, { error: true }); }
}

export function renderTrash(regions) {
  mount(regions.top, h('div', { class: 'crumbs' }, h('a', { href: '/', onClick: (e) => { e.preventDefault(); nav.go('/'); } }, 'Home'), h('span', { class: 'sep' }, '/'), h('b', null, 'Trash')));
  mount(regions.toolbar);
  if (!data && !loading) load();
  const list = data?.tables || [];
  mount(regions.content, h('div', { class: 'home' },
    h('section', { class: 'files' },
      h('div', { class: 'files-head' }, h('span', { class: 'files-ic' }, icon('trash', 18)), h('h2', null, 'Trash')),
      h('p', { class: 'faint trash-note' }, `Deleted tables stay here for ${data?.days ?? 30} days, then they are removed for good.`),
      !data ? h('div', { class: 'files-empty' }, 'Loading…') : list.length ? h('table', { class: 'files-table trash-table' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Name'), h('th', { class: 'num', scope: 'col' }, 'Rows'), h('th', { scope: 'col' }, 'Removal'), h('th', { class: 'c-actions' }))),
        h('tbody', null, list.map((t) => h('tr', { class: 'no-open' },
          h('td', null, h('span', { class: 'fname' }, icon('table', 15), h('span', { class: 'ellipsis' }, t.name))),
          h('td', { class: 'num' }, (t.row_count || 0).toLocaleString('en-US')),
          h('td', { class: 'faint' }, daysLeft(t.deleted_at, data.days)),
          h('td', { class: 'c-actions' }, h('div', { class: 'row' },
            h('button', { class: 'btn sm', onClick: () => restore(t) }, icon('restore', 14), 'Restore'),
            h('button', { class: 'btn ghost sm danger', onClick: () => purge(t) }, 'Delete forever'))))))) :
        h('div', { class: 'files-empty' }, 'The trash is empty.'))));
}

/** Leaving the page drops the cached list, so the next visit shows fresh data. */
export function leaveTrash() { data = null; }
