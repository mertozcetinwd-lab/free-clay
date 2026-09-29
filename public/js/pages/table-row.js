/**
 * The row panel: one row, every column, top to bottom, like Clay's expanded record. Data cells are
 * editable in place (saved through applyCells, so Ctrl Z undoes them); computed cells show their
 * status, which provider answered, what it cost and any error.
 */

import { h, mount } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { state, subscribe } from '../store.js';
import { valueOf, COMPUTED } from '../logic.js';
import { valueNode } from '../ui/values.js';
import { openPanel } from '../ui/panel.js';
import { fmtMicros } from '../types.js';
import { applyCells } from './table-ops.js';

const STATUS = { queued: 'Queued', running: 'Running', done: 'Done', no_result: 'No result', error: 'Error', skipped: 'Skipped' };

export function openRowPanel(rowId) {
  const tid = state.t.table.id;
  let unsub = null;
  const p = openPanel({
    title: 'Row', width: 480,
    onClose: () => unsub?.(),
    body: (el) => {
      const draw = () => {
        if (!state.t || state.t.table.id !== tid) return p?.close();
        const r = state.t.rows.find((x) => x.id === rowId);
        if (!r) return mount(el, h('p', { class: 'faint' }, 'This row was deleted.'));
        if (el.contains(document.activeElement)) return;   // do not redraw under someone typing
        const cols = state.t.columns;
        const first = cols[0] ? valueOf(r, cols[0]) : null;
        mount(el, h('div', { class: 'row-panel' },
          h('h2', { class: 'rp-title' }, first ? String(first) : `Row ${r.id}`),
          cols.map((c) => field(r, c))));
      };
      draw();
      unsub = subscribe(draw);
    },
  });
}

function field(r, c) {
  const v = valueOf(r, c);
  const m = COMPUTED.includes(c.kind) ? state.t.meta.get(`${r.id}:${c.id}`) : null;
  const label = h('div', { class: 'rp-label' }, icon(typeIcon(c.type, c.kind), 13), h('span', null, c.name));
  if (c.kind === 'data' && !['checkbox', 'select', 'multi_select', 'json'].includes(c.type)) {
    const input = h('input', { class: 'input', value: v ?? '', 'aria-label': c.name,
      onChange: (e) => applyCells([{ id: r.id, key: c.key, before: r.data[c.key] ?? null, after: e.target.value || null }], { label: 'edit' }).catch(() => {}),
      onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
    return h('div', { class: 'rp-field' }, label, input);
  }
  return h('div', { class: 'rp-field' }, label,
    h('div', { class: 'rp-value' }, valueNode(c, v) || h('span', { class: 'faint' }, 'Empty')),
    m ? h('div', { class: 'rp-meta' },
      h('span', { class: ['st-label', m.status] }, STATUS[m.status] || m.status),
      m.provider ? h('span', null, `by ${m.provider}`) : null,
      m.cost_micros ? h('span', null, fmtMicros(m.cost_micros)) : null,
      m.error ? h('div', { class: 'rp-error' }, m.error) : null) : null);
}
