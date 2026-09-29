/**
 * Message column (Clay's "Message"): a subject and body per row, written from a template with
 * columns, clean variables, spintax and snippets (public/js/message.js has the syntax). Nothing
 * sends: the message sits in the table for you to read, then a send function or your sequencer
 * takes it.
 *
 * config = {
 *   subject: 'Quick question, {{clean:first_name}}',
 *   body: '{Hi|Hello} {{clean:first_name}},\n\n{{snippet:opener}}\n\n{{snippet:cta}}',
 *   snippets: [
 *     { name: 'opener', kind: 'ai', provider: 'groq', model: 'qwen/qwen3.8-27b', max_tokens: 200,
 *       prompt: 'One sentence about what {{company}} does: {{about}}' },           // a prompt per row
 *     { name: 'cta', kind: 'if', condition: '{{employees}} > 50',                   // a formula
 *       then: 'Worth a call with your ops lead?', else: 'Worth a quick call?' },
 *   ],
 *   outputs: [{ field: 'subject', column: 'subject' }, { field: 'body', column: 'body' }],
 *   allow_empty, condition, auto,
 * }
 *
 * Cost: only AI snippets cost anything; the worst case is each one's prompt plus all its
 * max_tokens at the model's price, like an AI column. A row with an empty column that the subject,
 * body or an AI snippet reads is skipped (Clay: "Some inputs missing"); if/then snippets exist to
 * handle blanks, so their columns may be empty.
 */

import { fail } from '../util.js';
import { CONFIG_CHECKS } from '../tables.js';
import { EXECUTORS } from '../runner.js';
import { checkOutputs, conditions } from './enrich.js';
import { askModel } from './ai.js';
import { fill, refs, secretRefs } from '../../public/js/template.js';
import { render, messageRefs } from '../../public/js/message.js';
import { PROVIDERS, priceOf, worstCaseMicros } from '../../public/js/ai-models.js';
import { isEmpty } from '../../public/js/types.js';

const SNIPPET_NAME = /^[a-z][a-z0-9_]{0,30}$/;
const SNIPPET_SYSTEM = 'Write only the text asked for, ready to paste into an email. No preamble, no quotes, no placeholders in brackets.';
const snippetModel = (s) => ({ provider: s.provider, model: s.model, max_tokens: s.max_tokens || 200, price_in: s.price_in, price_out: s.price_out, effort: 'low', prompt: s.prompt });

/** The snippets the subject and body use, in the order they appear. */
const usedSnippets = (cfg) => {
  const names = messageRefs(`${cfg.subject || ''}\n${cfg.body || ''}`).snippets;
  return names.map((n) => (cfg.snippets || []).find((s) => s.name === n)).filter(Boolean);
};

CONFIG_CHECKS.message = (cfg) => {
  const subject = String(cfg.subject ?? ''); const body = String(cfg.body ?? '');
  if (!body.trim()) fail(400, 'Write the message body');
  if (subject.length > 1000 || body.length > 20_000) fail(400, 'The subject is over 1,000 characters or the body over 20,000');
  const snippets = cfg.snippets ?? [];
  if (!Array.isArray(snippets) || snippets.length > 10) fail(400, 'Up to 10 snippets');
  const names = new Set();
  for (const s of snippets) {
    if (!SNIPPET_NAME.test(s?.name || '')) fail(400, 'Snippet names: lowercase letters, digits, _ (like opener)');
    if (names.has(s.name)) fail(400, `Two snippets are called ${s.name}`);
    names.add(s.name);
    const texts = s.kind === 'ai' ? [s.prompt] : [s.then, s.else];
    for (const t of texts) if (/\{\{\s*snippet:/.test(String(t ?? ''))) fail(400, `Snippet ${s.name} cannot use another snippet`);
    if (s.kind === 'ai') {
      if (!PROVIDERS[s.provider]) fail(400, `Snippet ${s.name}: pick a provider (anthropic, openai or groq)`);
      if (!/^[A-Za-z0-9._:/-]{2,100}$/.test(String(s.model || ''))) fail(400, `Snippet ${s.name}: pick a model`);
      if (!String(s.prompt || '').trim() || String(s.prompt).length > 5000) fail(400, `Snippet ${s.name}: write its prompt (up to 5,000 characters)`);
      if (!refs(s.prompt).length) fail(400, `Snippet ${s.name}: its prompt uses no column, so every row would get the same text`);
      if (s.max_tokens !== undefined && !(Number.isInteger(s.max_tokens) && s.max_tokens >= 16 && s.max_tokens <= 2000)) fail(400, `Snippet ${s.name}: max tokens must be 16 to 2,000`);
      if (!priceOf(snippetModel(s))) fail(400, `Snippet ${s.name}: no price known for ${s.model}; enter its price per 1M tokens`);
    } else if (s.kind === 'if') {
      if (!String(s.condition || '').trim()) fail(400, `Snippet ${s.name}: write the condition, like {{employees}} > 50`);
      const err = conditions.check(s.condition);
      if (err) fail(400, `Snippet ${s.name}: ${err}`);
      if (String(s.then ?? '').length > 5000 || String(s.else ?? '').length > 5000) fail(400, `Snippet ${s.name}: each text is up to 5,000 characters`);
    } else fail(400, `Snippet ${s?.name}: kind is ai or if`);
  }
  for (const n of messageRefs(`${subject}\n${body}`).snippets) if (!names.has(n)) fail(400, `The message uses {{snippet:${n}}}, which is not in the snippet list`);
  if (secretRefs(`${subject}\n${body}\n${snippets.map((s) => `${s.prompt || ''}${s.then || ''}${s.else || ''}`).join('\n')}`).length) {
    fail(400, 'Keys cannot go in a message');
  }
  checkOutputs(cfg.outputs);
  for (const o of cfg.outputs || []) if (!['subject', 'body'].includes(o.field)) fail(400, 'A message has two outputs: subject and body');
  if (cfg.condition) { const err = conditions.check(cfg.condition); if (err) fail(400, `Run condition: ${err}`); }
};

EXECUTORS.message = {
  estimate: (col) => {
    const ai = usedSnippets(col.config).filter((s) => s.kind === 'ai');
    return { subreq: ai.length, micros: ai.reduce((a, s) => a + worstCaseMicros(snippetModel(s)), 0) };
  },
  async run(col, data, ctx) {
    const cfg = col.config;
    if (cfg.condition && !conditions.test(cfg.condition, data, ctx.cols)) return { status: 'skipped', error: 'Run condition was false', calls: [] };
    const used = usedSnippets(cfg);
    const reads = [...messageRefs(`${cfg.subject || ''}\n${cfg.body || ''}`).keys, ...used.filter((s) => s.kind === 'ai').flatMap((s) => refs(s.prompt))];
    const missing = [...new Set(reads)].filter((k) => isEmpty(data[k]));
    if (missing.length && (!cfg.allow_empty || missing.length === new Set(reads).size)) {
      return { status: 'skipped', error: `Some inputs are empty: ${missing.map((k) => ctx.cols?.find((c) => c.key === k)?.name || k).join(', ')}`, calls: [] };
    }
    const seed = `${ctx.row?.id ?? ''}:${col.key}`;
    const values = {}; const calls = [];
    for (const s of used) {
      if (s.kind === 'if') {
        values[s.name] = render(conditions.test(s.condition, data, ctx.cols) ? s.then || '' : s.else || '', data, {}, `${seed}:${s.name}`);
        continue;
      }
      const r = await askModel(snippetModel(s), { system: SNIPPET_SYSTEM, user: fill(s.prompt, data) }, ctx);
      calls.push({ ...r.call, note: `snippet ${s.name}: ${r.call.note || ''}`.slice(0, 300) });
      if (r.error) return { status: 'error', error: `Snippet ${s.name}: ${r.error}`, provider: 'message', calls };
      values[s.name] = String(r.text || '').trim();
    }
    const subject = render(cfg.subject || '', data, values, `${seed}:subject`);
    const body = render(cfg.body, data, values, `${seed}:body`);
    const outputs = {};
    for (const o of cfg.outputs || []) outputs[o.column] = o.field === 'subject' ? subject : body;
    if (!body) return { status: 'no_result', provider: 'message', calls, outputs };
    return { status: 'done', value: subject ? `${subject}\n\n${body}` : body, provider: 'message', outputs, calls, result: { subject, body, snippets: values } };
  },
};
