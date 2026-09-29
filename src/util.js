export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });

export const nowIso = () => new Date().toISOString();

/** Thrown inside handlers; the router turns it into a JSON error with the right status. */
export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export async function readJson(request) {
  const text = await request.text();
  if (text.length > 1_000_000) fail(413, 'Request is too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { fail(400, 'Body must be JSON'); }
}

export function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

export function slug(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'x';
}

/** Dollars as integer micro-dollars and back. 1,000,000 micros = $1. */
export const toMicros = (usd) => Math.round(Number(usd || 0) * 1e6);
export const fromMicros = (m) => Number(m || 0) / 1e6;

/** A positive integer id from a path segment or body field, or a 400. */
export function intId(v, what = 'id') {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) fail(400, `Bad ${what}`);
  return n;
}
