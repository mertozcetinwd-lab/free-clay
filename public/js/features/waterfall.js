/**
 * The waterfall editor: ordered steps you can drag, switch off or remove, an optional validation
 * step, and "output name of successful provider". The cost footer shows the worst case (every step
 * runs) because that is what a run reserves against its budget.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadTable } from '../store.js';
import { KIND_UI, field } from '../ui/column-panel.js';
import { toast } from '../ui/overlay.js';
import { fmtMicros } from '../types.js';
import { functions, fnById, validators, costOf, costChip, pickFunction, inputFields, guessInputs, outputsSection, runOptions, noRefWarning } from './enrich.js';
import { pricing } from './run.js';

export function worstCase(cfg) {
  const v = cfg.validate?.fn ? fnById(cfg.validate.fn) : null;
  return (cfg.steps || []).filter((s) => s.enabled !== false).reduce((a, s) => {
    const f = fnById(s.fn);
    return a + (f ? costOf(f) : 0) + (v ? costOf(v) : 0);
  }, 0);
}
pricing.waterfall = (col) => worstCase(col.config);

let open = null;   // index of the step whose inputs are expanded

KIND_UI.waterfall = {
  label: 'Waterfall', icon: 'layers', blurb: 'Try providers in order, stop at the first hit.',
  defaults: () => ({ type: 'email', config: { steps: [], validate: null, provider_column: null, outputs: [], condition: '', auto: false } }),
  check: (d) => (!d.config.steps.length ? 'Add at least one step' : !d.config.steps.some((s) => s.enabled !== false) ? 'Switch on at least one step' : null),
  render(el, draft, ctx) {
    const cfg = draft.config;
    if (!fnById('email_check')) { functions().then(() => ctx.refresh()); return; }
    const steps = cfg.steps;
    let dragFrom = null;
    const list = h('div', { class: 'wf-steps' }, steps.map((s, i) => {
      const f = fnById(s.fn);
      const on = s.enabled !== false;
      const row = h('div', { class: ['wf-step', !on && 'off'], draggable: 'true',
        onDragstart: (e) => { dragFrom = i; e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); },
        onDragend: () => row.classList.remove('dragging'),
        onDragover: (e) => { e.preventDefault(); row.classList.add('drop'); },
        onDragleave: () => row.classList.remove('drop'),
        onDrop: (e) => { e.preventDefault(); if (dragFrom === null || dragFrom === i) return; const [m] = steps.splice(dragFrom, 1); steps.splice(i, 0, m); open = null; ctx.refresh(); },
      },
      h('div', { class: 'wf-head' },
        h('span', { class: 'grip', title: 'Drag to reorder' }, icon('grip', 14)),
        h('span', { class: 'wf-n' }, i + 1),
        h('button', { class: 'wf-name', type: 'button', onClick: () => { open = open === i ? null : i; ctx.refresh(); } },
          h('span', { class: 'ellipsis' }, f?.name || s.fn), icon(open === i ? 'chevron-up' : 'chevron-down', 13)),
        f ? costChip(f) : null,
        h('button', { class: 'btn ghost icon sm', 'aria-label': 'Move up', disabled: i === 0, onClick: () => { [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; open = null; ctx.refresh(); } }, icon('arrow-up', 13)),
        h('button', { class: 'switch', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': `Use ${f?.name || s.fn}`, onClick: () => { s.enabled = !on; ctx.refresh(); } }),
        h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove step', onClick: () => { steps.splice(i, 1); open = null; ctx.refresh(); } }, icon('x', 13))),
      open === i && f ? h('div', { class: 'wf-body' }, inputFields(f, s.inputs, ctx.columns), noRefWarning(s.inputs)) : null);
      return row;
    }));
    const addStep = h('button', { class: 'btn', onClick: (e) => pickFunction(e.currentTarget, (f) => {
      if (!steps.length) { draft.type = f.type; if (!draft.name) draft.name = f.outputs.find((o) => o.key === f.primary)?.label || f.name; }
      steps.push({ fn: f.id, inputs: guessInputs(f, ctx.columns), enabled: true });
      ctx.refresh();
    }, (f) => !f.validates) }, icon('plus', 14), 'Add step');

    const vOn = !!cfg.validate?.fn;
    const vFn = vOn ? fnById(cfg.validate.fn) : null;
    mount(el,
      h('div', { class: 'sect-h' }, 'Steps', h('span', { class: 'faint', style: { fontWeight: 400 } }, 'tried top to bottom, first hit wins')),
      steps.length ? list : h('div', { class: 'note' }, icon('layers', 14), 'Add the providers to try, cheapest or most accurate first. Each row stops at the first one that finds something.'),
      h('div', null, addStep),
      h('div', { class: 'sect-h' }, 'Check each result'),
      h('label', { class: 'check-row' },
        h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': vOn ? 'true' : 'false', 'aria-label': 'Validate results',
          onClick: () => { cfg.validate = vOn ? null : { fn: 'email_check', pass: 'valid' }; ctx.refresh(); } }),
        h('span', null, 'Validate before accepting'), vFn ? costChip(vFn) : null),
      vOn ? h('div', { class: 'grid2' },
        field('Check with',
          h('select', { class: 'input', 'aria-label': 'Validation function', onChange: (e) => { cfg.validate = { fn: e.target.value, pass: 'valid' }; ctx.refresh(); } },
            validators().map((f) => h('option', { value: f.id, selected: f.id === cfg.validate.fn }, f.name)))),
        vFn?.outputs.some((o) => o.key === 'acceptable') ? field('Accept',
          h('select', { class: 'input', 'aria-label': 'What passes', onChange: (e) => { cfg.validate = { ...cfg.validate, pass: e.target.value }; ctx.refresh(); } },
            h('option', { value: 'valid', selected: cfg.validate.pass !== 'acceptable' }, 'Valid only'),
            h('option', { value: 'acceptable', selected: cfg.validate.pass === 'acceptable' }, 'Valid or catch-all (risky)'))) : h('div')) : null,
      vOn ? h('div', { class: 'faint' }, `${vFn?.name}: a result that fails moves on to the next step. ${cfg.validate.pass === 'acceptable' ? 'Catch-all domains accept any address, so those emails cannot be confirmed: expect some to bounce. ' : ''}${vFn?.blurb || ''}`) : null,
      h('div', { class: 'sect-h' }, 'Provider'),
      h('label', { class: 'check-row' },
        h('button', { type: 'button', class: 'check', role: 'checkbox', 'aria-checked': cfg.provider_column || draft.wantProvider ? 'true' : 'false', disabled: !!cfg.provider_column,
          onClick: () => { draft.wantProvider = !draft.wantProvider; ctx.refresh(); } }, cfg.provider_column || draft.wantProvider ? icon('check', 12, 2.5) : null),
        h('span', null, 'Output name of successful provider?'),
        cfg.provider_column ? h('span', { class: 'faint' }, `in ${state.t.columns.find((c) => c.key === cfg.provider_column)?.name || cfg.provider_column}`) : null));
    const union = unionOutputs(steps);
    if (union) el.append(outputsSection(union, draft, ctx));
    el.append(runOptions(cfg, ctx));
  },
  async afterSave(col, draft) {
    try {
      if (draft.wantProvider && !col.config.provider_column) {
        const c = await api.post(`/tables/${state.t.table.id}/columns`, { name: `${col.name} provider`, type: 'text' });
        await api.patch(`/columns/${col.id}`, { config: { ...col.config, provider_column: c.key } });
      }
      for (const f of draft.wantOutputs || []) await api.post(`/columns/${col.id}/outputs`, { field: f });
    } catch (e) { toast(e.message, { error: true }); }
    await loadTable(state.t.table.id);
  },
  footer: (draft) => {
    const w = worstCase(draft.config);
    const n = state.t.rows.length;
    return h('span', { class: 'faint' }, w ? `Up to ${fmtMicros(w)} a row if every step runs (${fmtMicros(w * n)} for ${n} rows)` : `Free for all ${n} rows`);
  },
};

/** Every field any step can return, as one pseudo-function for the outputs picker. */
function unionOutputs(steps) {
  const first = fnById(steps[0]?.fn);
  if (!first) return null;
  const seen = new Map();
  for (const s of steps) for (const o of fnById(s.fn)?.outputs || []) if (!seen.has(o.key)) seen.set(o.key, o);
  return { outputs: [...seen.values()], primary: first.primary };
}

