/**
 * Templates: text with {{column_key}} slots (and {{secret:NAME}} in HTTP columns). Shared by the
 * Worker (which fills them per row) and the browser (which shows which columns a setting uses).
 *
 * Filling is ONE pass over the template. A row value that itself contains "{{secret:X}}" is pasted
 * as plain text and never expanded again, so data coming in through a webhook cannot pull a secret
 * into a request.
 */

import { isEmpty } from './types.js';

const SLOT = /\{\{\s*(secret:)?([A-Za-z0-9_]+)\s*\}\}/g;

/** Column keys a template references, in order, without duplicates. */
export function refs(template) {
  const out = [];
  for (const m of String(template ?? '').matchAll(SLOT)) if (!m[1] && !out.includes(m[2])) out.push(m[2]);
  return out;
}

/** Every column key a computed column's settings read. */
export function columnRefs(col) {
  const c = col.config || {};
  const texts = [c.condition, c.prompt, c.system, c.url, c.body, c.formula,
    ...Object.values(c.inputs || {}), ...(c.steps || []).flatMap((s) => Object.values(s.inputs || {})),
    ...(c.headers || []).map((x) => x.value)];
  return new Set(texts.flatMap((t) => refs(t || '')));
}

export function secretRefs(template) {
  const out = [];
  for (const m of String(template ?? '').matchAll(SLOT)) if (m[1] && !out.includes(m[2])) out.push(m[2]);
  return out;
}

const own = (data, k) => (Object.hasOwn(data, k) ? data[k] : null);   // {{constructor}} is not a column
const asText = (v) => (isEmpty(v) ? '' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

/**
 * data: {key: value}. A template that is exactly one slot returns the raw value (a number stays a
 * number). encode: applied to each pasted value (encodeURIComponent for URLs, JSON for bodies).
 * secret(name): returns the secret's value, or throws.
 */
export function fill(template, data, { encode = (s) => s, secret } = {}) {
  const t = String(template ?? '');
  const only = t.trim().match(/^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/);
  if (only && encode === fill.raw) return own(data, only[1]) ?? null;
  return t.replace(SLOT, (_, isSecret, name) => {
    if (isSecret) {
      if (!secret) throw new Error('Secrets can only be used in HTTP API columns');
      return encode(secret(name), true);
    }
    return encode(asText(own(data, name)));
  });
}
fill.raw = (s) => s;

/** True when every referenced column has a value (a run skips the row otherwise). */
export const missingRefs = (template, data) => refs(template).filter((k) => isEmpty(own(data, k)));
