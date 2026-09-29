/**
 * Spreadsheet behaviour on a table: cell ranges, copy and paste as TSV (what Excel, Google Sheets
 * and Clay put on the clipboard), clearing a range, fill down, and undo/redo for all of them.
 * Every write goes through applyCells: one optimistic local update, then one PATCH rows/bulk call
 * per 2,000 rows (src/tables.js, patchRows), so a 5,000-cell paste is a few requests, not 5,000.
 */

import { api } from '../api.js';
import { state, ui, changed } from '../store.js';
import { toast, hasLayer } from '../ui/overlay.js';
import { isTyping } from '../dom.js';
import { rangeBounds, rangeTsv, parseTsv, pasteChanges } from '../range.js';

const MAX_UNDO = 50;
const CHUNK = 2000;   // MAX_BULK_ROWS in src/tables.js
let undoStack = []; let redoStack = []; let stackFor = null;

function stacks() {
  if (stackFor !== state.t?.table.id) { undoStack = []; redoStack = []; stackFor = state.t?.table.id; }
}

function setLocal(changes, side) {
  const byId = new Map(state.t.rows.map((r, i) => [r.id, i]));
  for (const ch of changes) {
    const i = byId.get(ch.id);
    if (i === undefined) continue;
    const data = { ...state.t.rows[i].data };
    const v = ch[side];
    if (v === null || v === undefined || v === '') delete data[ch.key]; else data[ch.key] = v;
    state.t.rows[i] = { ...state.t.rows[i], data };
  }
}

/** changes: [{id, key, before, after}]. Records one undo step unless record is false. */
export async function applyCells(changes, { record = true, label } = {}) {
  changes = changes.filter((ch) => ch.before !== ch.after);
  if (!changes.length) return;
  stacks();
  const tid = state.t.table.id;
  setLocal(changes, 'after'); changed();
  const byRow = new Map();
  for (const ch of changes) {
    if (!byRow.has(ch.id)) byRow.set(ch.id, {});
    byRow.get(ch.id)[ch.key] = ch.after === '' || ch.after === undefined ? null : ch.after;
  }
  const list = [...byRow].map(([id, data]) => ({ id, data }));
  try {
    for (let i = 0; i < list.length; i += CHUNK) {
      const res = await api.patch(`/tables/${tid}/rows/bulk`, { rows: list.slice(i, i + CHUNK) });
      if (state.t?.table.id !== tid) return;
      // The server's copy wins: it has the typed values (a pasted "12" becomes the number 12).
      const byId = new Map(state.t.rows.map((r, j) => [r.id, j]));
      for (const r of res.rows) { const j = byId.get(r.id); if (j !== undefined) state.t.rows[j] = r; }
    }
    if (record) {
      undoStack.push({ changes, label }); if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack = [];
    }
    changed();
  } catch (e) {
    if (state.t?.table.id === tid) { setLocal(changes, 'before'); changed(); }
    toast(e.message, { error: true });
    throw e;
  }
}

export async function undo() {
  stacks();
  const step = undoStack.pop();
  if (!step) return toast('Nothing to undo.');
  try {
    await applyCells(step.changes.map((c) => ({ ...c, before: c.after, after: c.before })), { record: false });
    redoStack.push(step);
  } catch { undoStack.push(step); }
}

export async function redo() {
  stacks();
  const step = redoStack.pop();
  if (!step) return toast('Nothing to redo.');
  try {
    await applyCells(step.changes, { record: false });
    undoStack.push(step);
  } catch { redoStack.push(step); }
}

/* ---------------------------------------------------------------- clipboard */

let view = null;   // {rows, cols}: set by the table page on every render
export function setView(v) { view = v; }
export { rangeBounds, clearChanges, fillChanges } from '../range.js';

function active(e) {
  return view && state.t && ui()?.focus && document.querySelector('.grid') && !isTyping(e) && !hasLayer() && !getSelection()?.toString();
}

document.addEventListener('copy', (e) => {
  if (!active(e)) return;
  const b = rangeBounds(view.rows, view.cols, ui());
  if (!b) return;
  e.clipboardData.setData('text/plain', rangeTsv(view.rows, view.cols, b));
  e.preventDefault();
  const n = (b.r1 - b.r0 + 1) * (b.c1 - b.c0 + 1);
  if (n > 1) toast(`Copied ${n.toLocaleString('en-US')} cells.`);
});

document.addEventListener('paste', async (e) => {
  if (!active(e)) return;
  const text = e.clipboardData.getData('text/plain');
  if (!text) return;
  e.preventDefault();
  const b = rangeBounds(view.rows, view.cols, ui());
  if (!b) return;
  const { changes, dropped } = pasteChanges(view.rows, view.cols, b, parseTsv(text));
  try {
    await applyCells(changes, { label: 'paste' });
    if (dropped) toast(`${dropped.toLocaleString('en-US')} cells did not fit past the last row or column. Add rows first, then paste again.`);
  } catch { /* applyCells already said why */ }
});
