/** Exports (LOAM-PLAN.md phase 11; Clay's Exports page): every CSV download of the last 30 days. */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { changed } from '../store.js';
import { nav } from '../nav.js';
import { toast } from '../ui/overlay.js';

let data = null; let loading = false;

async function load() {
  loading = true;
  try { data = await api.get('/exports'); } catch (e) { toast(e.message, { error: true }); data = { days: 30, exports: [] }; }
  loading = false; changed();
}

const size = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);

export function renderExports(regions) {
  mount(regions.top, h('div', { class: 'crumbs' }, h('b', null, 'Exports')));
  if (!data && !loading) load();
  const list = data?.exports || [];
  mount(regions.content, h('div', { class: 'home' },
    h('section', { class: 'files' },
      h('div', { class: 'files-head' }, h('span', { class: 'files-ic' }, icon('download', 18)), h('h2', null, 'Exports')),
      h('p', { class: 'faint trash-note' }, `Every CSV you download stays here for ${data?.days ?? 30} days, so you can get the same file again. Files over 1.5 MB are listed and re-made from the table as it is now.`),
      list.length ? h('table', { class: 'files-table' },
        h('thead', null, h('tr', null, h('th', null, 'File'), h('th', null, 'Table'), h('th', { class: 'num' }, 'Rows'), h('th', { class: 'num' }, 'Size'), h('th', null, 'Made'), h('th', { class: 'c-actions' }))),
        h('tbody', null, list.map((e) => h('tr', { class: 'no-open' },
          h('td', null, h('span', { class: 'fname' }, icon('file-text', 15), h('span', { class: 'ellipsis' }, e.name))),
          h('td', null, e.table_id && !e.table_deleted ? h('a', { href: `/t/${e.table_id}`, onClick: (ev) => { ev.preventDefault(); nav.go(`/t/${e.table_id}`); } }, e.table_name) : h('span', { class: 'faint' }, 'deleted')),
          h('td', { class: 'num' }, e.rows.toLocaleString('en-US')),
          h('td', { class: 'num' }, size(e.bytes)),
          h('td', { class: 'faint' }, new Date(e.created_at).toLocaleString()),
          h('td', { class: 'c-actions' }, h('div', { class: 'row' },
            h('a', { class: 'btn sm', href: `/api/exports/${e.id}/download`, title: e.kept ? 'The file as it was' : 'Too big to keep: made again from the table now' }, icon('download', 13), e.kept ? 'Download' : 'Download (current)'),
            h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove from the list', onClick: async () => { await api.del(`/exports/${e.id}`); load(); } }, icon('x', 13)))))))) :
        h('div', { class: 'files-empty' }, loading ? 'Loading…' : 'No exports yet. Download a table from its Tools, Exports tab.'))));
}

export function leaveExports() { data = null; }
