/**
 * Webhook in: POST rows to /api/hook/<table id>, signed with the table's secret, so a form, a
 * Zap or another script can feed a table. Webhook out is the "Send row to webhook" function
 * (src/functions/free.js), which posts each row where you point it.
 *
 * Signing: header  X-Signature: sha256=<hex HMAC-SHA256(secret, raw body)>. The secret is made
 * here with crypto.getRandomValues and shown in the table's webhook panel. Anyone without it gets
 * 401 and nothing is written.
 */

import { json, fail, nowIso } from './util.js';
import { getTableRow, loadColumns, insertRows, hooks } from './tables.js';
import { mapHeaders } from './csv.js';

export const MAX_HOOK_ROWS = 500;

export async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, typeof body === 'string' ? new TextEncoder().encode(body) : body);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sameHex(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

/** Turn the webhook on (new secret), rotate it, or turn it off. */
export async function setWebhook(db, tableId, body) {
  await getTableRow(db, tableId);
  if (body?.enabled === false) {
    await db.prepare('UPDATE tables SET webhook_secret=NULL WHERE id=?1').bind(tableId).run();
    return { enabled: false };
  }
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = 'whsec_' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await db.prepare('UPDATE tables SET webhook_secret=?2 WHERE id=?1').bind(tableId, secret).run();
  return { enabled: true, secret, path: `/api/hook/${tableId}` };
}

export async function getWebhook(db, tableId) {
  const t = await getTableRow(db, tableId);
  return t.webhook_secret ? { enabled: true, secret: t.webhook_secret, path: `/api/hook/${tableId}` } : { enabled: false };
}

/** The public endpoint. No session cookie: the signature is the credential. */
export async function receiveHook(request, env, tableId) {
  const db = env.DB;
  const t = await db.prepare('SELECT id, webhook_secret FROM tables WHERE id=?1 AND deleted_at IS NULL').bind(tableId).first();
  // Same answer for "no table", "webhook off" and "bad signature": nothing to probe.
  const raw = await request.text();
  if (raw.length > 1_000_000) return json({ error: 'Body is over 1 MB' }, 413);
  const given = (request.headers.get('x-signature') || '').replace(/^sha256=/, '');
  if (!t?.webhook_secret || !given || !sameHex(given, await hmacHex(t.webhook_secret, raw))) return json({ error: 'Bad signature' }, 401);
  let body;
  try { body = JSON.parse(raw); } catch { fail(400, 'Body must be JSON: one object or a list of objects'); }
  const list = Array.isArray(body) ? body : [body];
  if (!list.length || list.length > MAX_HOOK_ROWS || !list.every((x) => x && typeof x === 'object' && !Array.isArray(x))) fail(400, `Send one object or a list of up to ${MAX_HOOK_ROWS} objects`);
  const cols = await loadColumns(db, tableId);
  // Map each object on its own: one sender may write "website", another "Company Website".
  const ignored = new Set();
  const rows = list.map((o) => {
    const ks = Object.keys(o);
    const mapped = mapHeaders(ks, cols);
    ks.forEach((k, i) => { if (!mapped[i]) ignored.add(k); });
    return Object.fromEntries(ks.map((k, i) => [mapped[i], o[k]]).filter(([k]) => k));
  });
  const added = await insertRows(db, tableId, rows, cols);
  await db.prepare(`INSERT INTO ledger (ts, table_id, provider, cost_micros, outcome, note) VALUES (?1, ?2, 'webhook_in', 0, 'done', ?3)`)
    .bind(nowIso(), tableId, `${added} rows`).run();
  if (added) await hooks.afterWrite(db, tableId, { newRows: true });
  return json({ added, ignored_fields: [...ignored] }, 201);
}
