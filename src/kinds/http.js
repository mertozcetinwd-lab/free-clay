/**
 * HTTP API column (a Growth-plan feature on Clay): call any API once per row.
 *
 * config = {
 *   method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
 *   url: 'https://api.example.com/v1/lookup?domain={{domain}}&key={{secret:EXAMPLE_KEY}}',
 *   headers: [{ name: 'Authorization', value: 'Bearer {{secret:EXAMPLE_KEY}}' }],
 *   body: '{"company": "{{company}}"}',
 *   path: 'data.email',                          // what the cell shows ('' = the whole response)
 *   outputs: [{ field: 'data.phone', column: 'phone' }],
 *   cost_micros: 0,                               // your provider's price per call, for the budget
 *   condition, auto,
 * }
 *
 * SAFETY. {{secret:NAME}} is filled from Worker secrets at call time and never stored or shown.
 * Row values are pasted in a single pass and encoded for where they land (URL component, JSON
 * string, header text), so a row value cannot add a header, break out of the JSON, or pull in a
 * secret. Only https URLs, so a key never crosses the network in clear text.
 */

import { fail } from '../util.js';
import { CONFIG_CHECKS } from '../tables.js';
import { EXECUTORS } from '../runner.js';
import { checkOutputs, conditions } from './enrich.js';
import { fill, secretRefs } from '../../public/js/template.js';
import { getPath, parsePath } from '../../public/js/jsonpath.js';
import { readCapped } from '../functions/web.js';
import { RESERVED_SECRETS } from '../meta.js';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const BAD_HEADER = /^(host|content-length|cookie|connection|transfer-encoding)$/i;

CONFIG_CHECKS.http = (cfg) => {
  if (!METHODS.includes(cfg.method || 'GET')) fail(400, 'Method must be GET, POST, PUT, PATCH or DELETE');
  const url = String(cfg.url || '');
  const host = url.replace(/^https:\/\//i, '').split(/[/?#]/)[0];
  if (!/^https:\/\//i.test(url) || !host || /[{}\s@]/.test(host)) fail(400, 'The URL must start with https:// and a fixed host (the host cannot come from a column)');
  if (cfg.headers !== undefined) {
    if (!Array.isArray(cfg.headers) || cfg.headers.length > 20) fail(400, 'Up to 20 headers');
    for (const hd of cfg.headers) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(hd?.name || '')) fail(400, `Bad header name: ${hd?.name}`);
      if (BAD_HEADER.test(hd.name)) fail(400, `${hd.name} is set automatically`);
    }
  }
  for (const t of [url, cfg.body, ...(cfg.headers || []).map((x) => x.value)]) {
    for (const s of secretRefs(t)) if (RESERVED_SECRETS.includes(s)) fail(400, `${s} cannot be sent anywhere`);
  }
  try { if (cfg.path) parsePath(cfg.path); for (const o of cfg.outputs || []) parsePath(o.field); } catch (e) { fail(400, e.message); }
  if (cfg.cost_micros !== undefined && !(Number.isInteger(cfg.cost_micros) && cfg.cost_micros >= 0)) fail(400, 'cost_micros must be a whole number');
  checkOutputs(cfg.outputs);
  if (cfg.condition) { const err = conditions.check(cfg.condition); if (err) fail(400, `Run condition: ${err}`); }
};

const jsonString = (s) => JSON.stringify(String(s)).slice(1, -1);
const headerSafe = (s) => String(s).replace(/[\r\n]+/g, ' ');

/** Build the request for one row. Exported so the tests can inspect it without sending it. */
export function buildRequest(cfg, data, secret) {
  const method = cfg.method || 'GET';
  const url = fill(cfg.url, data, { encode: (s) => encodeURIComponent(s), secret });
  const headers = {};
  for (const hd of cfg.headers || []) headers[hd.name] = headerSafe(fill(hd.value, data, { secret }));
  let body;
  if (cfg.body && method !== 'GET') {
    const looksJson = /^\s*[[{]/.test(cfg.body);
    body = fill(cfg.body, data, { encode: looksJson ? jsonString : (s) => s, secret });
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['content-type'] = looksJson ? 'application/json' : 'text/plain';
  }
  if (new URL(url).protocol !== 'https:') throw new Error('Only https URLs');
  return { url, init: { method, headers, body } };
}

EXECUTORS.http = {
  estimate: (col) => ({ subreq: 1, micros: col.config.cost_micros || 0 }),
  async run(col, data, ctx) {
    const cfg = col.config;
    if (cfg.condition && !conditions.test(cfg.condition, data, ctx.cols)) return { status: 'skipped', error: 'Run condition was false', calls: [] };
    const host = (() => { try { return new URL(cfg.url.replace(/\{\{[^}]*\}\}/g, 'x')).host; } catch { return 'http'; } })();
    const call = { provider: `http:${host}`, cost: cfg.cost_micros || 0 };
    let res; let text;
    try {
      const { url, init } = buildRequest(cfg, data, ctx.secret);
      res = await ctx.fetch(url, init);
      text = await readCapped(res, 200_000);
    } catch (e) {
      return { status: 'error', error: e.message, calls: [{ ...call, cost: 0, outcome: 'error', note: e.message }] };
    }
    if (!res.ok) {
      const msg = `HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`;
      return { status: 'error', error: msg, calls: [{ ...call, outcome: 'error', note: msg }] };
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON: the cell gets the text */ }
    const value = json !== null ? getPath(json, cfg.path || '') : text.slice(0, 50_000);
    const outputs = {};
    for (const o of cfg.outputs || []) outputs[o.column] = json !== null ? getPath(json, o.field) : null;
    const shown = value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
    const empty = shown === null || shown === '' || shown === '[]' || shown === '{}';
    return { status: empty ? 'no_result' : 'done', value: empty ? null : shown, outputs, result: json ?? { text: text.slice(0, 20_000) },
      calls: [{ ...call, outcome: empty ? 'no_result' : 'done' }] };
  },
};
