/**
 * Cell-range logic for the table grid, kept free of the DOM so node --test can check it:
 * range bounds, TSV in and out, and what a paste, a clear or a fill down would write.
 * pages/table-ops.js does the writing and the clipboard events.
 */

import { valueOf } from './logic.js';

const writable = (c) => c.kind !== 'formula';

/** Row and column index bounds of the selected range (focus to rangeEnd), in view order. */
export function rangeBounds(rows, cols, u) {
  if (!u?.focus) return null;
  const end = u.rangeEnd || u.focus;
  const ri = (id) => rows.findIndex((r) => r.id === id);
  const ci = (k) => cols.findIndex((c) => c.key === k);
  const a = [ri(u.focus.row), ci(u.focus.col)]; const b = [ri(end.row), ci(end.col)];
  if (a[0] < 0 || a[1] < 0) return null;
  if (b[0] < 0 || b[1] < 0) return { r0: a[0], r1: a[0], c0: a[1], c1: a[1] };
  return { r0: Math.min(a[0], b[0]), r1: Math.max(a[0], b[0]), c0: Math.min(a[1], b[1]), c1: Math.max(a[1], b[1]) };
}

const cellText = (v) => {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};
const tsvCell = (s) => (/[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function rangeTsv(rows, cols, b) {
  const lines = [];
  for (let r = b.r0; r <= b.r1; r++) {
    lines.push(cols.slice(b.c0, b.c1 + 1).map((c) => tsvCell(cellText(valueOf(rows[r], c)))).join('\t'));
  }
  return lines.join('\n');
}

/** Tab-separated text to a grid of strings. Quoted fields may hold tabs, newlines and "". */
export function parseTsv(text) {
  const out = []; let row = []; let cell = ''; let q = false;
  text = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); out.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out;
}

/**
 * What a paste writes. One copied value into a bigger selection fills the whole selection, as in
 * a spreadsheet; otherwise the copied block lands at the selection's top-left corner. Cells past
 * the last row or column are dropped (and counted), formula columns are skipped.
 */
export function pasteChanges(rows, cols, b, grid) {
  const changes = []; let dropped = 0;
  const one = grid.length === 1 && grid[0].length === 1;
  const h = one ? b.r1 - b.r0 + 1 : grid.length;
  const w = one ? b.c1 - b.c0 + 1 : Math.max(...grid.map((r) => r.length));
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      const text = one ? grid[0][0] : grid[i]?.[j];
      if (text === undefined) continue;
      const row = rows[b.r0 + i]; const col = cols[b.c0 + j];
      if (!row || !col) { dropped++; continue; }
      if (!writable(col)) continue;
      changes.push({ id: row.id, key: col.key, before: row.data[col.key] ?? null, after: text === '' ? null : text });
    }
  }
  return { changes, dropped };
}

export function clearChanges(rows, cols, b) {
  const changes = [];
  for (let r = b.r0; r <= b.r1; r++) for (let c = b.c0; c <= b.c1; c++) {
    const row = rows[r]; const col = cols[c];
    if (writable(col) && row.data[col.key] !== undefined && row.data[col.key] !== null) changes.push({ id: row.id, key: col.key, before: row.data[col.key], after: null });
  }
  return changes;
}

/** Fill down: the top row of the range is copied into every row below it, column by column. */
export function fillChanges(rows, cols, b) {
  const changes = [];
  for (let c = b.c0; c <= b.c1; c++) {
    const col = cols[c];
    if (!writable(col)) continue;
    const v = rows[b.r0].data[col.key] ?? null;
    for (let r = b.r0 + 1; r <= b.r1; r++) changes.push({ id: rows[r].id, key: col.key, before: rows[r].data[col.key] ?? null, after: v });
  }
  return changes;
}

