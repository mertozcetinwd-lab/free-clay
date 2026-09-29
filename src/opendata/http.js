/**
 * Every request to an open-data service goes through openFetch. It carries a User-Agent that
 * names Free Clay and, where the service asks for one, the contact email you set in Settings:
 * Nominatim requires an identifying User-Agent and SEC EDGAR a name and email, or it answers 403
 * and blocks for about ten minutes (references/loam-sources.md). The email is yours to type;
 * nothing fills it in for you, and a source that needs it refuses until it is set.
 */

import { fail, parseJson } from '../util.js';

export const EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;

export async function contactEmail(db) {
  const r = await db.prepare(`SELECT value FROM settings WHERE key='contact_email'`).first();
  const v = parseJson(r?.value, '');
  return typeof v === 'string' && EMAIL_RE.test(v) ? v : null;
}

/** needsContact: the service's terms ask for a contact in the User-Agent. */
export async function openFetch(db, deps, url, { needsContact = false, init = {} } = {}) {
  const email = await contactEmail(db);
  if (needsContact && !email) fail(400, 'Set a contact email in Settings, Data sources first. This service asks for one in every request.');
  const ua = `FreeClay/1.0 (open-source lead tool${email ? `; ${email}` : ''})`;
  const f = deps.fetch || fetch;
  return f(url, { ...init, headers: { 'user-agent': ua, accept: 'application/json', ...(init.headers || {}) } });
}
