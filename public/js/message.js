/**
 * Message templates (Clay's Message column), shared by the Worker (src/kinds/message.js) and the
 * column panel's preview, so the preview is exactly what a run writes.
 *
 * In a subject or body:
 *   {{column}}          the row's value
 *   {{clean:column}}    the value tidied: "Acme Roofing, LLC" -> "Acme Roofing", "https://www.acme.com/x"
 *                       -> "acme.com", "JOHN" -> "John" (Clay's "clean variable")
 *   {{snippet:name}}    a snippet from the column's list: an AI snippet (a prompt per row) or an
 *                       if/then snippet (a formula picks one of two texts)
 *   {Hi|Hello|Hey}      spintax: one option per row, the same one every time for that row
 *
 * Order matters for safety: spintax is resolved in the TEMPLATE first, then every {{...}} is
 * replaced in one pass, so a value from a row or a model ("{a|b}", "{{secret:X}}") is pasted as
 * text and never read as template syntax.
 */

import { isEmpty } from './types.js';

const TOKEN = /\{\{\s*(?:(clean|snippet):)?([A-Za-z0-9_]+)\s*\}\}/g;
const SPIN = /\{([^{}|]*(?:\|[^{}]*)+)\}/;   // innermost {a|b|c}: no braces inside, at least one |

const asText = (v) => (isEmpty(v) ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));
const own = (data, k) => (Object.hasOwn(data || {}, k) ? data[k] : null);

/** A small stable hash (FNV-1a), so a row's spintax choice survives re-runs. */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Resolve spintax, innermost first. seed: anything stable per row (row id + column key). */
export function spin(text, seed = '') {
  let s = String(text ?? ''); let n = 0;
  for (let m = s.match(SPIN); m && n < 50; m = s.match(SPIN), n++) {
    const options = m[1].split('|');
    s = s.slice(0, m.index) + options[hash(`${seed}:${n}:${m[1]}`) % options.length] + s.slice(m.index + m[0].length);
  }
  return s;
}

const LEGAL = /[,\s]+(inc\.?|incorporated|llc|l\.l\.c\.?|ltd\.?|limited|corp\.?|corporation|co\.|gmbh|plc|s\.a\.|pty\.? ltd\.?|llp|pllc)$/i;
const KEEP_UPPER = new Set(['CEO', 'CTO', 'CFO', 'COO', 'CMO', 'CRO', 'VP', 'SVP', 'EVP', 'HR', 'IT', 'AI', 'USA', 'US', 'UK', 'SEO', 'B2B', 'SaaS']);

/** Clay's "clean variable": a value tidied for a sentence. */
export function clean(value) {
  let s = asText(value).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (!/\s/.test(s) && !s.includes('@') && /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+([/?#].*)?$/i.test(s)) {
    return s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/?#].*$/, '').toLowerCase();
  }
  for (let i = 0; i < 2; i++) s = s.replace(LEGAL, '').trim();   // "Acme Holdings, Inc." -> "Acme Holdings"
  s = s.replace(/[,;:\s]+$/, '');
  const shouting = s === s.toUpperCase() && /[A-Z]{4,}/.test(s);
  if (shouting || s === s.toLowerCase()) {
    s = s.split(' ').map((w) => {
      if (w.includes('.') || KEEP_UPPER.has(w.toUpperCase())) return KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w;
      return w.replace(/[A-Za-z][A-Za-z']*/g, (x) => x[0].toUpperCase() + x.slice(1).toLowerCase());
    }).join(' ');
  }
  return s;
}

/** Keys a template reads directly ({{x}} and {{clean:x}}), and the snippet names it uses. */
export function messageRefs(text) {
  const keys = []; const snippets = [];
  for (const m of String(text ?? '').matchAll(TOKEN)) {
    if (m[1] === 'snippet') { if (!snippets.includes(m[2])) snippets.push(m[2]); }
    else if (!keys.includes(m[2])) keys.push(m[2]);
  }
  return { keys, snippets };
}

/** Spin, then replace every {{...}} once. snippetValues: {name: text}; a missing one renders as ''. */
export function render(text, data, snippetValues = {}, seed = '') {
  return spin(text, seed).replace(TOKEN, (_, kind, name) => {
    if (kind === 'snippet') return asText(snippetValues[name]);
    const v = own(data, name);
    return kind === 'clean' ? clean(v) : asText(v);
  }).replace(/[ \t]+\n/g, '\n').trim();
}

/** The keys every part of a message config reads, for "used in" and the run queue's waiting. */
export function configKeys(cfg) {
  const texts = [cfg.subject, cfg.body, ...(cfg.snippets || []).flatMap((s) => [s.prompt, s.then, s.else, s.condition])];
  const keys = new Set();
  for (const t of texts) {
    for (const k of messageRefs(t).keys) keys.add(k);
    for (const m of String(t ?? '').matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) keys.add(m[1]);   // formulas use {{key}} too
  }
  return [...keys];
}
