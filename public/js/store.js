/**
 * App state in one object. Pages read from it and call the helpers below to change it; every
 * change calls `changed()`, which re-renders the current page on the next animation frame.
 */

import { api } from './api.js';
import { indexMeta } from './logic.js';

export const state = {
  boot: null,          // {settings, tables, secrets}
  t: null,             // the open table: {table, columns, rows, meta(Map), views, runs}
  ui: {},              // per-table view state: {view, search, filters, sort, selection, focus, rangeEnd, rowLimit}
};

const listeners = new Set();
let queued = false;
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export function changed() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; listeners.forEach((fn) => fn()); });
}

export const setting = (k, fallback) => state.boot?.settings?.[k] ?? fallback;

export async function loadBoot() {
  state.boot = await api.get('/bootstrap');
  applyTheme(); changed();
}

export async function loadTable(id) {
  const t = await api.get(`/tables/${id}`);
  t.meta = indexMeta(t.meta);
  state.t = t;
  if (!state.ui[id]) state.ui[id] = { view: 'all', search: '', filters: [], sort: null, selection: new Set(), focus: null, rangeEnd: null, rowLimit: null };
  changed();
  return t;
}

export const ui = () => (state.t ? state.ui[state.t.table.id] : null);

/* ---------------------------------------------------------------- local updates after a write */

export function putRow(row) {
  const rows = state.t.rows;
  const i = rows.findIndex((r) => r.id === row.id);
  if (i >= 0) rows[i] = row; else rows.push(row);
  changed();
}

export function putColumn(col) {
  const cols = state.t.columns;
  const i = cols.findIndex((c) => c.id === col.id);
  if (i >= 0) cols[i] = col; else cols.push(col);
  changed();
}

export function dropColumn(id) {
  const col = state.t.columns.find((c) => c.id === id);
  state.t.columns = state.t.columns.filter((c) => c.id !== id);
  if (col) for (const r of state.t.rows) delete r.data[col.key];
  changed();
}

export function setMeta(list) {
  for (const m of list) state.t.meta.set(`${m.row_id}:${m.column_id}`, m);
  changed();
}

export function refreshTableList() {
  return api.get('/bootstrap').then((b) => { state.boot = b; changed(); });
}

/* ---------------------------------------------------------------- theme */

export function applyTheme() {
  let t = localStorageGet('fc.theme') || setting('theme', 'system');
  if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
}

export function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
export function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* blocked */ } }
