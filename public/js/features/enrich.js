/**
 * Enrichment columns in the side panel: pick a function (cost chip on each), map its inputs to
 * columns, choose which result fields become their own columns, set a run condition.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadTable, changed } from '../store.js';
import { KIND_UI, field } from '../ui/column-panel.js';
import { templateInput } from '../ui/template-input.js';
import { listbox, toast } from '../ui/overlay.js';
import { fmtMicros } from '../types.js';
import { refs } from '../template.js';
import { pricing } from './run.js';
import { tableHooks } from '../pages/table.js';

pricing.enrich = (col) => { const f = fnById(col.config.fn); return f ? costOf(f) : 0; };
// The catalog loads with the first table (never before login: a 401 would bounce to the sign-in page).
tableHooks.afterLoad.push(() => { if (!catalog) functions().then(changed); });

let catalog = null;
export async function functions() {
  if (!catalog) catalog = await api.get('/functions');
  return catalog;
}
export const fnById = (id) => catalog?.find((f) => f.id === id) || null;

/** Your override from Settings, else the function's own estimate. */
export function costOf(fn) {
  const o = state.boot?.settings?.cost_overrides || {};
  return Number.isInteger(o[fn.id]) ? o[fn.id] : fn.costMicros || 0;
}

export function costChip(fn) {
  const c = costOf(fn);
  // $0 on a keyed function means the provider's free-plan credits, not free: they run out.
  const credits = c === 0 && fn.secret;
  return h('span', { class: ['cost', c === 0 && !credits && 'free'], title: fn.costSource || (c ? 'Estimated cost per row' : 'No provider bill') },
    credits ? 'Your credits' : c === 0 ? 'Free' : `~${fmtMicros(c)} / row`);
}

/** Pick a function: grouped Free / Your key, with what each costs. */
export function pickFunction(anchor, onPick, filter = () => true) {
  functions().then((list) => {
    const groups = ['Free', 'Your key'];
    listbox(anchor, {
      placeholder: 'Search functions',
      width: 380,
      items: groups.flatMap((g) => {
        const fns = list.filter((f) => f.group === g && filter(f));
        return fns.length ? [{ group: g === 'Free' ? 'Free, no key' : 'Your own key (you pay the provider)' },
          ...fns.map((f) => ({ label: f.name, sub: f.blurb, value: f.id, hint: costOf(f) ? `~${fmtMicros(costOf(f))}` : 'Free', icon: f.secret ? 'key' : 'zap' }))] : [];
      }),
      onPick: (it) => onPick(list.find((f) => f.id === it.value)),
    });
  });
}

/** The "never runs automatically" warning Clay shows, for a config that references no column. */
export function noRefWarning(templates) {
  const any = Object.values(templates || {}).some((t) => refs(t).length);
  return any ? null : h('div', { class: 'note warn' }, icon('alert', 14),
    'These inputs reference no other column, so every row gets the same input. Type / to use a column.');
}

/** Inputs of one function, each a template field. */
export function inputFields(fn, templates, columns, onChange) {
  return fn.inputs.map((i) => field(i.label + (i.required ? '' : ' (optional)'),
    templateInput({ value: templates[i.key] || '', columns, label: i.label, onChange: (v) => { templates[i.key] = v; onChange?.(); } })));
}

/** Guess an input mapping from column names, so most columns work with zero typing. */
export function guessInputs(fn, columns) {
  const out = {};
  const find = (...res) => columns.find((c) => res.some((re) => re.test(c.name)))?.key;
  for (const i of fn.inputs) {
    const k = /domain|url|website|text/i.test(i.key) ? find(/website|domain|url|site/i)
      : i.key === 'email' ? find(/e-?mail/i)
        : i.key === 'first_name' ? find(/^first/i)
          : i.key === 'last_name' ? find(/^last/i)
            : i.key === 'company' ? find(/company|organi[sz]ation|business/i)
              : i.key === 'full_name' || i.key === 'name' ? find(/^(full )?name$/i) : null;
    if (k) out[i.key] = `{{${k}}}`;
  }
  return out;
}

KIND_UI.enrich = {
  label: 'Enrichment', icon: 'zap', blurb: 'Run one function per row.',
  defaults: () => ({ type: 'text', config: { fn: null, inputs: {}, outputs: [], condition: '', auto: false } }),
  check: (d) => (!d.config.fn ? 'Pick a function first' : null),
  render(el, draft, ctx) {
    const cfg = draft.config;
    const fn = fnById(cfg.fn);
    if (cfg.fn && !catalog) { functions().then(() => ctx.refresh()); return; }
    const picker = h('button', { class: 'btn picker-btn', onClick: (e) => pickFunction(e.currentTarget, (f) => {
      cfg.fn = f.id; cfg.inputs = guessInputs(f, ctx.columns); cfg.outputs = []; draft.type = f.type;
      if (!draft.name) draft.name = f.name;
      ctx.refresh();
    }) }, fn ? [icon(fn.secret ? 'key' : 'zap', 15), h('span', { class: 'grow ellipsis', style: { textAlign: 'left' } }, fn.name), costChip(fn)] : [icon('search', 15), 'Pick a function']);
    mount(el, field('Function', picker, fn?.blurb));
    if (!fn) return;
    if (fn.secret) {
      const s = state.boot.secrets.find((x) => x.name === fn.secret);
      el.append(h('div', { class: ['note', s?.set ? 'ok' : 'warn'] }, icon('key', 14),
        s?.set ? `Uses your ${fn.secret}.` : `Needs ${fn.secret}. Set it with: npx wrangler secret put ${fn.secret}, then add the name in Settings, Keys.`));
    }
    el.append(h('div', { class: 'sect-h' }, 'Inputs'), ...inputFields(fn, cfg.inputs, ctx.columns));
    const warn = noRefWarning(cfg.inputs); if (warn) el.append(warn);
    el.append(outputsSection(fn, draft, ctx));
    el.append(runOptions(cfg, ctx));
  },
  afterSave: createWantedOutputs,
  footer: (draft) => {
    const fn = fnById(draft.config.fn);
    if (!fn) return null;
    const rows = state.t.rows.length;
    return h('span', { class: 'faint' }, costOf(fn) ? `~${fmtMicros(costOf(fn) * rows)} for all ${rows} rows` : `Free for all ${rows} rows`);
  },
};

/** Result fields: tick one to give it its own column (Clay's "define outputs"). */
export function outputsSection(fn, draft, ctx) {
  const cfg = draft.config;
  const mapped = new Map((cfg.outputs || []).map((o) => [o.field, o.column]));
  const others = fn.outputs.filter((o) => o.key !== fn.primary);
  if (!others.length) return h('div');
  draft.wantOutputs = draft.wantOutputs || [];
  return h('div', { class: 'stack' }, h('div', { class: 'sect-h' }, 'Also add as columns'),
    h('div', { class: 'faint', style: { marginTop: '-6px' } }, `The cell shows ${fn.outputs.find((o) => o.key === fn.primary)?.label}. Tick any other field to give it a column.`),
    others.map((o) => {
      const col = mapped.get(o.field || o.key) || mapped.get(o.key);
      const on = !!col || draft.wantOutputs.includes(o.key);
      return h('label', { class: 'check-row' },
        h('button', { type: 'button', class: 'check', role: 'checkbox', 'aria-checked': on ? 'true' : 'false', disabled: !!col,
          onClick: () => { const w = draft.wantOutputs; w.includes(o.key) ? w.splice(w.indexOf(o.key), 1) : w.push(o.key); ctx.refresh(); } }, on ? icon('check', 12, 2.5) : null),
        h('span', null, o.label), col ? h('span', { class: 'faint' }, `in ${state.t.columns.find((c) => c.key === col)?.name || col}`) : null);
    }));
}

/** Run condition and auto-run. The condition is a formula (see the Formula column). */
export function runOptions(cfg, ctx) {
  return h('div', { class: 'stack' }, h('div', { class: 'sect-h' }, 'When it runs'),
    field('Only run if (optional formula)', templateInput({ value: cfg.condition || '', columns: ctx.columns, label: 'Run condition',
      placeholder: 'e.g. NOT(ISBLANK({{website}}))', onChange: (v) => { cfg.condition = v; } })),
    h('label', { class: 'check-row' }, h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': cfg.auto ? 'true' : 'false', 'aria-label': 'Auto-run',
      onClick: (e) => { cfg.auto = !cfg.auto; e.currentTarget.setAttribute('aria-checked', cfg.auto ? 'true' : 'false'); } }),
    h('span', null, 'Auto-run when its inputs change'), h('span', { class: 'faint' }, state.boot.settings.auto_run ? '' : '(auto-run is off in Settings)')));
}

/** After a column is saved: create the output columns that were ticked (they fill from stored results). */
export async function createWantedOutputs(col, draft) {
  const want = draft.wantOutputs || [];
  if (!want.length) return;
  try { for (const f of want) await api.post(`/columns/${col.id}/outputs`, { field: f }); }
  catch (e) { toast(e.message, { error: true }); }
  await loadTable(state.t.table.id);
}
