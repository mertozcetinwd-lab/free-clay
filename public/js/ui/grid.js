/**
 * The grid: sticky first column, typed headers, click to focus a cell, Enter or typing to edit,
 * arrows and Tab to move, Delete to clear, row checkboxes with shift-click ranges, drag to resize,
 * and Clay's "%" fill-rate row at the bottom. Adapted from the CRM's views/table.js.
 *
 * Rows are virtualised: only the rows in view (plus OVERSCAN either side) are in the DOM, with two
 * spacer rows holding the scroll height, so a 20,000-row table scrolls like a 50-row one. Cell
 * ranges (drag, shift-click, shift-arrows) and the fill handle live in ui().focus / ui().rangeEnd;
 * what they do is in pages/table-ops.js.
 */

import { h } from '../dom.js';
import { icon, typeIcon } from '../icons.js';
import { valueOf, fillRate, COMPUTED } from '../logic.js';
import { isEmpty } from '../types.js';
import { valueNode, statusNode } from './values.js';

export const DEFAULT_WIDTH = 200;   // Clay's default column width, measured in the teardown
const widthOf = (c) => c.width || (c.type === 'checkbox' ? 110 : DEFAULT_WIDTH);
const NUMERIC = ['number', 'currency'];

let lastChecked = null;
let rowH = 36;            // measured after each render; 35px row + 1px border in Clay
const HEAD_H = 36;        // header row, what sits above the first body row inside the scroller
const OVERSCAN = 12;

/** Which slice of rows to draw at scroll position st. */
function windowFor(st, vh, total) {
  const top = Math.max(0, st - HEAD_H);
  const first = Math.floor(top / rowH); const last = Math.ceil((top + vh) / rowH);
  return { start: Math.max(0, first - OVERSCAN), end: Math.min(total, last + OVERSCAN), first, last };
}

export function renderGrid(root, o) {
  const { cols, rows, meta, ui } = o;
  const sel = ui.selection;
  // The page redraw empties the scroller before this runs, so reading scrollTop now would read 0
  // (the browser clamps it). The caller reads it before the redraw and passes it in o.scroll.
  const scroller = root.closest('.content');
  let st = o.scroll?.top || 0; const vh = o.scroll?.height || 900;
  const index = new Map(rows.map((r, i) => [r.id, i]));
  // A keyboard move to a row outside the drawn window scrolls there first (moveFocus sets _reveal).
  if (ui._reveal && ui.focus) {
    const i = index.get(ui.focus.row);
    if (i !== undefined) {
      const y = HEAD_H + i * rowH;
      if (y - HEAD_H < st) st = y - HEAD_H;
      else if (y + rowH > st + vh - 40) st = y + rowH - vh + 40;
    }
    ui._reveal = false;
  }
  const win = windowFor(st, vh, rows.length);
  const shown = rows.slice(win.start, win.end);
  const b = o.range;   // {r0, r1, c0, c1} or null
  const inRange = (ri, ci) => b && ri >= b.r0 && ri <= b.r1 && ci >= b.c0 && ci <= b.c1;
  const multi = b && (b.r1 > b.r0 || b.c1 > b.c0);

  const colgroup = h('colgroup', null, h('col', { style: { width: '40px' } }),
    cols.map((c) => h('col', { 'data-k': c.key, style: { width: widthOf(c) + 'px' } })), h('col', { style: { width: '44px' } }), h('col'));

  // Frozen columns: the first column always, plus any pinned ones (the page puts them first).
  // Each sticks at the checkbox width plus the widths of the frozen columns before it.
  const lefts = []; let x = 40;
  cols.forEach((c, i) => { if (i === 0 || c.pinned) { lefts[i] = x; x += widthOf(c); } });
  const frozen = (i) => (lefts[i] !== undefined ? { left: lefts[i] + 'px' } : null);
  const lastFrozen = lefts.length - 1;

  /* ---------- header */
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const headCheck = h('button', {
    class: 'check', role: 'checkbox', 'aria-checked': allOn ? 'true' : 'false', 'aria-label': 'Select all rows',
    onClick: () => { rows.forEach((r) => (allOn ? sel.delete(r.id) : sel.add(r.id))); o.onSelection(); },
  }, allOn ? icon('check', 12, 2.5) : null);

  const header = (c, i) => {
    const sorted = ui.sort && ui.sort.col === c.key ? ui.sort.dir : null;
    return h('th', { class: [lefts[i] !== undefined && 'c-primary', i === lastFrozen && 'frozen-edge', NUMERIC.includes(c.type) && 'num', c.color && 'colored'],
      scope: 'col', 'data-k': c.key, 'data-c': c.color || null, style: frozen(i), title: c.description || null },
      h('div', {
        class: 'th', role: 'button', tabIndex: 0, title: c.name,
        onClick: (e) => columnMenu(e.currentTarget, c),
        onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); columnMenu(e.currentTarget, c); } },
      }, h('span', { class: ['th-ic', COMPUTED.includes(c.kind) && 'computed'] }, icon(typeIcon(c.type, c.kind), 14)),
      h('span', { class: 'ellipsis' }, c.name),
      sorted ? h('span', { class: 'sort-ind' }, icon(sorted === 'asc' ? 'arrow-up' : 'arrow-down', 12, 2)) : null),
      h('span', { class: 'resize', onPointerdown: (e) => startResize(e, c) }));
  };

  const columnMenu = (anchor, c) => o.columnMenu(anchor, c);

  const startResize = (e, c) => {
    e.preventDefault(); e.stopPropagation();
    const colEl = colgroup.querySelector(`col[data-k="${c.key}"]`);
    const startX = e.clientX; const startW = widthOf(c);
    const handle = e.currentTarget; handle.classList.add('on');
    let w = startW;
    const table = colgroup.parentElement; const startTotal = table.offsetWidth;
    const move = (ev) => { w = Math.max(60, Math.min(800, startW + ev.clientX - startX)); colEl.style.width = w + 'px'; table.style.width = (startTotal + w - startW) + 'px'; };
    const up = () => {
      handle.classList.remove('on');
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (w !== startW) o.onResize(c, w);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const thead = h('thead', null, h('tr', null,
    h('th', { class: 'c-check' }, headCheck),
    cols.map(header),
    h('th', { class: 'c-add' }, h('button', { 'aria-label': 'Add column', title: 'Add column', onClick: (e) => o.onAddColumn(e.currentTarget) }, icon('plus', 16))),
    h('th', { class: 'c-fill' })));

  /* ---------- body */
  const cell = (r, c, ci, ri) => {
    const v = valueOf(r, c);
    const m = COMPUTED.includes(c.kind) ? meta.get(`${r.id}:${c.id}`) : null;
    const focused = ui.focus && ui.focus.row === r.id && ui.focus.col === c.key;
    let content = valueNode(c, v);
    if (m && isEmpty(v) && m.status === 'no_result') content = h('span', { class: 'faint' }, 'No result');
    if (m && isEmpty(v) && m.status === 'skipped') content = h('span', { class: 'faint', title: m.error || '' }, 'Skipped');
    if (m && isEmpty(v) && m.status === 'no_result' && m.error) content = h('span', { class: 'faint', title: m.error }, 'No result');
    const ferr = c.kind === 'formula' ? r.data._errors?.[c.key] : null;
    if (ferr) content = h('span', { class: 'bad', title: ferr }, '#ERROR');
    const ranged = multi && inRange(ri, ci);
    // The fill handle sits on the bottom-right cell of the selection.
    const handle = b && ri === b.r1 && ci === b.c1 && c.kind !== 'formula'
      ? h('span', { class: 'fill-handle', title: 'Drag down to fill', onPointerdown: (e) => startDrag(e, 'fill') }) : null;
    return h('td', {
      style: frozen(ci),
      class: [lefts[ci] !== undefined && 'c-primary', ci === lastFrozen && 'frozen-edge', NUMERIC.includes(c.type) && 'num', focused && 'focus', ranged && 'in-range',
        ranged && ri === b.r0 && 'rt', ranged && ri === b.r1 && 'rb', ranged && ci === b.c0 && 'rl', ranged && ci === b.c1 && 'rr',
        c.kind !== 'formula' && 'editable'],
      'data-r': r.id, 'data-k': c.key,
      onPointerdown: (e) => {
        if (e.button !== 0 || e.target.closest('.check, .row-expand, .fill-handle, a')) return;
        if (e.shiftKey && ui.focus) { e.preventDefault(); o.onRange({ row: r.id, col: c.key }); return; }
        o.onFocus({ row: r.id, col: c.key });
        startDrag(e, 'select');
      },
      onClick: (e) => {
        if (c.type === 'checkbox' && c.kind === 'data' && e.target.closest('.check')) return o.onEditCell(r, c, !v);
      },
      onDblclick: () => o.onStartEdit(r, c),
    }, h('div', { class: 'cv' }, statusNode(m), content),
      ci === 0 ? h('button', { class: 'row-expand', 'aria-label': 'Open row', title: 'Open row', onClick: () => o.onExpand(r) }, icon('maximize', 13)) : null,
      handle);
  };

  /** Drag to select a range, or drag the fill handle down. Tracks the cell under the pointer. */
  const startDrag = (e, mode) => {
    if (mode === 'fill') { e.preventDefault(); e.stopPropagation(); }
    const at = (ev) => document.elementFromPoint(ev.clientX, ev.clientY)?.closest('td[data-r][data-k]');
    let moved = false;
    const move = (ev) => {
      const td = at(ev); if (!td) return;
      const row = Number(td.dataset.r);
      if (mode === 'select') {
        if (!moved && row === ui.focus?.row && td.dataset.k === ui.focus?.col) return;
        moved = true; o.onRange({ row, col: td.dataset.k });
      } else { moved = true; o.onFillTo(row); }
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      if (mode === 'fill' && moved) o.onFill();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const spacer = (px) => (px > 0 ? h('tr', { class: 'spacer', 'aria-hidden': 'true' }, h('td', { colspan: cols.length + 3, style: { height: px + 'px' } })) : null);
  const tbody = h('tbody', null, spacer(win.start * rowH), shown.map((r, k) => {
    const ri = win.start + k;
    return h('tr', { class: sel.has(r.id) && 'selected', 'data-r': r.id, 'aria-rowindex': ri + 2 },
      h('td', { class: 'c-check' }, h('button', {
        class: 'check', role: 'checkbox', 'aria-checked': sel.has(r.id) ? 'true' : 'false', 'aria-label': 'Select row',
        onClick: (e) => {
          const ids = rows.map((x) => x.id);
          if (e.shiftKey && lastChecked !== null && index.has(lastChecked)) {
            const [a1, b1] = [index.get(lastChecked), ri].sort((x, y) => x - y);
            const on = !sel.has(r.id);
            ids.slice(a1, b1 + 1).forEach((id) => (on ? sel.add(id) : sel.delete(id)));
          } else if (sel.has(r.id)) sel.delete(r.id); else sel.add(r.id);
          lastChecked = r.id; o.onSelection();
        },
      }, sel.has(r.id) ? icon('check', 12, 2.5) : null)),
      cols.map((c, ci) => cell(r, c, ci, ri)), h('td'), h('td', { class: 'c-fill' }));
  }), spacer((rows.length - win.end) * rowH),
  h('tr', { class: 'addrow' }, h('td', { class: 'c-check' }, icon('plus', 14)),
    h('td', { colspan: cols.length + 2 },
      h('button', { class: 'addrow-btn', onClick: () => o.onAddRow() }, 'New row'),
      h('span', { class: 'faint' }, ' or '),
      h('button', { class: 'addrow-btn', onClick: () => o.onAddRows(10) }, 'add 10 more rows'))));

  /* ---------- the "%" row: how full each column is, over the rows in view */
  const tfoot = h('tfoot', null, h('tr', null, h('td', { class: 'c-check', title: 'Fill rate' }, '%'),
    cols.map((c, i) => {
      const pct = fillRate(rows, c);
      return h('td', { class: [lefts[i] !== undefined && 'c-primary', i === lastFrozen && 'frozen-edge', 'fill'], style: frozen(i) }, h('div', { class: 'fillbar' },
        h('span', { style: { width: pct + '%' } })), h('b', { class: 'num' }, pct + '%'));
    }), h('td'), h('td', { class: 'c-fill' })));

  // An explicit width is what makes table-layout: fixed honour the <col> widths. With width:auto
  // the browser falls back to automatic layout and squeezes the checkbox column to its content.
  const total = 40 + cols.reduce((a, c) => a + widthOf(c), 0) + 44;
  const table = h('table', { class: 'grid', role: 'grid', 'aria-rowcount': rows.length + 1, style: { width: total + 'px' } }, colgroup, thead, tbody, tfoot);
  root.append(table);
  if (scroller) { scroller.scrollTop = st; if (o.scroll) scroller.scrollLeft = o.scroll.left; }
  const firstRow = tbody.querySelector('tr[data-r]');
  if (firstRow && firstRow.offsetHeight) rowH = firstRow.offsetHeight;

  // Redraw when scrolling leaves the drawn window. One listener per scroller; it asks the grid
  // drawn last (a new render replaces _gridCheck), and does nothing once the grid is gone.
  if (scroller) {
    scroller._gridCheck = () => {
      if (!table.isConnected) return;
      const w = windowFor(scroller.scrollTop, scroller.clientHeight, rows.length);
      if (w.first < win.start || Math.min(w.last, rows.length) > win.end) o.onWindow();
    };
    if (!scroller._gridListening) {
      let queued = false;
      scroller.addEventListener('scroll', () => {
        if (queued) return; queued = true;
        requestAnimationFrame(() => { queued = false; scroller._gridCheck?.(); });
      }, { passive: true });
      scroller._gridListening = true;
    }
  }
  return table;
}

/** Scroll a focused cell into view (after a keyboard move). */
export function revealFocus(root) {
  root.querySelector('td.focus')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
