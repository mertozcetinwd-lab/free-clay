/**
 * Signals (LOAM-PLAN.md phase 9; Clay's Signals, a paid add-on there): the watch list and the
 * event feed. Sources are free and public (src/signals.js): job boards, a page's text, Google
 * News, SEC filings. Each signal can add a row per event to a table and start workflows.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, changed } from '../store.js';
import { toast, confirmDialog, modal, menu } from '../ui/overlay.js';

let sigs = null; let events = null; let meta = null; let loading = false; let filter = null; let checking = null;

async function load() {
  loading = true;
  try { [sigs, events, meta] = await Promise.all([api.get('/signals'), api.get(`/signals/events${filter ? `?signal=${filter}` : ''}`), meta || api.get('/signals/meta')]); }
  catch (e) { toast(e.message, { error: true }); sigs = sigs || []; events = events || []; }
  loading = false; changed();
}

const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const TYPE_ICON = { jobs: 'briefcase', website: 'globe', news: 'file-text', sec: 'building' };

export function renderSignals(regions) {
  mount(regions.top, h('div', { class: 'crumbs' }, h('b', null, 'Signals')));
  if (!sigs && !loading) load();
  const list = sigs || [];
  mount(regions.content, h('div', { class: 'home' },
    h('div', { class: 'find-head' }, h('span', { class: 'files-ic' }, icon('activity', 18)), h('h1', null, 'Signals'),
      h('span', { class: 'faint' }, 'Know when a company hires, changes its site, makes the news or files with the SEC.'), h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onClick: () => edit(null) }, icon('plus', 14), 'New signal')),
    list.length ? h('div', { class: 'sig-grid' }, list.map(card)) : h('div', { class: 'files-empty', style: { marginTop: '18px' } }, loading ? 'Loading…' :
      'No signals yet. Watch a list of companies for new job posts, website changes, news or SEC filings. The first check saves what is there now; after that you only hear about what is new.'),
    list.length ? h('section', { class: 'files', style: { marginTop: '28px' } },
      h('div', { class: 'files-head' }, h('span', { class: 'files-ic' }, icon('inbox', 18)), h('h2', null, 'Events'),
        filter ? h('button', { class: 'chip', onClick: () => { filter = null; load(); } }, `${list.find((s) => s.id === filter)?.name || 'One signal'} ×`) : null),
      (events || []).length ? h('table', { class: 'files-table' },
        h('thead', null, h('tr', null, ['What happened', 'Company', 'Signal', 'When'].map((t) => h('th', null, t)))),
        h('tbody', null, events.map((e) => h('tr', { class: 'no-open' },
          h('td', { style: { maxWidth: '520px' } }, e.url ? h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer', class: 'ellipsis', style: { display: 'block' } }, e.title) : e.title),
          h('td', { class: 'faint' }, e.target), h('td', { class: 'faint' }, e.signal_name), h('td', { class: 'faint' }, ago(e.created_at)))))) :
        h('div', { class: 'files-empty' }, 'No events yet. They appear here when a check finds something new.')) : null));
}

function card(s) {
  const t = meta?.[s.type];
  return h('div', { class: 'sig-card' },
    h('div', { class: 'row' }, h('span', { class: 'files-ic' }, icon(TYPE_ICON[s.type] || 'activity', 16)),
      h('div', { class: 'grow', style: { minWidth: 0 } }, h('b', { class: 'ellipsis', style: { display: 'block' } }, s.name), h('span', { class: 'faint' }, t?.label || s.type)),
      h('button', { class: 'switch', role: 'switch', 'aria-checked': s.status === 'on' ? 'true' : 'false', 'aria-label': `${s.name} on`, onClick: async () => {
        try { await api.patch(`/signals/${s.id}`, { status: s.status === 'on' ? 'off' : 'on' }); load(); } catch (e) { toast(e.message, { error: true }); }
      } }),
      h('button', { class: 'btn ghost icon sm', 'aria-label': 'More', onClick: (e) => menu(e.currentTarget, [
        { label: 'Edit', icon: 'pencil', onSelect: () => edit(s) },
        { label: 'Show its events', icon: 'filter', onSelect: () => { filter = s.id; load(); } },
        { sep: true },
        { label: 'Delete', icon: 'trash', danger: true, onSelect: async () => {
          if (!(await confirmDialog({ title: `Delete “${s.name}”?`, text: 'Its events go too. Rows it added to tables stay.', confirmLabel: 'Delete', danger: true }))) return;
          await api.del(`/signals/${s.id}`); load();
        } }], { align: 'end' }) }, icon('more', 15))),
    h('div', { class: 'faint sig-targets' }, s.targets.slice(0, 6).join(', ') + (s.targets.length > 6 ? ` +${s.targets.length - 6}` : '')),
    h('div', { class: 'row faint', style: { fontSize: 'var(--fs-sm)' } },
      h('span', { class: 'grow' }, `${s.events} event${s.events === 1 ? '' : 's'} · checked ${ago(s.last_check)} · every ${s.every_hours} h`),
      h('button', { class: 'btn sm', disabled: checking === s.id, onClick: async () => {
        checking = s.id; changed();
        try {
          const r = await api.post(`/signals/${s.id}/check`);
          toast(`${r.checked} checked, ${r.events} new event${r.events === 1 ? '' : 's'}${r.errors.length ? `. ${r.errors[0].target || ''}: ${r.errors[0].error}` : ''}${!s.last_check ? '. First check: saved as the baseline.' : ''}`, { error: r.errors.length > 0 && !r.checked });
        } catch (e) { toast(e.message, { error: true }); }
        checking = null; load();
      } }, icon(checking === s.id ? 'clock' : 'refresh', 13), checking === s.id ? 'Checking…' : 'Check now')));
}

function edit(s) {
  const d = s ? { ...s, targets: s.targets.join('\n'), forms: (s.forms || []).join(', ') } : { name: '', type: 'jobs', targets: '', keyword: '', forms: 'D, 8-K', every_hours: 24, table_id: null, status: 'on' };
  const tables = state.boot?.tables || [];
  modal({ title: s ? 'Edit signal' : 'New signal', width: 540,
    body: (b) => {
      const draw = () => mount(b, h('div', { class: 'stack' },
        h('div', { class: 'form-row' }, h('label', { class: 'label' }, 'Name'), h('input', { class: 'input', value: d.name, placeholder: 'Florida roofers hiring', onInput: (e) => { d.name = e.target.value; } })),
        h('div', { class: 'form-row' }, h('label', { class: 'label' }, 'Watch for'), h('div', { class: 'sig-types' }, Object.entries(meta).map(([k, t]) => h('button', { class: ['kind-tile', d.type === k && 'on'], type: 'button', onClick: () => { d.type = k; draw(); } },
          icon(TYPE_ICON[k], 15), h('b', null, t.label))))),
        h('div', { class: 'form-row' }, h('label', { class: 'label' }, `Companies, one per line (${meta[d.type].target})`),
          h('textarea', { class: 'textarea', rows: 5, placeholder: { jobs: 'figma\nnotion.so', website: 'https://example.com/pricing', news: '"Example Roofing" Gainesville', sec: 'HD\nLOW' }[d.type], onInput: (e) => { d.targets = e.target.value; } }, d.targets)),
        d.type === 'jobs' ? h('div', { class: 'form-row' }, h('label', { class: 'label' }, 'Only roles containing (optional)'), h('input', { class: 'input', value: d.keyword || '', placeholder: 'sales', onInput: (e) => { d.keyword = e.target.value; } })) : null,
        d.type === 'sec' ? h('div', { class: 'form-row' }, h('label', { class: 'label' }, 'Forms'), h('input', { class: 'input', value: d.forms, onInput: (e) => { d.forms = e.target.value; } }),
          h('div', { class: 'hint-text' }, 'D = a private fundraise, 8-K = material news, 10-K = annual report. Needs the contact email in Settings, Data sources.')) : null,
        h('div', { class: 'grid2' },
          h('div', { class: 'form-row' }, h('label', { class: 'label' }, 'Check every'), h('select', { class: 'select', onChange: (e) => { d.every_hours = Number(e.target.value); } },
            [[6, '6 hours'], [12, '12 hours'], [24, 'day'], [72, '3 days'], [168, 'week']].map(([v, l]) => h('option', { value: v, selected: d.every_hours === v }, l)))),
          h('div', { class: 'form-row' }, h('label', { class: 'label' }, 'Add a row per event to'), h('select', { class: 'select', onChange: (e) => { d.table_id = Number(e.target.value) || null; } },
            h('option', { value: '' }, 'No table'), tables.map((t) => h('option', { value: t.id, selected: d.table_id === t.id }, t.name))))),
        h('div', { class: 'faint' }, 'Workflows can start on each event too: pick “When a signal fires” as a workflow’s trigger.')));
      draw();
    },
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: async () => {
        const body = { name: d.name, type: d.type, targets: d.targets, keyword: d.keyword, forms: d.forms, every_hours: d.every_hours, table_id: d.table_id, ...(s ? {} : { status: 'on' }) };
        try { if (s) await api.patch(`/signals/${s.id}`, body); else await api.post('/signals', body); m.close(); load(); }
        catch (e) { toast(e.message, { error: true }); }
      } }, s ? 'Save' : 'Create signal')) });
}

export function leaveSignals() { sigs = null; }
