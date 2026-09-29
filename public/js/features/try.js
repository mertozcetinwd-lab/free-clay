/**
 * "Try on 5 rows" (Clay has it on AI columns): runs the panel's unsaved settings on the first rows
 * through POST /api/tables/:id/try (src/tryrun.js). Nothing is saved or written to a cell; paid
 * calls are real, capped by your budget per run, and show in Spend as "try".
 */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state } from '../store.js';
import { popover, toast } from '../ui/overlay.js';
import { fmtMicros } from '../types.js';

export function tryButton(draft) {
  return h('button', { class: 'btn', type: 'button', title: 'Runs these settings on the first 5 rows without saving the column. Paid calls are real and capped by your budget per run.',
    onClick: (e) => tryRun(e.currentTarget, draft) }, icon('play', 13), 'Try on 5 rows');
}

async function tryRun(btn, draft) {
  btn.disabled = true;
  let r;
  try { r = await api.post(`/tables/${state.t.table.id}/try`, { kind: draft.kind, type: draft.type, name: draft.name, key: draft.key, config: draft.config }); }
  catch (e) { return toast(e.message, { error: true }); }
  finally { btn.disabled = false; }
  const first = state.t.columns[0];
  popover(btn, (el, pop) => {
    el.append(h('div', { class: 'pop-body try-results' },
      h('b', null, `Tried on ${r.tried} row${r.tried === 1 ? '' : 's'}`),
      h('div', { class: 'faint' }, r.cost_micros ? `Cost ${fmtMicros(r.cost_micros)}, in Spend as "try". Nothing was saved.` : 'Cost $0. Nothing was saved.'),
      r.results.map((x) => {
        const row = state.t.rows.find((w) => w.id === x.row_id);
        const label = row && first ? String(row.data[first.key] ?? `Row ${x.row_id}`) : `Row ${x.row_id}`;
        return h('div', { class: 'try-row' }, h('div', { class: 'faint' }, label.slice(0, 80)),
          x.status === 'done' ? h('div', { class: 'try-val' }, String(x.value ?? ''))
            : h('div', { class: x.status === 'error' ? 'bad' : 'faint' }, `${x.status.replace('_', ' ')}${x.error ? `: ${x.error}` : ''}`));
      })),
    h('div', { class: 'pop-foot' }, h('button', { class: 'btn', onClick: () => pop.close() }, 'Close')));
  }, { width: 440 });
}
