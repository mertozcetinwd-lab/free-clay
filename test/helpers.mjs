import { makeD1 } from '../dev/d1.mjs';
import assert from 'node:assert/strict';
import { handle } from '../src/index.js';

export const PW = 'correct horse';

export function fakeEnv() {
  const { sql, DB } = makeD1();
  return { sql, DB, APP_PASSWORD: PW };
}

/** Log in and return a fetch-like helper that carries the session cookie. */
export async function client(env, deps = {}) {
  const r = await handle(new Request('https://clay.test/api/login', { method: 'POST', body: JSON.stringify({ password: PW }) }), env);
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const res = await handle(new Request('https://clay.test' + path, {
      method, headers: { cookie }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    }), env, {}, deps);
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return {
    get: (p) => call('GET', p), post: (p, b) => call('POST', p, b ?? {}), patch: (p, b) => call('PATCH', p, b),
    put: (p, b) => call('PUT', p, b), del: (p, b) => call('DELETE', p, b),
  };
}

/**
 * A fetch that never touches the network. `routes` maps a substring of the URL to a handler
 * (req) => Response | object (sent as JSON) | Error (thrown, like a network failure).
 * Every call is recorded in .calls so a test can assert what would have been sent.
 */
export function fakeFetch(routes = {}) {
  const calls = [];
  const f = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const req = { url, method: init.method || 'GET', headers: new Headers(init.headers || {}), body: init.body };
    calls.push(req);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    if (!hit) throw new Error('fakeFetch: no route for ' + url);
    let out = routes[hit];
    if (typeof out === 'function') out = await out(req);
    if (out instanceof Error) throw out;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.calls = calls;
  return f;
}

export const html = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

/** A DNS-over-HTTPS answer in the JSON shape Cloudflare and Google return. */
export const dns = (answers, status = 0) => ({ Status: status, Answer: answers.map(([type, data]) => ({ name: 'x', type, TTL: 60, data })) });
