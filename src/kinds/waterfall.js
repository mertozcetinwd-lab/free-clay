/**
 * Waterfall column, Clay's signature feature: try functions in order and stop at the first one
 * that returns a valid result. You pay only for the steps that actually ran.
 *
 * config = {
 *   steps: [{ fn, inputs: {k: template}, enabled }],   // tried top to bottom
 *   validate: { fn: 'email_check', pass: 'valid' } | null, // checks each candidate; a fail moves on
 *   provider_column: 'email_provider_used' | null,      // "Output name of successful provider?"
 *   outputs: [{ field, column }], condition, auto,
 * }
 *
 * Budget: the worst case (every step runs, every candidate is validated) is what a run reserves,
 * so the cap holds even when every provider misses. The ledger records what really ran.
 */

import { fail } from '../util.js';
import { CONFIG_CHECKS } from '../tables.js';
import { EXECUTORS, MAX_FETCHES } from '../runner.js';
import { getFunction, costOf } from '../functions/index.js';
import { callFunction, checkInputs, checkOutputs, mapOutputs, conditions } from './enrich.js';
import { isEmpty } from '../../public/js/types.js';

export const MAX_STEPS = 8;

const enabledSteps = (cfg) => (cfg.steps || []).filter((s) => s.enabled !== false);

export function worstCase(cfg, overrides = {}) {
  const v = cfg.validate?.fn ? getFunction(cfg.validate.fn) : null;
  let subreq = 0; let micros = 0;
  for (const s of enabledSteps(cfg)) {
    const fn = getFunction(s.fn);
    if (!fn) continue;
    subreq += fn.subrequests || 0; micros += costOf(fn, overrides);
    if (v) { subreq += v.subrequests || 0; micros += costOf(v, overrides); }
  }
  return { subreq: Math.max(1, subreq), micros };
}

CONFIG_CHECKS.waterfall = (cfg) => {
  if (!Array.isArray(cfg.steps) || !cfg.steps.length) fail(400, 'A waterfall needs at least one step');
  if (cfg.steps.length > MAX_STEPS) fail(400, `Up to ${MAX_STEPS} steps`);
  for (const s of cfg.steps) {
    const fn = getFunction(s?.fn);
    if (!fn) fail(400, `Unknown function: ${s?.fn}`);
    if (s.enabled !== false) checkInputs(fn, s.inputs);
  }
  if (!enabledSteps(cfg).length) fail(400, 'Switch on at least one step');
  if (cfg.validate) {
    const v = getFunction(cfg.validate.fn);
    if (!v || !v.validates) fail(400, 'Pick a validation function');
    if (!v.outputs.some((o) => o.key === (cfg.validate.pass || 'valid'))) fail(400, 'Validation field not found');
  }
  if (cfg.provider_column !== undefined && cfg.provider_column !== null && !/^[a-z0-9_]{1,40}$/.test(cfg.provider_column)) fail(400, 'Bad provider column');
  checkOutputs(cfg.outputs);
  if (cfg.condition) { const err = conditions.check(cfg.condition); if (err) fail(400, `Run condition: ${err}`); }
  if (worstCase(cfg).subreq > MAX_FETCHES) fail(400, `Too many steps for one Worker run: at most ${MAX_FETCHES} fetches per row. Remove a step or the validation.`);
};

/** Run the validator on a candidate. Its first required input gets the candidate value. */
async function validate(cfg, candidate, ctx) {
  const v = getFunction(cfg.validate.fn);
  const key = v.inputs.find((i) => i.required)?.key || v.inputs[0].key;
  const r = await callFunction(v, { [key]: '{{__candidate}}' }, { __candidate: candidate }, ctx);
  const passField = cfg.validate.pass || 'valid';
  // A validator that ERRORS (its provider down, 503) has not said no: that candidate is unverified,
  // not rejected (live, 2026-09-29: two paid-for emails were dropped as "failed validation" on a 503).
  return { ok: r.status === 'done' && r.data?.[passField] === true, error: r.status === 'error' ? r.error || 'the check failed' : null,
    calls: r.calls.map((c) => ({ ...c, note: `validating ${String(candidate).slice(0, 80)}` })), result: r };
}

EXECUTORS.waterfall = {
  estimate: (col, overrides) => worstCase(col.config, overrides),
  heavy: (col) => enabledSteps(col.config).some((s) => getFunction(s.fn)?.heavy),
  async run(col, data, ctx) {
    const cfg = col.config;
    if (cfg.condition && !conditions.test(cfg.condition, data, ctx.cols)) return { status: 'skipped', error: 'Run condition was false', calls: [] };
    const calls = []; const tried = []; let attempted = 0; let errors = 0; let unverified = null;
    for (const step of enabledSteps(cfg)) {
      const fn = getFunction(step.fn);
      if (!fn) { tried.push({ fn: step.fn, status: 'error', error: 'unknown function' }); continue; }
      const r = await callFunction(fn, step.inputs, data, ctx);
      calls.push(...r.calls);
      if (r.status === 'skipped') { tried.push({ fn: fn.id, status: 'skipped', error: r.error }); continue; }
      attempted++;
      if (r.status === 'error') { errors++; tried.push({ fn: fn.id, status: 'error', error: r.error }); continue; }
      if (r.status !== 'done' || isEmpty(r.value)) { tried.push({ fn: fn.id, status: 'no_result' }); continue; }
      if (cfg.validate?.fn) {
        const v = await validate(cfg, r.value, ctx);
        calls.push(...v.calls);
        if (v.error) { unverified = unverified || v.error; tried.push({ fn: fn.id, status: 'unverified', value: r.value, why: v.error }); continue; }
        if (!v.ok) { tried.push({ fn: fn.id, status: 'failed validation', value: r.value, why: v.result.data?.status || v.result.data?.result || null }); continue; }
      }
      tried.push({ fn: fn.id, status: 'done', value: r.value });
      const outputs = mapOutputs(cfg.outputs, r.data);
      if (cfg.provider_column) outputs[cfg.provider_column] = fn.name;
      return { status: 'done', value: r.value, provider: fn.id, outputs, calls, result: { ...r.data, provider: fn.id, tried } };
    }
    const summary = tried.map((t) => `${getFunction(t.fn)?.name || t.fn}: ${t.error || t.status}${t.why && t.status === 'failed validation' ? ` (${t.why})` : ''}`).join('; ');
    const outputs = cfg.provider_column ? { [cfg.provider_column]: null } : {};
    if (attempted === 0) return { status: 'skipped', error: summary || 'No step could run', calls, outputs };
    if (errors === attempted) return { status: 'error', error: summary, calls, outputs };
    // Nothing passed, but a candidate could not be checked: an error, so "Run errored rows" checks again.
    if (unverified) return { status: 'error', error: `Found a candidate but could not check it (${unverified}). Run errored rows to check again.`, calls, outputs, result: { tried } };
    return { status: 'no_result', error: summary, calls, outputs, result: { tried } };
  },
};
