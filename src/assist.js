/**
 * The home page's "describe what you want" box. One sentence in, a proposed table out: data
 * columns to fill and enrichment columns from the real function catalog. The user sees the plan as
 * a checklist and clicks Build; building runs nothing, it only creates the table and columns.
 *
 * Runs on Groq's free tier (GROQ_API_KEY, model from scripts/llm.py), $0 per plan. The model's
 * answer is treated as untrusted input: every function id, input and type is checked against the
 * catalog, and anything unknown is dropped with a note rather than built.
 */

import { fail, nowIso } from './util.js';
import { secretValue } from './runner.js';
import { FUNCTIONS, getFunction } from './functions/index.js';
import { createTable, createColumn, loadColumns } from './tables.js';
import { TYPES } from '../public/js/types.js';
import { readCapped } from './functions/web.js';
import { checkFormula, FUNCTION_NAMES } from '../public/js/formula.js';

export const ASSIST_MODEL = 'qwen/qwen3.8-27b';

function catalogText() {
  return [...FUNCTIONS.values()].filter((f) => !f.id.startsWith('test_') && !f.id.startsWith('wf_'))
    .map((f) => `- ${f.id}: ${f.name}. Inputs: ${f.inputs.map((i) => i.key + (i.required ? '*' : '')).join(', ')}. ${f.secret ? `Needs ${f.secret}.` : 'Free.'}`)
    .join('\n');
}

const SYSTEM = () => `You design lead-research tables for a spreadsheet tool where a column can run a function per row.
Reply with ONE JSON object and nothing else:
{"name": "short table name",
 "columns": [{"name": "Company", "type": "text"}],
 "enrichments": [{"name": "Email provider", "fn": "email_provider", "inputs": {"domain": "Website"}}],
 "notes": "one sentence on where the rows come from (CSV, Google Maps search, or typing)"}
Rules: "columns" are data the user supplies (types: ${Object.keys(TYPES).join(', ')}).
"enrichments" use ONLY these function ids; each input maps to a column name from "columns" or an earlier enrichment:
${catalogText()}
Prefer free functions. At most 8 columns and 6 enrichments. No LinkedIn. No sending emails.`;

export function parsePlan(text) {
  const m = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('The assistant did not return a plan. Try describing the list differently.');
  let raw;
  try { raw = JSON.parse(m[0]); } catch { throw new Error('The assistant returned a broken plan. Try again.'); }
  const notes = [];
  const name = String(raw.name || 'New table').trim().slice(0, 80) || 'New table';
  const columns = [];
  for (const c of Array.isArray(raw.columns) ? raw.columns.slice(0, 8) : []) {
    const cname = String(c?.name || '').trim().slice(0, 80);
    if (!cname || columns.some((x) => x.name.toLowerCase() === cname.toLowerCase())) continue;
    columns.push({ name: cname, type: TYPES[c?.type] ? c.type : 'text' });
  }
  if (!columns.length) columns.push({ name: 'Name', type: 'text' });
  const known = new Set(columns.map((c) => c.name.toLowerCase()));
  const enrichments = [];
  for (const e of Array.isArray(raw.enrichments) ? raw.enrichments.slice(0, 6) : []) {
    const fn = getFunction(e?.fn);
    if (!fn || fn.id.startsWith('test_') || fn.id.startsWith('wf_')) { notes.push(`Skipped an unknown function "${String(e?.fn).slice(0, 40)}".`); continue; }
    const inputs = {};
    let ok = true;
    for (const i of fn.inputs) {
      const src = String(e?.inputs?.[i.key] ?? '').trim();
      if (src && known.has(src.toLowerCase())) inputs[i.key] = src;
      else if (i.required) { ok = false; notes.push(`Skipped ${fn.name}: its "${i.label}" input has no matching column.`); break; }
    }
    if (!ok) continue;
    const ename = String(e?.name || fn.name).trim().slice(0, 80) || fn.name;
    enrichments.push({ name: ename, fn: fn.id, inputs, paid: !!fn.secret });
    known.add(ename.toLowerCase());
  }
  return { name, columns, enrichments, notes: [String(raw.notes || '').slice(0, 300), ...notes].filter(Boolean) };
}

export async function planTable(env, body, deps = {}) {
  const prompt = String(body?.prompt || '').trim();
  if (!prompt) fail(400, 'Describe the list you want, like "roofers in Tampa with their email provider"');
  if (prompt.length > 1000) fail(400, 'Keep it under 1,000 characters');
  const fetch = deps.fetch || globalThis.fetch;
  let key;
  try { key = secretValue(env, 'GROQ_API_KEY'); } catch (e) { fail(400, e.message); }
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: ASSIST_MODEL, max_tokens: 1500, temperature: 0.2,
      messages: [{ role: 'system', content: SYSTEM() }, { role: 'user', content: prompt }] }),
  });
  if (!r.ok) fail(502, `Groq HTTP ${r.status}: ${(await readCapped(r, 1000)).replace(/\s+/g, ' ').slice(0, 160)}`);
  const j = await r.json();
  await env.DB.prepare(`INSERT INTO ledger (ts, provider, cost_micros, outcome, note) VALUES (?1, 'assist:groq', 0, 'done', ?2)`)
    .bind(nowIso(), `${j.usage?.prompt_tokens || 0} in / ${j.usage?.completion_tokens || 0} out tokens`).run();
  try { return parsePlan(j.choices?.[0]?.message?.content || ''); } catch (e) { fail(422, e.message); }
}

/** Build a checked plan: the table, its data columns, then enrichment columns wired by column key. */
export async function buildPlan(db, body) {
  const plan = parsePlan(JSON.stringify(body?.plan || {}));
  const t = await createTable(db, { name: plan.name });
  const first = await loadColumns(db, t.id);
  for (const c of first) await db.prepare('DELETE FROM columns WHERE id=?1').bind(c.id).run();
  const keyByName = new Map();
  for (const c of plan.columns) { const col = await createColumn(db, t.id, c); keyByName.set(c.name.toLowerCase(), col.key); }
  for (const e of plan.enrichments) {
    const fn = getFunction(e.fn);
    const inputs = Object.fromEntries(Object.entries(e.inputs).map(([k, v]) => [k, `{{${keyByName.get(v.toLowerCase())}}}`]));
    const col = await createColumn(db, t.id, { name: e.name, kind: 'enrich', type: fn.type, config: { fn: fn.id, inputs, outputs: [], condition: '', auto: false } });
    keyByName.set(e.name.toLowerCase(), col.key);
  }
  return { id: t.id, name: plan.name };
}

/**
 * "Generate with AI" in the formula editor (Clay's formula generator, teardown-v2 5.6): a sentence
 * in, one formula out, on Groq's free tier. The answer is untrusted text until it parses: a formula
 * that does not pass checkFormula comes back as an error with the text, never saved.
 */
export async function draftFormula(env, body, deps = {}) {
  const prompt = String(body?.prompt || '').trim();
  if (!prompt || prompt.length > 500) fail(400, 'Describe what to compute, like "the domain of the website, in capitals"');
  const cols = (Array.isArray(body.columns) ? body.columns : []).slice(0, 80)
    .filter((c) => /^[a-z0-9_]{1,40}$/.test(c?.key || '')).map((c) => `{{${c.key}}} = ${String(c.name || c.key).slice(0, 60)} (${String(c.type || 'text').slice(0, 12)})`);
  let key;
  try { key = secretValue(env, 'GROQ_API_KEY'); } catch (e) { fail(400, e.message); }
  const system = `You write one formula for a spreadsheet tool. Reply with the formula only: no prose, no code fence, no leading =.
Columns are referenced as {{key}}. Strings use "double quotes". Operators: OR AND = != < <= > >= & (joins text) + - * / % NOT.
Functions (use only these): ${FUNCTION_NAMES.join(', ')}.
Columns of this table:
${cols.join('\n') || '(none)'}`;
  const r = await (deps.fetch || globalThis.fetch)('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: ASSIST_MODEL, max_tokens: 400, temperature: 0, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  });
  if (!r.ok) fail(502, `Groq HTTP ${r.status}: ${(await readCapped(r, 1000)).replace(/\s+/g, ' ').slice(0, 160)}`);
  const j = await r.json();
  await env.DB.prepare(`INSERT INTO ledger (ts, provider, cost_micros, outcome, note) VALUES (?1, 'assist:groq', 0, 'done', 'formula')`).bind(nowIso()).run();
  const formula = String(j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```[a-z]*\s*|```$/g, '').trim().replace(/^=/, '').split('\n')[0].trim();
  const err = formula ? checkFormula(formula) : 'The model returned nothing';
  if (err) fail(422, `The draft did not parse (${err}): ${formula.slice(0, 200)}`, { formula });
  return { formula };
}
