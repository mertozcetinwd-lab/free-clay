/** Settings and the one bootstrap call the app makes on load. */

import { parseJson, fail } from './util.js';
import { EMAIL_RE } from './opendata/http.js';

/** Settings the browser may change, and what each must look like. */
const SETTING_CHECKS = {
  theme: (v) => ['system', 'light', 'dark'].includes(v),
  profile_name: (v) => typeof v === 'string' && v.length <= 60,
  contact_email: (v) => v === '' || (typeof v === 'string' && v.length <= 120 && EMAIL_RE.test(v)),
  auto_run: (v) => typeof v === 'boolean',
  ai_context: (v) => typeof v === 'string' && v.length <= 4000,
  default_budget_micros: (v) => Number.isInteger(v) && v >= 0 && v <= 1_000_000_000,
  cost_overrides: (v) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.values(v).every((n) => Number.isInteger(n) && n >= 0),
};

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of results) out[r.key] = parseJson(r.value, null);
  return out;
}

export async function patchSettings(db, body) {
  const stmts = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!SETTING_CHECKS[k]) fail(400, `Unknown setting: ${k}`);
    if (!SETTING_CHECKS[k](v)) fail(400, `Bad value for ${k}`);
    stmts.push(db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .bind(k, JSON.stringify(v)));
  }
  if (stmts.length) await db.batch(stmts);
  return getSettings(db);
}

export async function bootstrap(db, env) {
  const month = new Date().toISOString().slice(0, 7);
  const [settings, tables, secrets, spend, folders] = await Promise.all([
    getSettings(db),
    db.prepare(`SELECT t.id, t.name, t.position, t.favorite, t.folder_id, t.created_at, t.updated_at, t.last_opened_at,
                  (SELECT count(*) FROM rows r WHERE r.table_id=t.id) AS row_count,
                  (SELECT count(*) FROM columns c WHERE c.table_id=t.id) AS column_count
                  FROM tables t WHERE t.deleted_at IS NULL ORDER BY t.position, t.id`).all(),
    db.prepare('SELECT name, note, created_at FROM secrets_index ORDER BY name').all(),
    db.prepare('SELECT COALESCE(sum(cost_micros), 0) AS s FROM ledger WHERE substr(ts,1,7)=?1').bind(month).first(),
    db.prepare('SELECT id, name, created_at FROM folders ORDER BY name COLLATE NOCASE, id').all(),
  ]);
  return {
    settings,
    tables: tables.results,
    folders: folders.results,
    month_micros: spend?.s || 0,
    // Whether each named secret is actually set on the Worker. The value never leaves the Worker.
    secrets: secrets.results.map((s) => ({ ...s, set: typeof env?.[s.name] === 'string' && env[s.name].length > 0 })),
  };
}

/**
 * Secret NAMES. The value is set with `npx wrangler secret put NAME`, which the Worker cannot do
 * for itself; registering the name here is what lets an HTTP column use {{secret:NAME}}. The app
 * password and the bindings can never be referenced, so a column cannot send them anywhere.
 */
export const SECRET_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
export const RESERVED_SECRETS = ['APP_PASSWORD', 'DB', 'ASSETS'];

export async function addSecret(db, body) {
  const name = String(body?.name || '').trim().toUpperCase();
  if (!SECRET_RE.test(name)) fail(400, 'Use capital letters, digits and _ (like HUNTER_API_KEY)');
  if (RESERVED_SECRETS.includes(name)) fail(400, `${name} is reserved`);
  await db.prepare('INSERT INTO secrets_index (name, note, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(name) DO UPDATE SET note=excluded.note')
    .bind(name, String(body.note || '').slice(0, 200), new Date().toISOString()).run();
  return { name };
}

export async function removeSecret(db, name) {
  await db.prepare('DELETE FROM secrets_index WHERE name=?1').bind(name).run();
  return { ok: true };
}
