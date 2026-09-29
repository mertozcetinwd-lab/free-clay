/**
 * Audiences: the People and Companies databases (LOAM-PLAN.md phase 7; Clay's Audiences,
 * site-teardowns/clay/teardown-v2.md section 4). A searchable, filterable list with segments,
 * "Add data" from a table or a CSV, "Send to table", and a side panel per record showing where
 * each value came from.
 */

import { h, mount, debounce } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, changed } from '../store.js';
import { nav } from '../nav.js';
import { toast, confirmDialog, menu, modal, popover } from '../ui/overlay.js';
import { openPanel } from '../ui/panel.js';
import { FIELDS, KINDS, AUD_OPS, AUD_NO_VALUE, fieldLabel, guessMap } from '../audience-fields.js';
import { displayText } from '../types.js';

const PAGE = 100;
/** The columns the list shows; every field is in the record panel. */
const LIST_COLS = {
  people: ['full_name', 'email', 'title', 'company', 'phone', 'city', 'state'],
  companies: ['name', 'domain', 'industry', 'employees', 'phone', 'city', 'state'],
};

const views = {
  people: { q: '', filters: [], segment: null, sort: null, dir: 'desc', offset: 0, data: null, busy: false, sel: new Set(), key: '' },
  companies: { q: '', filters: [], segment: null, sort: null, dir: 'desc', offset: 0, data: null, busy: false, sel: new Set(), key: '' },
};
let segments = null; let stats = null;

const typeOf = (kind, key) => FIELDS[kind].find((f) => f[0] === key)?.[2] || 'text';

function query(v) {
  const p = new URLSearchParams({ limit: String(PAGE), offset: String(v.offset), dir: v.dir });
  if (v.q) p.set('q', v.q);
  if (v.filters.length) p.set('filters', JSON.stringify(v.filters));
  if (v.segment) p.set('segment', String(v.segment));
  if (v.sort) p.set('sort', v.sort);
  return p.toString();
}

async function load(kind, { keepSel = false } = {}) {
  const v = views[kind];
  const key = query(v);
  v.busy = true; v.key = key; changed();
  try {
    const [data, segs, st] = await Promise.all([api.get(`/audiences/${kind}?${key}`), segments ? segments : api.get('/segments'), api.get('/audiences/stats')]);
    if (v.key !== key) return;
    v.data = data; segments = segs; stats = st;
    if (!keepSel) v.sel = new Set();
  } catch (e) { toast(e.message, { error: true }); v.data = v.data || { total: 0, records: [] }; }
  v.busy = false; changed();
}

const reload = (kind) => { views[kind].offset = 0; load(kind); };
const refreshSegments = async () => { segments = await api.get('/segments'); changed(); };

export function renderAudience(regions, kind) {
  const v = views[kind];
  mount(regions.top, h('div', { class: 'crumbs' }, h('span', { class: 'faint' }, 'Audiences'), h('span', { class: 'sep' }, '/'), h('b', null, KINDS[kind])));
  mount(regions.toolbar);
  if (!v.data && !v.busy) load(kind);
  const recs = v.data?.records || [];
  const total = v.data?.total ?? 0;
  const mySegs = (segments || []).filter((s) => s.kind === kind);
  const st = stats?.[kind];
  const cols = LIST_COLS[kind];

  const search = h('input', { class: 'input', type: 'search', id: `aud-q-${kind}`, placeholder: `Search ${KINDS[kind].toLowerCase()}`, value: v.q, style: { width: '240px' },
    onInput: debounce((e) => { v.q = e.target.value.trim(); reload(kind); }, 300) });

  const tab = (label, segId, count) => h('button', { class: ['seg', v.segment === segId && 'on'], onClick: () => { v.segment = segId; reload(kind); } },
    label, count !== undefined && count !== null ? h('span', { class: 'faint', style: { marginLeft: '6px' } }, count.toLocaleString('en-US')) : null);

  const allSel = recs.length > 0 && recs.every((r) => v.sel.has(r.id));
  const head = h('tr', null,
    h('th', { class: 'c-pick' }, h('input', { type: 'checkbox', 'aria-label': 'Select this page', checked: allSel,
      onChange: (e) => { for (const r of recs) e.target.checked ? v.sel.add(r.id) : v.sel.delete(r.id); changed(); } })),
    cols.map((k) => h('th', { scope: 'col', class: typeOf(kind, k) === 'number' ? 'num' : null },
      h('button', { class: 'th-sort', onClick: () => { if (v.sort === k) v.dir = v.dir === 'asc' ? 'desc' : 'asc'; else { v.sort = k; v.dir = 'asc'; } reload(kind); } },
        fieldLabel(kind, k), v.sort === k ? icon(v.dir === 'asc' ? 'arrow-up' : 'arrow-down', 12) : null))));

  const body = recs.map((r) => h('tr', { onClick: (e) => { if (!e.target.closest('input, a, button')) openRecord(kind, r); } },
    h('td', { class: 'c-pick' }, h('input', { type: 'checkbox', 'aria-label': 'Select', checked: v.sel.has(r.id), onChange: (e) => { e.target.checked ? v.sel.add(r.id) : v.sel.delete(r.id); changed(); } })),
    cols.map((k) => h('td', { class: typeOf(kind, k) === 'number' ? 'num' : null, style: { maxWidth: '260px' } },
      h('span', { class: 'ellipsis', style: { display: 'block' } }, cellText(kind, k, r.data[k]))))));

  mount(regions.content, h('div', { class: 'home aud' },
    h('div', { class: 'find-head' },
      h('span', { class: 'files-ic' }, icon(kind === 'people' ? 'users' : 'building', 18)),
      h('h1', null, KINDS[kind]),
      h('span', { class: 'faint' }, st ? `${st.total.toLocaleString('en-US')} ${kind === 'people' ? (st.total === 1 ? 'person' : 'people') : (st.total === 1 ? 'company' : 'companies')}` : ''),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onClick: (e) => addData(e.currentTarget, kind) }, icon('plus', 14), 'Add data'),
      h('button', { class: 'btn primary', disabled: !total, onClick: () => sendToTable(kind) }, icon('table', 14), v.sel.size ? `Send ${v.sel.size} to a table` : 'Send to a table')),
    st && st.total ? h('div', { class: 'aud-cover' }, coverage(kind, st)) : null,
    h('div', { class: 'seg-tabs aud-tabs', role: 'tablist' }, tab('All', null, st?.total), mySegs.map((s) => tab(s.name, s.id, s.count)),
      h('button', { class: 'seg', title: 'Save these filters as a segment', disabled: !v.filters.length, onClick: () => saveSegment(kind) }, icon('plus', 13), 'Segment')),
    h('div', { class: 'files-bar aud-bar' },
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, search,
        h('button', { class: 'btn', onClick: (e) => filterPop(e.currentTarget, kind) }, icon('filter', 14), 'Filter'),
        v.segment ? h('button', { class: 'btn ghost sm', onClick: (e) => segmentMenu(e.currentTarget, kind, v.segment) }, icon('more', 14), 'Segment') : null,
        v.sel.size ? h('button', { class: 'btn ghost sm danger', onClick: () => removeSelected(kind) }, icon('trash', 13), `Delete ${v.sel.size}`) : null),
      h('div', { class: 'row faint' }, v.busy ? 'Loading…' : total ? `${(v.offset + 1).toLocaleString('en-US')}–${Math.min(v.offset + PAGE, total).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}` : '',
        h('button', { class: 'btn ghost icon sm', 'aria-label': 'Previous page', disabled: v.offset === 0, onClick: () => { v.offset = Math.max(0, v.offset - PAGE); load(kind); } }, icon('chevron-left', 14)),
        h('button', { class: 'btn ghost icon sm', 'aria-label': 'Next page', disabled: v.offset + PAGE >= total, onClick: () => { v.offset += PAGE; load(kind); } }, icon('chevron-right', 14)))),
    v.filters.length ? h('div', { class: 'fchips', style: { margin: '0 0 10px' } }, v.filters.map((f, i) => h('div', { class: 'fchip' },
      h('button', { onClick: (e) => filterPop(e.currentTarget, kind, i) }, fieldLabel(kind, f.field), h('span', { class: 'op' }, AUD_OPS[f.op]), AUD_NO_VALUE.includes(f.op) ? null : h('span', { class: 'val' }, f.value)),
      h('button', { 'aria-label': 'Remove filter', onClick: () => { v.filters.splice(i, 1); reload(kind); } }, icon('x', 12))))) : null,
    recs.length ? h('div', { class: 'find-table-wrap' }, h('table', { class: 'files-table find-table aud-table' }, h('thead', null, head), h('tbody', null, body)))
      : h('div', { class: 'files-empty' }, v.busy ? 'Loading…' : emptyText(kind, v))));
}

function cellText(kind, k, val) {
  if (val === undefined || val === null) return '';
  return displayText(typeOf(kind, k), val);
}

function emptyText(kind, v) {
  if (v.q || v.filters.length || v.segment) return 'Nothing matches. Clear a filter or search for something else.';
  return kind === 'people'
    ? 'No people yet. Add data from a table (a CSV import, a Find leads search) or upload a CSV. People with the same email become one record.'
    : 'No companies yet. Add data from a table or a CSV, or save a Find leads search here. Companies with the same domain become one record.';
}

function coverage(kind, st) {
  const pick = kind === 'people' ? ['email', 'phone', 'title', 'company'] : ['domain', 'phone', 'industry', 'employees'];
  return pick.map((k) => {
    const pct = st.total ? Math.round((st.filled[k] / st.total) * 100) : 0;
    return h('div', { class: 'aud-cov', title: `${st.filled[k].toLocaleString('en-US')} of ${st.total.toLocaleString('en-US')} have ${fieldLabel(kind, k).toLowerCase()}` },
      h('span', { class: 'faint' }, fieldLabel(kind, k)), h('div', { class: 'aud-bar-track' }, h('i', { style: { width: `${pct}%` } })), h('b', null, `${pct}%`));
  });
}

/* ---------------------------------------------------------------- filters and segments */

function filterPop(anchor, kind, index) {
  const v = views[kind];
  const cur = index !== undefined ? v.filters[index] : { field: FIELDS[kind][0][0], op: 'contains', value: '' };
  popover(anchor, (el, pop) => {
    const field = h('select', { class: 'input', 'aria-label': 'Field' }, FIELDS[kind].map(([k, label]) => h('option', { value: k, selected: k === cur.field }, label)));
    const op = h('select', { class: 'input', 'aria-label': 'Condition' }, Object.entries(AUD_OPS).map(([k, label]) => h('option', { value: k, selected: k === cur.op }, label)));
    const val = h('input', { class: 'input', placeholder: 'Value', value: cur.value || '', 'aria-label': 'Value' });
    const sync = () => { val.hidden = AUD_NO_VALUE.includes(op.value); };
    op.addEventListener('change', sync); sync();
    const apply = () => {
      const f = { field: field.value, op: op.value, ...(AUD_NO_VALUE.includes(op.value) ? {} : { value: val.value.trim() }) };
      if (!AUD_NO_VALUE.includes(f.op) && !f.value) return val.focus();
      if (index !== undefined) v.filters[index] = f; else v.filters.push(f);
      pop.close(); reload(kind);
    };
    val.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });
    el.append(h('div', { class: 'stack', style: { padding: '10px', gap: '8px', width: '280px' } }, field, op, val,
      h('div', { class: 'row' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary sm', onClick: apply }, index !== undefined ? 'Update' : 'Add filter'))));
    requestAnimationFrame(() => (val.hidden ? field : val).focus());
  }, { width: 300 });
}

async function saveSegment(kind) {
  const v = views[kind];
  modal({
    title: 'Save as a segment', width: 420,
    body: (b) => b.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'A segment is a saved filter. It re-runs every time you open it, so new records that match show up on their own.'),
      h('input', { class: 'input', id: 'seg-name', placeholder: kind === 'people' ? 'Owners in Florida' : 'Roofers with a website', style: { width: '100%' } })),
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: async () => {
        try {
          const s = await api.post('/segments', { kind, name: document.getElementById('seg-name').value, filters: v.filters });
          m.close(); v.filters = []; v.segment = s.id; segments = null; await refreshSegments(); reload(kind);
        } catch (e) { toast(e.message, { error: true }); }
      } }, 'Save segment')),
  });
}

function segmentMenu(anchor, kind, id) {
  const s = (segments || []).find((x) => x.id === id);
  if (!s) return;
  menu(anchor, [
    { group: s.name },
    { label: 'Rename', icon: 'pencil', onSelect: () => setTimeout(() => renameSegment(kind, s)) },
    ...(views[kind].filters.length ? [{ label: 'Add current filters to it', icon: 'filter', onSelect: async () => {
      try { await api.patch(`/segments/${id}`, { filters: [...s.filters, ...views[kind].filters] }); views[kind].filters = []; await refreshSegments(); reload(kind); }
      catch (e) { toast(e.message, { error: true }); }
    } }] : []),
    { sep: true },
    { label: 'Delete segment', icon: 'trash', danger: true, onSelect: async () => {
      if (!(await confirmDialog({ title: `Delete “${s.name}”?`, text: 'Only the saved filter goes. The records stay.', confirmLabel: 'Delete', danger: true }))) return;
      await api.del(`/segments/${id}`); views[kind].segment = null; await refreshSegments(); reload(kind);
    } },
  ]);
}

function renameSegment(kind, s) {
  modal({
    title: 'Rename segment', width: 400,
    body: (b) => b.append(h('input', { class: 'input', id: 'seg-rename', value: s.name, style: { width: '100%' } })),
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: async () => {
        try { await api.patch(`/segments/${s.id}`, { name: document.getElementById('seg-rename').value }); m.close(); await refreshSegments(); }
        catch (e) { toast(e.message, { error: true }); }
      } }, 'Save')),
  });
}

/* ---------------------------------------------------------------- data in and out */

function addData(anchor, kind) {
  const tables = state.boot?.tables || [];
  menu(anchor, [
    { group: 'From a table' },
    ...(tables.length ? tables.slice(0, 15).map((t) => ({ label: t.name, icon: 'table', onSelect: () => setTimeout(() => fromTableDialog(kind, t)) }))
      : [{ label: 'No tables yet', icon: 'plus', sub: 'make one on Home', onSelect: () => nav.go('/') }]),
    { sep: true },
    { label: 'Upload a CSV', icon: 'upload', onSelect: () => pickCsv(kind) },
    { label: 'Search Find leads', icon: 'search', onSelect: () => nav.go('/find') },
  ], { width: 260 });
}

export async function fromTableDialog(kind, t) {
  let table;
  try { table = await api.get(`/tables/${t.id}`); } catch (e) { return toast(e.message, { error: true }); }
  const cols = table.columns;
  const map = guessMap(kind, cols);
  modal({
    title: `Send “${t.name}” to ${KINDS[kind]}`, width: 520,
    body: (b) => {
      b.append(h('p', { class: 'muted', style: { marginTop: 0 } }, `${table.rows.length.toLocaleString('en-US')} rows. Match columns to fields. Records that are already in ${KINDS[kind]} keep their values and gain the ones they were missing.`),
        h('div', { class: 'aud-map' }, FIELDS[kind].map(([k, label]) => h('label', { class: 'aud-map-row' }, h('span', null, label),
          h('select', { class: 'input', onChange: (e) => { if (e.target.value) map[k] = e.target.value; else delete map[k]; } },
            h('option', { value: '' }, '—'), cols.map((c) => h('option', { value: c.key, selected: map[k] === c.key }, c.name)))))));
    },
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const r = await api.post(`/audiences/${kind}/from-table`, { table_id: t.id, map });
          m.close(); toast(`${r.added.toLocaleString('en-US')} added, ${r.updated.toLocaleString('en-US')} updated${r.skipped ? `, ${r.skipped} skipped (no ${kind === 'people' ? 'email or name plus company' : 'domain or name'})` : ''}.`);
          if (nav.current().page === 'audience') reload(kind);
        } catch (ex) { e.currentTarget.disabled = false; toast(ex.message, { error: true }); }
      } }, `Send to ${KINDS[kind]}`)),
  });
}

function pickCsv(kind) {
  const input = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onChange: async () => {
    const file = input.files[0]; input.remove();
    if (!file) return;
    try {
      const r = await api.post(`/audiences/${kind}/import?name=${encodeURIComponent(file.name)}`, await file.text());
      toast(`${r.added.toLocaleString('en-US')} added, ${r.updated.toLocaleString('en-US')} updated. Matched: ${r.matched.map((k) => fieldLabel(kind, k)).join(', ')}.`);
      reload(kind);
    } catch (e) { toast(e.message, { error: true }); }
  } });
  document.body.append(input); input.click();
}

async function sendToTable(kind) {
  const v = views[kind];
  const body = v.sel.size ? { ids: [...v.sel] } : { q: v.q, filters: v.filters, segment_id: v.segment || undefined };
  const n = v.sel.size || v.data?.total || 0;
  const seg = (segments || []).find((s) => s.id === v.segment);
  try {
    const r = await api.post(`/audiences/${kind}/to-table`, { ...body, name: seg ? seg.name : KINDS[kind] });
    toast(`${r.added.toLocaleString('en-US')} of ${n.toLocaleString('en-US')} sent to a new table.`);
    const { refreshTableList } = await import('../store.js');
    await refreshTableList(); nav.go(`/t/${r.table_id}`);
  } catch (e) { toast(e.message, { error: true }); }
}

async function removeSelected(kind) {
  const v = views[kind];
  const n = v.sel.size;
  if (!(await confirmDialog({ title: `Delete ${n} ${n === 1 ? 'record' : 'records'}?`, text: 'They leave this database. Rows in your tables are not touched.', confirmLabel: 'Delete', danger: true }))) return;
  try { await api.post(`/audiences/${kind}/delete`, { ids: [...v.sel] }); v.sel = new Set(); load(kind); }
  catch (e) { toast(e.message, { error: true }); }
}

/* ---------------------------------------------------------------- one record */

function openRecord(kind, rec) {
  const draft = {};
  const title = rec.data.full_name || rec.data.name || rec.data.email || rec.data.domain || 'Record';
  openPanel({
    title, width: 480,
    body: (b) => {
      b.append(h('div', { class: 'row-panel' },
        FIELDS[kind].map(([k, label, type]) => {
          const src = rec.sources[k];
          return h('div', { class: 'rp-field' },
            h('label', { class: 'rp-label', for: `rec-${k}` }, label),
            h('input', { class: 'input', id: `rec-${k}`, type: type === 'number' ? 'number' : 'text', value: rec.data[k] ?? '',
              onInput: (e) => { draft[k] = e.target.value.trim() === '' ? null : (type === 'number' ? Number(e.target.value) : e.target.value); } }),
            src ? h('div', { class: 'rp-meta' }, `From ${src.source} · ${new Date(src.at).toLocaleDateString()}`) : null);
        }),
        h('div', { class: 'rp-meta' }, `Added ${new Date(rec.created_at).toLocaleString()} · updated ${new Date(rec.updated_at).toLocaleString()}`)));
    },
    footer: (f, p) => f.append(h('button', { class: 'btn ghost danger', onClick: async () => {
      if (!(await confirmDialog({ title: 'Delete this record?', text: 'It leaves this database. Your tables are not touched.', confirmLabel: 'Delete', danger: true }))) return;
      await api.post(`/audiences/${kind}/delete`, { ids: [rec.id] }); p.close(); load(kind);
    } }, icon('trash', 14), 'Delete'), h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: () => p.close() }, 'Close'),
    h('button', { class: 'btn primary', onClick: async () => {
      if (!Object.keys(draft).length) return p.close();
      try { await api.patch(`/audiences/${kind}/${rec.id}`, { data: draft }); p.close(); toast('Saved.'); load(kind, { keepSel: true }); }
      catch (e) { toast(e.message, { error: true }); }
    } }, 'Save')),
  });
}

/** Leaving the page keeps the filters but drops the cached list, so the next visit is fresh. */
export function leaveAudience() { for (const v of Object.values(views)) v.data = null; segments = null; }
