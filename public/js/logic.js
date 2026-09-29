/**
 * Pure functions behind the grid: filters, search, sort, the fill-rate row and the built-in views
 * (All rows, Errored, Fully enriched). Adapted from the CRM's logic.js. No DOM here.
 *
 * Filtering runs in the browser on purpose: an enrichment table holds thousands of rows, not
 * millions, and client-side filtering answers on every keystroke with no round trip.
 */

import { isEmpty, displayText, invalid } from './types.js';

export const COMPUTED = ['enrich', 'waterfall', 'ai', 'http', 'message'];

export const valueOf = (row, col) => row?.data?.[col.key] ?? null;

/* ---------------------------------------------------------------- filters */

export const OPERATORS = {
  text: [['contains', 'contains'], ['not_contains', 'does not contain'], ['is', 'is'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  number: [['eq', '='], ['gt', '>'], ['lt', '<'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  date: [['before', 'is before'], ['after', 'is after'], ['is', 'is'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
  checkbox: [['checked', 'is checked'], ['unchecked', 'is not checked']],
  status: [['status_error', 'errored'], ['status_done', 'has a result'], ['status_none', 'has no result'], ['status_empty', 'not run yet']],
};

export function operatorGroup(type) {
  if (['number', 'currency'].includes(type)) return 'number';
  if (type === 'date') return 'date';
  if (type === 'checkbox') return 'checkbox';
  return 'text';
}

export const NO_VALUE_OPS = ['empty', 'not_empty', 'checked', 'unchecked', 'status_error', 'status_done', 'status_none', 'status_empty'];

/** meta: Map "rowId:colId" -> {status,...}; only status filters need it. */
export function matchFilter(row, filter, col, meta) {
  const raw = valueOf(row, col);
  const empty = isEmpty(raw);
  const { op } = filter;
  if (op.startsWith('status_')) {
    const st = meta?.get(`${row.id}:${col.id}`)?.status || 'empty';
    if (op === 'status_error') return st === 'error';
    if (op === 'status_done') return st === 'done';
    if (op === 'status_none') return st === 'no_result';
    return st === 'empty';
  }
  if (op === 'empty') return empty;
  if (op === 'not_empty') return !empty;
  if (op === 'checked') return raw === true;
  if (op === 'unchecked') return raw !== true;
  const val = filter.value;
  if (val === undefined || val === null || val === '') return true; // an unfinished chip filters nothing
  const group = operatorGroup(col.type);
  if (group === 'number') {
    if (typeof raw !== 'number') return false;
    const want = Number(val);
    return op === 'eq' ? raw === want : op === 'gt' ? raw > want : op === 'lt' ? raw < want : true;
  }
  if (group === 'date') {
    if (empty) return false;
    const have = String(raw).slice(0, 10);
    return op === 'before' ? have < val : op === 'after' ? have > val : have === val;
  }
  const text = displayText(col.type, raw).toLowerCase();
  const needle = String(val).toLowerCase();
  if (op === 'contains') return text.includes(needle);
  if (op === 'not_contains') return !text.includes(needle);
  if (op === 'is') return text === needle;
  return true;
}

export function applyFilters(rows, filters = [], cols = [], meta) {
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const active = filters.filter((f) => byKey.has(f.col));
  if (!active.length) return rows;
  return rows.filter((r) => active.every((f) => matchFilter(r, f, byKey.get(f.col), meta)));
}

export function searchRows(rows, q, cols) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) => cols.some((c) => displayText(c.type, valueOf(r, c)).toLowerCase().includes(needle)));
}

/* ---------------------------------------------------------------- sort */

export function sortRows(rows, sort, cols) {
  if (!sort || !sort.col) return rows;
  const col = cols.find((c) => c.key === sort.col);
  if (!col) return rows;
  const dir = sort.dir === 'desc' ? -1 : 1;
  const key = (r) => {
    const v = valueOf(r, col);
    if (isEmpty(v)) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return displayText(col.type, v).toLowerCase();
  };
  // Empty values always sink to the bottom, whichever way the column is sorted.
  return [...rows].sort((a, b) => {
    const x = key(a); const y = key(b);
    if (x === null && y === null) return a.id - b.id;
    if (x === null) return 1;
    if (y === null) return -1;
    if (typeof x !== typeof y) return typeof x === 'number' ? -1 : 1;   // text in a number column sinks too
    return (x < y ? -1 : x > y ? 1 : a.id - b.id) * dir;
  });
}

/* ---------------------------------------------------------------- fill rate and views */

/** Clay's "%" row: share of rows where the column holds a valid value. Whole percent. */
export function fillRate(rows, col) {
  if (!rows.length) return 0;
  const filled = rows.filter((r) => { const v = valueOf(r, col); return !isEmpty(v) && v !== false && !invalid(col.type, v); }).length;
  return Math.round((filled / rows.length) * 100);
}

/**
 * The three views every table has without saving anything:
 *   all      every row
 *   errored  any computed cell on the row ended in error
 *   enriched every computed column on the row holds a value
 */
export function builtInView(name, rows, cols, meta) {
  const computed = cols.filter((c) => COMPUTED.includes(c.kind));
  if (name === 'errored') return rows.filter((r) => computed.some((c) => meta.get(`${r.id}:${c.id}`)?.status === 'error'));
  if (name === 'enriched') return computed.length ? rows.filter((r) => computed.every((c) => !isEmpty(valueOf(r, c)))) : rows;
  return rows;
}

/** Index cells_meta rows as "rowId:colId" -> meta, the shape every function above expects. */
export const indexMeta = (list) => new Map((list || []).map((m) => [`${m.row_id}:${m.column_id}`, m]));
