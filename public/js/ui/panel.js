/**
 * The right-side panel. Clay configures columns in a side panel, never a modal, so the table stays
 * visible and usable while you set things up; this copies that. One panel at a time.
 */

import { h } from '../dom.js';
import { icon } from '../icons.js';

let open = null;

export const panelOpen = () => !!open;
export function closePanel() { open?.close(); }

export function openPanel({ title, body, footer, onClose, width }) {
  closePanel();
  const el = h('aside', { class: 'panel side-panel', role: 'complementary', 'aria-label': title });
  if (width) el.style.width = `min(${width}px, 100vw)`;
  const head = h('div', { class: 'panel-h' }, h('span', { class: 'grow ellipsis' }, title),
    h('button', { class: 'btn ghost icon sm', 'aria-label': 'Close panel', onClick: () => api.close() }, icon('x', 15)));
  const b = h('div', { class: 'panel-b' });
  const f = h('div', { class: 'panel-f' });
  el.append(head, b, f);
  let closed = false;
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.querySelector('.pop, .cell-editor, .modal-scrim')) return;
    e.stopPropagation(); api.close();
  };
  const api = {
    el, body: b, foot: f,
    setTitle: (t) => { head.firstChild.textContent = t; },
    close() {
      if (closed) return; closed = true;
      el.remove(); document.removeEventListener('keydown', onKey, true);
      if (open === api) open = null;
      document.body.classList.remove('has-panel');
      onClose?.();
    },
  };
  open = api;
  body?.(b, api);
  if (footer) footer(f, api); else f.remove();
  document.body.append(el);
  document.body.classList.add('has-panel');
  document.addEventListener('keydown', onKey, true);
  el.querySelector('input, textarea, select, [data-autofocus]')?.focus();
  return api;
}
