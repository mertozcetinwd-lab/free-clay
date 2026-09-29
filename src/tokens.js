/**
 * API tokens (LOAM-PLAN.md phase 10): what the REST API, the CLI and the MCP server use instead
 * of the password cookie. A token is shown once when made; only its SHA-256 is stored, so a copy
 * of the database cannot be turned back into tokens. Revoking takes effect on the next request.
 *
 * Format: "fc_" + 32 random base64url characters (192 bits).
 */

import { fail, nowIso } from './util.js';

export const MAX_TOKENS = 20;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function listTokens(db) {
  const { results } = await db.prepare('SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE revoked_at IS NULL ORDER BY id DESC').all();
  return results;
}

export async function createToken(db, body) {
  const name = String(body?.name || '').trim().slice(0, 60);
  if (!name) fail(400, 'Name the token after where it will be used, like "Claude Code" or "Zapier"');
  if ((await db.prepare('SELECT count(*) AS n FROM api_tokens WHERE revoked_at IS NULL').first()).n >= MAX_TOKENS) fail(400, `Up to ${MAX_TOKENS} tokens`);
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = 'fc_' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const [r] = await db.batch([db.prepare('INSERT INTO api_tokens (name, prefix, hash, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id')
    .bind(name, token.slice(0, 9), await sha256Hex(token), nowIso())]);
  return { id: r.results[0].id, name, token, note: 'Copy it now. It is not shown again.' };
}

export async function revokeToken(db, id) {
  const r = await db.prepare('UPDATE api_tokens SET revoked_at=?2 WHERE id=?1 AND revoked_at IS NULL RETURNING id').bind(id, nowIso()).all();
  if (!r.results.length) fail(404, 'No such token');
  return { ok: true };
}

/** The bearer token of a request, if it is a live one. Updates last_used_at at most once a minute. */
export async function tokenFrom(db, request) {
  const m = /^Bearer\s+(fc_[A-Za-z0-9_-]{20,64})$/.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const hash = await sha256Hex(m[1]);
  const row = await db.prepare('SELECT id, last_used_at FROM api_tokens WHERE hash=?1 AND revoked_at IS NULL').bind(hash).first();
  if (!row) return null;
  if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - 60_000) {
    await db.prepare('UPDATE api_tokens SET last_used_at=?2 WHERE id=?1').bind(row.id, nowIso()).run();
  }
  return row.id;
}
