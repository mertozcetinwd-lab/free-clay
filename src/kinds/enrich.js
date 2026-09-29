/**
 * Enrichment column: one function, an input mapping, output fields, a run condition.
 *
 * config = {
 *   fn: 'domain_alive',
 *   inputs: { domain: '{{website}}' },          // each function input is a template over the row
 *   outputs: [{ field: 'ips', column: 'ips' }],  // extra result fields written into data columns
 *   condition: '',                               // formula; the cell runs only when it is true
 *   auto: false,                                 // re-run when inputs change (if auto-run is on)
 * }
 */

import { fail } from '../util.js';
import { CONFIG_CHECKS } from '../tables.js';
import { EXECUTORS } from '../runner.js';
import { getFunction, costOf } from '../functions/index.js';
import { fill } from '../../public/js/template.js';
import { isEmpty } from '../../public/js/types.js';

/** Formula support registers here (src/kinds/formula.js); until then a condition always passes. */
export const conditions = { test: (expr, data, cols) => true, check: (expr) => null };

export function checkOutputs(outputs) {
  if (outputs === undefined) return;
  if (!Array.isArray(outputs) || outputs.length > 30) fail(400, 'outputs must be a list (up to 30)');
  for (const o of outputs) {
    if (!o || typeof o.field !== 'string' || typeof o.column !== 'string' || !/^[a-z0-9_]{1,40}$/.test(o.column)) fail(400, 'Each output needs a field and a column key');
  }
}

export function checkInputs(fn, inputs) {
  if (inputs !== undefined && (typeof inputs !== 'object' || Array.isArray(inputs) || inputs === null)) fail(400, 'inputs must be an object');
  for (const i of fn.inputs) if (i.required && !String(inputs?.[i.key] ?? '').trim()) fail(400, `${fn.name} needs “${i.label}”`);
}

CONFIG_CHECKS.enrich = (cfg) => {
  const fn = getFunction(cfg.fn);
  if (!fn) fail(400, `Unknown function: ${cfg.fn}`);
  checkInputs(fn, cfg.inputs);
  checkOutputs(cfg.outputs);
  if (cfg.condition) { const err = conditions.check(cfg.condition); if (err) fail(400, `Run condition: ${err}`); }
};

/** Fill a function's inputs from the row. Returns {input} or {missing: [labels]}. */
export function inputsFor(fn, templates, data) {
  const input = {}; const missing = [];
  for (const i of fn.inputs) {
    const t = templates?.[i.key];
    const v = t === undefined || t === '' ? null : fill(t, data, { encode: fill.raw });
    input[i.key] = v;
    if (i.required && (isEmpty(v) || (typeof v === 'string' && !v.trim()))) missing.push(i.label);
  }
  return { input, missing };
}

/** Run one function for one row and describe the result the way the runner stores it. */
export async function callFunction(fn, templates, data, ctx) {
  const { input, missing } = inputsFor(fn, templates, data);
  if (missing.length) return { status: 'skipped', error: `Missing input: ${missing.join(', ')}`, calls: [] };
  const est = costOf(fn, ctx.overrides);
  try {
    // capMicros: the most this call may cost (your price override, or the function's estimate);
    // treg functions send it as their hard cap.
    const r = await fn.run(input, { fetch: ctx.fetch, secret: ctx.secret, now: ctx.now, row: { id: ctx.row?.id, data }, capMicros: est });
    const billed = r.cost_micros ?? (fn.billing === 'per_hit' && r.status !== 'done' ? 0 : est);
    return { status: r.status, data: r.data || {}, value: r.data?.[fn.primary] ?? null, provider: fn.id,
      calls: [{ provider: fn.id, cost: billed, outcome: r.status }] };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 500);
    return { status: 'error', error: msg, provider: fn.id, calls: [{ provider: fn.id, cost: e?.cost_micros || 0, outcome: 'error', note: msg }] };
  }
}

/** Map a result's fields onto output columns. */
export function mapOutputs(outputs, data) {
  const out = {};
  for (const o of outputs || []) if (o.field in (data || {})) out[o.column] = data[o.field];
  return out;
}

EXECUTORS.enrich = {
  estimate(col, overrides) {
    const fn = getFunction(col.config.fn);
    return { subreq: Math.max(1, fn?.subrequests ?? 1), micros: fn ? costOf(fn, overrides) : 0 };
  },
  heavy: (col) => !!getFunction(col.config.fn)?.heavy,
  async run(col, data, ctx) {
    const cfg = col.config;
    const fn = getFunction(cfg.fn);
    if (!fn) return { status: 'error', error: `Unknown function: ${cfg.fn}`, calls: [] };
    if (cfg.condition && !conditions.test(cfg.condition, data, ctx.cols)) return { status: 'skipped', error: 'Run condition was false', calls: [] };
    const r = await callFunction(fn, cfg.inputs, data, ctx);
    return { ...r, outputs: r.status === 'done' || r.status === 'no_result' ? mapOutputs(cfg.outputs, r.data || {}) : {}, result: r.data };
  },
};
