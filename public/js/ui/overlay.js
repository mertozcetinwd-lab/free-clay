/**
 * Everything that floats: popovers, keyboard-driven list pickers, modals, toasts and confirms.
 * One popover is open at a time; Escape closes the top-most layer first.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';

let current = null;

export function closePopover() { if (current) current.close(); }
export const hasLayer = () => !!document.querySelector('.pop, .modal-scrim, .cell-editor');

/** Place `el` next to an element or a rect, flipping above when there is no room below. */
export function place(el, anchor, { align = 'start', gap = 4, width } = {}) {
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  if (width) el.style.width = (width === 'anchor' ? Math.max(r.width, 220) : width) + 'px';
  const vw = window.innerWidth; const vh = window.innerHeight;
  const w = el.offsetWidth; const hgt = el.offsetHeight;
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, vw - w - 8));
  let top = r.bottom + gap;
  if (top + hgt > vh - 8 && r.top - gap - hgt > 8) { top = r.top - gap - hgt; el.classList.add('up'); }
  el.style.left = left + 'px';
  el.style.top = Math.max(8, Math.min(top, vh - hgt - 8)) + 'px';
}

export function popover(anchor, build, opts = {}) {
  closePopover();
  const el = h('div', { class: 'pop', role: 'dialog' });
  document.body.append(el);
  let closed = false;
  const onDown = (e) => { if (!el.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); if (anchor instanceof Element) anchor.focus?.(); } };
  const onScroll = (e) => { if (!el.contains(e.target)) close(); };
  function close() {
    if (closed) return; closed = true;
    el.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', close);
    if (current && current.el === el) current = null;
    opts.onClose?.();
  }
  const api = { el, close, reposition: () => place(el, anchor, opts) };
  current = api;
  build(el, api);
  place(el, anchor, opts);
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
  });
  document.addEventListener('keydown', onKey, true);
  return api;
}

/**
 * A searchable, keyboard-driven list (↑ ↓ Enter). Items: {label, value, icon, lead (node), hint,
 * sub, danger, checked, group, onSelect}. `create(q)` adds a "Create “q”" row when nothing matches.
 */
export function listbox(anchor, { items, search = true, placeholder = 'Search…', onPick, create, width = 260, empty = 'No matches', align, keepOpen, onClose } = {}) {
  return popover(anchor, (el, pop) => {
    let q = ''; let hl = 0; let visible = [];
    const input = search ? h('input', { placeholder, 'aria-label': placeholder }) : null;
    const list = h('div', { role: 'listbox' });
    if (input) el.append(h('div', { class: 'pop-search' }, icon('search', 14), input));
    el.append(list);
    const pick = (it) => {
      if (!keepOpen) pop.close();
      if (it.onSelect) it.onSelect(); else onPick?.(it);
      if (keepOpen) render();   // a toggle list redraws its ticks in place
    };
    const render = () => {
      const needle = q.trim().toLowerCase();
      visible = items.filter((it) => it.sep || it.group || !needle || String(it.label).toLowerCase().includes(needle) || String(it.sub || '').toLowerCase().includes(needle));
      if (needle) visible = visible.filter((it) => !it.sep && !it.group);
      if (create && needle && !visible.some((it) => String(it.label).toLowerCase() === needle)) {
        visible.push({ label: `Create “${q.trim()}”`, icon: 'plus', onSelect: () => create(q.trim()) });
      }
      const selectable = visible.filter((it) => !it.sep && !it.group);
      hl = Math.min(hl, Math.max(0, selectable.length - 1));
      let idx = -1;
      mount(list, visible.length ? visible.map((it) => {
        if (it.sep) return h('div', { class: 'pop-sep' });
        if (it.group) return h('div', { class: 'pop-label' }, it.group);
        idx++;
        const i = idx;
        return h('button', {
          class: ['pop-item', i === hl && 'hl', it.danger && 'danger'], role: 'option', 'aria-selected': i === hl ? 'true' : 'false',
          'aria-checked': it.checked ? 'true' : 'false', type: 'button',
          onMousemove: () => { if (hl !== i) { hl = i; highlight(); } },
          onClick: () => pick(it),
        },
        it.lead || (it.icon ? h('span', { class: 'ic' }, icon(it.icon, 15)) : null),
        h('span', { class: 'ellipsis', style: { flex: '0 1 auto' } }, it.label),
        it.sub ? h('span', { class: 'faint ellipsis', style: { fontSize: 'var(--fs-sm)', flex: '1 1 0' } }, it.sub) : null,
        it.hint ? h('span', { class: 'hint' }, it.hint) : null,
        it.checked !== undefined ? h('span', { class: 'tick' }, icon('check', 14)) : null);
      }) : h('div', { class: 'pop-empty' }, empty));
    };
    const highlight = () => {
      [...list.querySelectorAll('.pop-item')].forEach((b, i) => { b.classList.toggle('hl', i === hl); b.setAttribute('aria-selected', i === hl ? 'true' : 'false'); });
      list.querySelectorAll('.pop-item')[hl]?.scrollIntoView({ block: 'nearest' });
    };
    const onKey = (e) => {
      const selectable = visible.filter((it) => !it.sep && !it.group);
      if (e.key === 'ArrowDown') { e.preventDefault(); hl = (hl + 1) % Math.max(1, selectable.length); highlight(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hl = (hl - 1 + selectable.length) % Math.max(1, selectable.length); highlight(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (selectable[hl]) pick(selectable[hl]); }
    };
    (input || el).addEventListener('keydown', onKey);
    if (input) input.addEventListener('input', () => { q = input.value; hl = 0; render(); pop.reposition(); });
    else el.tabIndex = -1;
    render();
    (input || el).focus();
  }, { width, align, onClose });
}

/** A plain action menu (no search). */
export const menu = (anchor, items, opts = {}) => listbox(anchor, { items, search: false, width: 220, ...opts });

/* ---------------------------------------------------------------- modal */

export function modal({ title, body, footer, width, className, onClose, initialFocus = true }) {
  closePopover();
  const card = h('div', { class: ['modal', className], role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' });
  if (width) card.style.width = `min(${width}px, 100%)`;
  const scrim = h('div', { class: 'modal-scrim', onPointerdown: (e) => { if (e.target === scrim) close(); } }, card);
  let closed = false;
  const prevFocus = document.activeElement;
  const onKey = (e) => {
    if (e.key !== 'Escape' || document.querySelector('.pop')) return;
    e.stopPropagation(); close();
  };
  function close() {
    if (closed) return; closed = true;
    scrim.remove(); document.removeEventListener('keydown', onKey, true);
    onClose?.(); prevFocus?.focus?.();
  }
  const api = { el: card, close };
  if (title) card.append(h('div', { class: 'modal-h' }, h('span', { class: 'grow' }, title),
    h('button', { class: 'btn ghost icon sm', 'aria-label': 'Close', onClick: close }, icon('x', 15))));
  const b = h('div', { class: 'modal-b' }); card.append(b); body?.(b, api);
  if (footer) { const f = h('div', { class: 'modal-f' }); card.append(f); footer(f, api); }
  document.body.append(scrim);
  document.addEventListener('keydown', onKey, true);
  if (initialFocus) card.querySelector('input, textarea, select, [data-autofocus]')?.focus();
  return api;
}

export function confirmDialog({ title, text, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    modal({
      title, width: 420,
      body: (b) => b.append(h('p', { style: { margin: 0, color: 'var(--ink-2)' } }, text)),
      footer: (f, m) => {
        const ok = h('button', { class: ['btn', danger ? 'danger solid' : 'primary'], 'data-autofocus': true, onClick: () => { answered = true; m.close(); resolve(true); } }, confirmLabel);
        f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'), ok);
      },
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

/* ---------------------------------------------------------------- toast */

let toastRoot = null;
export function toast(message, { action, onAction, error = false, duration = 5000 } = {}) {
  if (!toastRoot) { toastRoot = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastRoot); }
  const el = h('div', { class: ['toast', error && 'error'] }, h('span', { class: 'grow' }, message));
  let timer;
  const dismiss = () => { clearTimeout(timer); el.classList.add('out'); setTimeout(() => el.remove(), 160); };
  if (action) el.append(h('button', { class: 'btn sm', onClick: () => { dismiss(); onAction?.(); } }, action));
  el.append(h('button', { class: 'btn ghost icon sm', 'aria-label': 'Dismiss', style: { color: 'inherit' }, onClick: dismiss }, icon('x', 14)));
  toastRoot.append(el);
  while (toastRoot.children.length > 3) toastRoot.firstChild.remove();
  timer = setTimeout(dismiss, error ? 7000 : duration);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 2500); });
}
