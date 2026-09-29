/**
 * Running columns from the browser: Run column / Re-run all / Run errored from the column menu,
 * Run on selected rows from the bulk bar, a budget and cost check before anything metered starts,
 * Stop, and the drain loop that moves the queue while the table is open (the cron moves it when
 * the table is closed).
 */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, changed, setMeta, setting } from '../store.js';
import { COMPUTED } from '../logic.js';
import { bottomHooks } from '../pages/table-bottom.js';
import { tableHooks } from '../pages/table.js';
import { popover, toast, menu } from '../ui/overlay.js';
import { fmtMicros } from '../types.js';

let draining = null;       // table id the loop is draining for
let since = null;          // server time of the last change poll

const runnable = (c) => COMPUTED.includes(c.kind);

/** Ask where the cap is, show the estimate, then queue. Free runs skip the question. */
export function startRun(anchor, col, scope, rowIds) {
  const t = state.t;
  const perCell = estimatePerCell(col);
  const go = async (budget) => {
    try {
      const r = await api.post(`/tables/${t.table.id}/run`, { column_id: col.id, scope, row_ids: rowIds, budget_micros: budget });
      if (!r.queued) return toast(scope === 'empty' ? 'Every row already has a value. Use “Re-run all rows” to run again.' : 'Nothing to run.');
      toast(`Queued ${r.queued.toLocaleString('en-US')} cell${r.queued === 1 ? '' : 's'}` + (r.est_micros ? `, up to ${fmtMicros(r.est_micros)}` : ''));
      drain(t.table.id);
    } catch (e) { toast(e.message, { error: true }); }
  };
  if (!perCell) return go(setting('default_budget_micros', 1_000_000));
  popover(anchor, (el, pop) => {
    const n = scope === 'selected' ? rowIds.length : scope === 'errored' ? countErrored(col) : scope === 'empty' ? countEmpty(col) : t.rows.length;
    const budget = h('input', { class: 'input', type: 'number', min: '0', step: '0.01', 'aria-label': 'Budget in dollars',
      value: (setting('default_budget_micros', 1_000_000) / 1e6).toFixed(2) });
    el.append(h('div', { class: 'pop-body' },
      h('b', null, `Run ${col.name}`),
      h('div', { class: 'muted' }, `Up to ${n.toLocaleString('en-US')} rows at ~${fmtMicros(perCell)} each: at most ${fmtMicros(perCell * n)}.`),
      h('label', { class: 'label' }, 'Stop when this run has spent ($)'), budget,
      h('div', { class: 'faint' }, 'Paid to your provider, on your key. The run stops before it would go over.')),
    h('div', { class: 'pop-foot' }, h('button', { class: 'btn', onClick: () => pop.close() }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: () => { const b = Math.round(Number(budget.value) * 1e6); pop.close(); go(Number.isFinite(b) && b >= 0 ? b : 0); } }, icon('play', 13), 'Run')));
  }, { width: 300 });
}

/** kind -> (col) => worst-case micro-dollars per cell. Each kind registers its own; the server re-checks. */
export const pricing = {};
const estimatePerCell = (col) => pricing[col.kind]?.(col) || 0;

const countEmpty = (col) => state.t.rows.filter((r) => r.data[col.key] === undefined || r.data[col.key] === null).length;
const countErrored = (col) => state.t.rows.filter((r) => state.t.meta.get(`${r.id}:${col.id}`)?.status === 'error').length;

/** Move the queue while this table is open, merging what changed after every batch. */
export async function drain(tableId) {
  if (draining === tableId) return;
  draining = tableId;
  since = since || new Date(Date.now() - 60_000).toISOString();
  let idle = 0;
  try {
    while (draining === tableId && state.t?.table.id === tableId) {
      const rep = await api.post('/run-batch');
      await pullChanges(tableId);
      if (!rep.remaining && !(state.t.runs || []).some((r) => r.status === 'running')) break;
      idle = rep.claimed ? 0 : idle + 1;
      // Nothing claimable (another drain has it, or it is waiting): back off instead of hammering.
      await new Promise((r) => setTimeout(r, idle ? Math.min(5000, 500 * idle) : 150));
    }
  } catch (e) { toast(e.message, { error: true }); }
  finally { if (draining === tableId) draining = null; tableHooks.afterRun.forEach((fn) => fn()); changed(); }
}

async function pullChanges(tableId) {
  const ch = await api.get(`/tables/${tableId}/changes?since=${encodeURIComponent(since)}`);
  since = ch.now;
  if (state.t?.table.id !== tableId) return;
  for (const row of ch.rows) {
    const i = state.t.rows.findIndex((r) => r.id === row.id);
    if (i >= 0) state.t.rows[i] = row; else state.t.rows.push(row);
  }
  setMeta(ch.meta);
  const byId = new Map((state.t.runs || []).map((r) => [r.id, r]));
  for (const r of ch.runs) {
    const before = byId.get(r.id);
    if (before?.status === 'running' && r.status === 'over_budget') toast(`${r.label}: stopped at its ${fmtMicros(r.budget_micros)} budget`, { error: true });
    byId.set(r.id, r);
  }
  state.t.runs = [...byId.values()];
  changed();
}

async function stopAll() {
  const running = (state.t.runs || []).filter((r) => r.status === 'running');
  for (const r of running) await api.post(`/runs/${r.id}/stop`).catch(() => {});
  draining = null;
  await pullChanges(state.t.table.id);
  toast('Stopped. Cells already running finish; the rest were cancelled.');
}

/* ---------------------------------------------------------------- hooks into the table page */

tableHooks.columnActions.push((c) => runnable(c) ? [
  { label: 'Run empty rows', icon: 'play', onSelect: () => startRun(document.querySelector(`th[data-k="${c.key}"]`), c, 'empty') },
  { label: 'Re-run all rows', icon: 'refresh', onSelect: () => startRun(document.querySelector(`th[data-k="${c.key}"]`), c, 'all') },
  { label: 'Run errored rows', icon: 'alert', onSelect: () => startRun(document.querySelector(`th[data-k="${c.key}"]`), c, 'errored') },
] : []);

tableHooks.bulk.push((ids) => {
  const cols = state.t.columns.filter(runnable);
  if (!cols.length) return null;
  return h('button', { class: 'btn sm', onClick: (e) => {
    const anchor = e.currentTarget;
    menu(anchor, cols.map((c) => ({ label: c.name, icon: 'play', onSelect: () => startRun(anchor, c, 'selected', ids) })));
  } }, icon('play', 13), 'Run');
});

bottomHooks.status.push(() => {
  const running = (state.t.runs || []).filter((r) => r.status === 'running');
  if (!running.length) return null;
  const left = [...state.t.meta.values()].filter((m) => m.status === 'queued' || m.status === 'running').length;
  return h('span', { class: 'running-chip' }, h('span', { class: 'st st-running' }),
    `${left.toLocaleString('en-US')} cell${left === 1 ? '' : 's'} running`,
    h('button', { class: 'tbtn', onClick: stopAll }, icon('stop', 12), 'Stop'));
});

// Opening a table with a run in progress picks the loop back up.
tableHooks.afterLoad.push(() => {
  if ((state.t.runs || []).some((r) => r.status === 'running')) { since = null; drain(state.t.table.id); }
});
