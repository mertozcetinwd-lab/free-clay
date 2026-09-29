/**
 * A text field that references columns. Type "/" (Clay's shortcut) or press the + button to pick
 * a column; it is inserted as {{column_key}}. Under the field, the referenced columns are listed
 * by name, so the stored keys never have to be read.
 */

import { h } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { listbox } from './overlay.js';
import { refs } from '../template.js';

export function templateInput({ value = '', columns, onChange, placeholder = 'Type / to insert a column', multiline = false, label }) {
  const input = multiline
    ? h('textarea', { class: 'textarea mono-ish', placeholder, 'aria-label': label || placeholder, spellcheck: 'false' })
    : h('input', { class: 'input', placeholder, 'aria-label': label || placeholder, autocomplete: 'off', spellcheck: 'false' });
  input.value = value;
  const used = h('div', { class: 'refs' });
  const showRefs = () => {
    const names = refs(input.value).map((k) => columns.find((c) => c.key === k)?.name || `${k} (missing)`);
    used.replaceChildren(...(names.length ? [h('span', { class: 'faint' }, 'Uses '), ...names.map((n) => h('span', { class: ['ref', /missing/.test(n) && 'bad'] }, n))] : []));
  };
  const insert = (key, replaceSlash) => {
    const s = input.selectionStart ?? input.value.length;
    const e = input.selectionEnd ?? s;
    const from = replaceSlash && input.value[s - 1] === '/' ? s - 1 : s;
    input.value = input.value.slice(0, from) + `{{${key}}}` + input.value.slice(e);
    const pos = from + key.length + 4;
    input.focus(); input.setSelectionRange(pos, pos);
    onChange(input.value); showRefs();
  };
  const pick = (anchor, replaceSlash) => listbox(anchor, {
    placeholder: 'Pick a column',
    items: columns.map((c) => ({ label: c.name, value: c.key, icon: typeIcon(c.type, c.kind) })),
    onPick: (it) => insert(it.value, replaceSlash),
  });
  input.addEventListener('input', () => {
    onChange(input.value); showRefs();
    const s = input.selectionStart;
    if (input.value[s - 1] === '/' && (s === 1 || /\s|\(|,/.test(input.value[s - 2]))) pick(input, true);
  });
  showRefs();
  return h('div', { class: 'tpl' }, h('div', { class: 'tpl-row' }, input,
    h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Insert a column', title: 'Insert a column', onClick: (e) => pick(e.currentTarget, false) }, icon('plus', 14))), used);
}
