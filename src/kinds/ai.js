/**
 * AI column: a prompt per row on YOUR key (Anthropic, OpenAI or Groq), plain answer or named
 * output fields. The cost shown before a run is the worst case: the prompt's tokens plus the
 * full max_tokens of output, at the model's price; the ledger then records the real usage.
 *
 * config = {
 *   provider: 'anthropic' | 'openai' | 'groq', model, effort (Anthropic: low|medium|high),
 *   prompt: 'Is {{company}} a roofing business? {{site_text}}', system: '',
 *   fields: [{ name: 'is_roofer', type: 'checkbox' }],   // empty = one plain-text answer
 *   outputs: [{ field: 'is_roofer', column: 'is_roofer' }], max_tokens: 1024,
 *   price_in, price_out,                                  // $ per 1M tokens; required when not known
 *   est_input_tokens,                                     // the panel measures your rows and stores it
 *   condition, auto,
 * }
 *
 * Raw fetch rather than an SDK: the Worker has no build step or npm dependencies, and the
 * Messages API is one POST (docs: platform.claude.com, Messages API).
 */

import { fail } from '../util.js';
import { CONFIG_CHECKS } from '../tables.js';
import { EXECUTORS } from '../runner.js';
import { checkOutputs, conditions } from './enrich.js';
import { fill, refs } from '../../public/js/template.js';
import { readCapped } from '../functions/web.js';
import { PROVIDERS, priceOf, worstCaseMicros } from '../../public/js/ai-models.js';

export { PRICES, priceOf, worstCaseMicros } from '../../public/js/ai-models.js';

const EFFORTS = ['low', 'medium', 'high'];

CONFIG_CHECKS.ai = (cfg) => {
  // An Agent column: a saved agent (src/agents.js) runs once per row instead of one prompt.
  if (cfg.agent_id !== undefined) {
    if (!Number.isInteger(cfg.agent_id) || cfg.agent_id <= 0) fail(400, 'Pick an agent');
    if (!cfg.inputs || typeof cfg.inputs !== 'object' || Array.isArray(cfg.inputs)) fail(400, 'Map the inputs of the agent to columns');
    for (const v of Object.values(cfg.inputs)) if (typeof v !== 'string' || v.length > 2000) fail(400, 'Each input is a template like {{website}}');
    if (cfg.budget_micros !== undefined && !(Number.isInteger(cfg.budget_micros) && cfg.budget_micros >= 0 && cfg.budget_micros <= 10_000_000)) fail(400, 'Budget per row must be $0 to $10');
    checkOutputs(cfg.outputs);
    if (cfg.condition) { const err = conditions.check(cfg.condition); if (err) fail(400, `Run condition: ${err}`); }
    return;
  }
  const prov = PROVIDERS[cfg.provider];
  if (!prov) fail(400, 'Pick a provider: anthropic, openai or groq');
  if (!/^[A-Za-z0-9._:/-]{2,100}$/.test(String(cfg.model || ''))) fail(400, 'Pick a model');
  if (!String(cfg.prompt || '').trim()) fail(400, 'Write a prompt');
  // A table prompt with no {{column}} asks every row the same thing (a user's first AI column,
  // 2026-09-29, was "What does this company do?": the model answered that it was not told which).
  if (!refs(cfg.prompt).length) fail(400, 'The prompt uses no column, so every row would get the same question. Put one in, like: What does {{website}} do?');
  if (String(cfg.prompt).length > 20_000) fail(400, 'The prompt is over 20,000 characters');
  if (cfg.max_tokens !== undefined && !(Number.isInteger(cfg.max_tokens) && cfg.max_tokens >= 16 && cfg.max_tokens <= 16000)) fail(400, 'Max tokens must be 16 to 16,000');
  if (cfg.effort && !EFFORTS.includes(cfg.effort)) fail(400, 'Effort must be low, medium or high');
  if (cfg.fields !== undefined) {
    if (!Array.isArray(cfg.fields) || cfg.fields.length > 20) fail(400, 'Up to 20 output fields');
    for (const f of cfg.fields) if (!/^[a-z][a-z0-9_]{0,39}$/.test(f?.name || '')) fail(400, 'Field names: lowercase letters, digits, _');
  }
  for (const k of ['price_in', 'price_out']) if (cfg[k] !== undefined && !(Number.isFinite(cfg[k]) && cfg[k] >= 0 && cfg[k] < 10_000)) fail(400, `${k} must be dollars per 1M tokens`);
  if (!priceOf(cfg)) fail(400, `No price known for ${cfg.model}. Enter its input and output price per 1M tokens, so the budget cap can work.`);
  checkOutputs(cfg.outputs);
  if (cfg.condition) { const err = conditions.check(cfg.condition); if (err) fail(400, `Run condition: ${err}`); }
};

/** The instructions that turn named fields into one JSON object we can parse. */
export function buildPrompt(cfg, data) {
  const user = fill(cfg.prompt, data);
  const fields = cfg.fields || [];
  if (!fields.length) return { system: cfg.system || '', user };
  const shape = fields.map((f) => `"${f.name}": ${f.type === 'number' ? 'a number' : f.type === 'checkbox' ? 'true or false' : 'a short string'}`).join(', ');
  const system = [cfg.system || '', `Reply with one JSON object and nothing else: {${shape}}. Use null when you cannot tell.`].filter(Boolean).join('\n\n');
  return { system, user };
}

/** Lenient: the first {...} in the reply. Models sometimes wrap JSON in prose or a code fence. */
export function parseFields(text, fields) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The model did not return JSON: ' + String(text).slice(0, 120));
  let obj;
  try { obj = JSON.parse(m[0]); } catch { throw new Error('The model returned broken JSON: ' + m[0].slice(0, 120)); }
  const out = {};
  for (const f of fields) out[f.name] = Object.hasOwn(obj, f.name) ? obj[f.name] : null;
  return out;
}

async function callAnthropic(cfg, prompt, ctx) {
  const opus = /^claude-opus-5$/.test(cfg.model);
  const body = { model: cfg.model, max_tokens: cfg.max_tokens || 1024, messages: [{ role: 'user', content: prompt.user }] };
  if (prompt.system) body.system = prompt.system;
  // Effort is the cost lever on current models (Haiku 4.5 does not take it). Low suits per-row
  // classification and extraction; raise it in the panel for harder prompts.
  if (!/haiku/.test(cfg.model)) body.output_config = { effort: cfg.effort || 'low' };
  const headers = { 'content-type': 'application/json', 'x-api-key': ctx.secret('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' };
  if (opus) {
    // If a safety classifier declines, the API re-runs on a fallback model inside the same call.
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  const r = await ctx.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Anthropic HTTP ${r.status}: ${(await readCapped(r, 2000)).replace(/\s+/g, ' ').slice(0, 200)}`);
  const j = await r.json();
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const usage = { in: (j.usage?.input_tokens || 0) + (j.usage?.cache_creation_input_tokens || 0) + (j.usage?.cache_read_input_tokens || 0), out: j.usage?.output_tokens || 0, model: j.model || cfg.model };
  if (j.stop_reason === 'refusal') return { refused: `Declined (${j.stop_details?.category || 'refusal'})`, usage };
  if (!text && j.stop_reason === 'max_tokens') return { refused: 'Used all its tokens before answering. Raise Max tokens or lower effort.', usage };
  return { text, usage };
}

async function callOpenAiCompatible(cfg, prompt, ctx) {
  const groq = cfg.provider === 'groq';
  const url = groq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
  const key = ctx.secret(groq ? 'GROQ_API_KEY' : 'OPENAI_API_KEY');
  const messages = [...(prompt.system ? [{ role: 'system', content: prompt.system }] : []), { role: 'user', content: prompt.user }];
  const body = { model: cfg.model, messages, [groq ? 'max_tokens' : 'max_completion_tokens']: cfg.max_tokens || 1024 };
  const r = await ctx.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${groq ? 'Groq' : 'OpenAI'} HTTP ${r.status}: ${(await readCapped(r, 2000)).replace(/\s+/g, ' ').slice(0, 200)}`);
  const j = await r.json();
  const text = String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  return { text, usage: { in: j.usage?.prompt_tokens || 0, out: j.usage?.completion_tokens || 0, model: j.model || cfg.model } };
}

/** Worst case per row for an Agent column: its budget, and enough web requests for a full run. */
export const AGENT_COLUMN = { subreq: 20, micros: 100_000 };

async function runAgentCell(cfg, data, ctx) {
  const { getAgent, runAgent } = await import('../agents.js');
  const agent = await getAgent(ctx.env.DB, cfg.agent_id);
  const input = Object.fromEntries(Object.entries(cfg.inputs || {}).map(([k, t]) => [k, fill(t, data, { encode: fill.raw })]));
  if (Object.values(input).every((v) => v === null || v === '')) return { status: 'skipped', error: 'Every input is empty', calls: [] };
  const budget = Math.min(agent.budget_micros, cfg.budget_micros ?? AGENT_COLUMN.micros);
  const run = await runAgent(ctx.env, { fetch: ctx.fetch }, agent, input, { source: 'column', budget_micros: budget, fetch_cap: AGENT_COLUMN.subreq, ledger: false });
  const calls = [{ provider: `agent:${agent.id}`, cost: run.cost_micros, outcome: run.status === 'done' ? 'done' : 'error', note: `run ${run.id}, ${run.steps.length} steps` }];
  if (run.status !== 'done') return { status: 'error', error: run.error || run.status, provider: 'agent', calls };
  const out = run.output || {};
  const outputs = {};
  for (const o of cfg.outputs || []) if (Object.hasOwn(out, o.field)) outputs[o.column] = out[o.field];
  const first = agent.fields.length ? out[agent.fields[0].name] : run.text;
  const empty = first === null || first === undefined || first === '';
  return { status: empty ? 'no_result' : 'done', value: typeof first === 'object' && first !== null ? JSON.stringify(first) : first, outputs, result: { ...out, agent_run: run.id }, provider: 'agent', calls };
}

EXECUTORS.ai = {
  estimate: (col) => (col.config.agent_id ? { subreq: AGENT_COLUMN.subreq, micros: col.config.budget_micros ?? AGENT_COLUMN.micros } : { subreq: 1, micros: worstCaseMicros(col.config) }),
  async run(col, data, ctx) {
    const cfg = col.config;
    if (cfg.agent_id) {
      if (cfg.condition && !conditions.test(cfg.condition, data, ctx.cols)) return { status: 'skipped', error: 'Run condition was false', calls: [] };
      return runAgentCell(cfg, data, ctx);
    }
    if (cfg.condition && !conditions.test(cfg.condition, data, ctx.cols)) return { status: 'skipped', error: 'Run condition was false', calls: [] };
    const missing = refs(cfg.prompt).filter((k) => data[k] === undefined || data[k] === null || data[k] === '');
    // Any empty input skips the row, as Clay does ("Some inputs missing"): with one blank, a model
    // fills the gap with invention ("[Company Name]", live 2026-09-29). allow_empty opts out.
    if (missing.length && (!cfg.allow_empty || missing.length === refs(cfg.prompt).length)) {
      const names = missing.map((k) => ctx.cols?.find((c) => c.key === k)?.name || k).join(', ');
      return { status: 'skipped', error: `Some inputs are empty: ${names}`, calls: [] };
    }
    const provider = cfg.provider || 'anthropic';
    let res;
    try {
      res = await (provider === 'anthropic' ? callAnthropic : callOpenAiCompatible)(cfg, buildPrompt(cfg, data), ctx);
    } catch (e) {
      return { status: 'error', error: e.message, provider, calls: [{ provider: `ai:${cfg.model}`, cost: 0, outcome: 'error', note: e.message }] };
    }
    const p = priceOf(cfg, res.usage.model) || priceOf(cfg) || [0, 0];
    const cost = Math.ceil(res.usage.in * p[0] + res.usage.out * p[1]);
    const call = { provider: `ai:${res.usage.model}`, cost, note: `${res.usage.in} in / ${res.usage.out} out tokens` };
    if (res.refused) return { status: 'error', error: res.refused, provider, calls: [{ ...call, outcome: 'error' }] };
    const fields = cfg.fields || [];
    if (!fields.length) {
      return res.text ? { status: 'done', value: res.text, provider, calls: [{ ...call, outcome: 'done' }], result: { answer: res.text } }
        : { status: 'no_result', provider, calls: [{ ...call, outcome: 'no_result' }] };
    }
    let parsed;
    try { parsed = parseFields(res.text, fields); }
    catch (e) { return { status: 'error', error: e.message, provider, calls: [{ ...call, outcome: 'error' }] }; }
    const outputs = {};
    for (const o of cfg.outputs || []) if (Object.hasOwn(parsed, o.field)) outputs[o.column] = parsed[o.field];
    const first = parsed[fields[0].name];
    return { status: 'done', value: typeof first === 'object' && first !== null ? JSON.stringify(first) : first, provider, outputs, result: parsed, calls: [{ ...call, outcome: 'done' }] };
  },
};
