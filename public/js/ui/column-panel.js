/**
 * Add or edit a column in the side panel. Data columns are a name and a type; every computed kind
 * (enrichment, waterfall, formula, AI, HTTP) registers its own editor in KIND_UI, so this file
 * stays the same as kinds are added.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { TYPES } from '../types.js';
import { api } from '../api.js';
import { state, putColumn, changed, loadTable } from '../store.js';
import { openPanel } from './panel.js';
import { toast } from './overlay.js';

/**
 * kind -> { label, icon, blurb, defaults(): {type, config}, render(el, draft, ctx), check(draft): error|null,
 *           footer?(el, draft, ctx): extra footer content such as the cost chip }
 * ctx = { table, columns, refresh() } ; draft = { name, type, kind, config } (mutable)
 */
export const KIND_UI = {
  data: {
    label: 'Data', icon: 'text', blurb: 'You type or import it.',
    defaults: () => ({ type: 'text', config: {} }),
    render: () => {},
  },
};

export function field(label, control, hint) {
  return h('div', { class: 'form-row' }, h('label', { class: 'label' }, label), control, hint ? h('div', { class: 'hint-text' }, hint) : null);
}

export function typeSelect(draft, onChange) {
  return h('select', { class: 'select', 'aria-label': 'Type', onChange: (e) => { draft.type = e.target.value; onChange?.(); } },
    Object.entries(TYPES).map(([k, label]) => h('option', { value: k, selected: draft.type === k }, label)));
}

/** preset (new columns only): {kind, type, name, config, position} from the Add column menu. */
export function openColumnPanel(col, { onSaved, preset = {} } = {}) {
  const table = state.t.table;
  const isNew = !col;
  const draft = isNew
    ? { name: '', kind: 'data', ...KIND_UI.data.defaults() }
    : { name: col.name, key: col.key, kind: col.kind, type: col.type, config: structuredClone(col.config || {}) };

  openPanel({
    title: isNew ? 'Add column' : `Edit ${col.name}`,
    width: 460,
    body: (el, p) => {
      const ctx = { table, columns: state.t.columns.filter((c) => !col || c.id !== col.id), refresh: () => draw(), panel: p };
      if (isNew && preset.kind && KIND_UI[preset.kind]) Object.assign(draft, { kind: preset.kind }, KIND_UI[preset.kind].defaults(ctx));
      if (isNew) {
        if (preset.type) draft.type = preset.type;
        if (preset.name) draft.name = preset.name;
        if (preset.config) draft.config = { ...draft.config, ...preset.config };
      }
      const draw = () => {
        const kinds = Object.entries(KIND_UI);
        const ui = KIND_UI[draft.kind] || KIND_UI.data;
        const nameInput = h('input', { class: 'input', value: draft.name, placeholder: 'Column name', 'aria-label': 'Column name',
          onInput: (e) => { draft.name = e.target.value; } });
        mount(el,
          isNew ? h('div', { class: 'kind-grid', role: 'radiogroup', 'aria-label': 'Column kind' }, kinds.map(([k, u]) => h('button', {
            class: ['kind-tile', draft.kind === k && 'on'], role: 'radio', 'aria-checked': draft.kind === k ? 'true' : 'false', type: 'button',
            onClick: () => { if (draft.kind === k) return; Object.assign(draft, { kind: k }, u.defaults(ctx)); draw(); },
          }, icon(u.icon, 16), h('b', null, u.label), h('span', null, u.blurb)))) : null,
          field('Name', nameInput),
          draft.kind === 'data' || KIND_UI[draft.kind]?.pickType ? field('Type', typeSelect(draft)) : null,
          h('div', { class: 'kind-body' }));
        ui.render(el.querySelector('.kind-body'), draft, ctx);
        drawFoot();
        if (isNew && !draft.name) nameInput.focus();
      };
      const drawFoot = () => {
        const ui = KIND_UI[draft.kind] || KIND_UI.data;
        mount(p.foot,
          ui.footer ? ui.footer(draft, ctx) : null,
          h('span', { class: 'grow' }),
          h('button', { class: 'btn', onClick: () => p.close() }, 'Cancel'),
          h('button', { class: 'btn primary', onClick: save }, isNew ? 'Add column' : 'Save'));
      };
      const save = async () => {
        const ui = KIND_UI[draft.kind] || KIND_UI.data;
        if (!draft.name.trim()) return toast('Give the column a name', { error: true });
        const problem = ui.check?.(draft, ctx);
        if (problem) return toast(problem, { error: true });
        try {
          const saved = isNew
            ? await api.post(`/tables/${table.id}/columns`, { name: draft.name, kind: draft.kind, type: draft.type, config: draft.config, position: preset.position })
            : await api.patch(`/columns/${col.id}`, { name: draft.name, type: draft.type, config: draft.config });
          if (isNew && preset.position !== undefined) await loadTable(table.id); else putColumn(saved);
          p.close();
          await ui.afterSave?.(saved, draft);
          onSaved?.(saved);
          changed();
        } catch (e) { toast(e.message, { error: true }); }
      };
      ctx.redrawFoot = drawFoot;
      draw();
    },
    footer: () => {},
  });
}
