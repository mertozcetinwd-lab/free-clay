/**
 * Editing one cell in place. Text-like types get an input over the cell; select types get a
 * searchable picker that can create a new option; JSON gets a textarea. Enter saves and moves
 * down, Tab saves and moves right, Escape cancels.
 */

import { h } from '../dom.js';
import { listbox, place } from './overlay.js';
import { valueOf } from '../logic.js';
import { isEmpty } from '../types.js';

/** Text to put in the editor for a stored value. */
function editText(col, v) {
  if (isEmpty(v)) return '';
  if (col.type === 'json') return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/**
 * td: the cell element. rows: every row (for select options). save(value) persists; move(dx, dy)
 * moves the focus after saving. initial: a first typed character, which replaces the value.
 */
export function editCell(td, row, col, { rows, save, move, initial }) {
  const v = valueOf(row, col);
  if (col.type === 'select' || col.type === 'multi_select') return pickOption(td, row, col, rows, save);
  if (col.type === 'checkbox') return save(!v);

  const multi = col.type === 'json';
  const input = multi ? h('textarea', { spellcheck: 'false' }) : h('input', { type: col.type === 'date' ? 'date' : 'text', autocomplete: 'off' });
  input.value = initial !== undefined ? initial : editText(col, v);
  const box = h('div', { class: 'cell-editor' }, input);
  document.body.append(box);
  const r = td.getBoundingClientRect();
  box.style.minWidth = Math.max(r.width, 200) + 'px';
  place(box, { left: r.left, right: r.right, top: r.top, bottom: r.top, width: r.width, height: 0 }, { gap: 0 });

  let done = false;
  const finish = (commit, dx = 0, dy = 0) => {
    if (done) return; done = true;
    box.remove();
    document.removeEventListener('pointerdown', outside, true);
    if (commit && input.value !== editText(col, v)) save(input.value);
    if (dx || dy) move(dx, dy);
  };
  const outside = (e) => { if (!box.contains(e.target)) finish(true); };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Enter' && (!multi || e.metaKey || e.ctrlKey)) { e.preventDefault(); finish(true, 0, 1); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1, 0); }
  });
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
  input.focus();
  if (initial === undefined) input.select?.();
}

function pickOption(td, row, col, rows, save) {
  const current = valueOf(row, col);
  const chosen = new Set(Array.isArray(current) ? current : isEmpty(current) ? [] : [String(current)]);
  const seen = new Set();
  for (const r of rows) {
    const x = valueOf(r, col);
    (Array.isArray(x) ? x : isEmpty(x) ? [] : [String(x)]).forEach((s) => seen.add(s));
  }
  const multi = col.type === 'multi_select';
  const toggle = (val) => {
    if (!multi) return save(chosen.has(val) ? null : val);
    chosen.has(val) ? chosen.delete(val) : chosen.add(val);
    save([...chosen]);
  };
  listbox(td, {
    items: [...seen].sort().map((s) => ({ label: s, value: s, checked: chosen.has(s) })),
    placeholder: multi ? 'Add or remove options…' : 'Pick or create an option…',
    onPick: (it) => toggle(it.value),
    create: (q) => toggle(q),
    width: Math.max(240, td.offsetWidth),
  });
}
