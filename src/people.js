/**
 * Find leads, People (Clay's "Find people", teardown-v2 3.1): search people by job title, company
 * and place through treg's routed people search (22 providers, cheapest first; treg catalog read
 * 2026-09-29). This is the one search that cannot be free: open data has businesses, not people.
 *
 * Money: every search is capped (X-Treg-Route-Max-Cost, $0.10 unless the caller asks for less and
 * never above the budget per run in Settings), ledgered at treg's real charge, and cached for 7
 * days so the same search twice costs nothing. Import re-reads the cached search, so the rows
 * written are the rows treg returned, not what the browser sends back.
 *
 * What comes back is business data: name, title, company, domain, location, and an email only if
 * a provider includes one. LinkedIn fields are dropped (src/functions/treg.js, toPerson).
 */

import { fail, nowIso, parseJson } from './util.js';
import { secretValue } from './runner.js';
import { tregPeopleSearch, PEOPLE_SEARCH_CAP } from './functions/treg.js';
import { cached, peek, DAY } from './opendata/cache.js';
import { upsertRecords } from './audiences.js';
import { normalizeDomain } from './functions/web.js';

export const PEOPLE_COLUMNS = [
  ['full_name', 'Name', 'text'], ['title', 'Job title', 'text'], ['company', 'Company', 'text'], ['domain', 'Company domain', 'text'],
  ['location', 'Location', 'text'], ['email', 'Email', 'email'], ['seniority', 'Seniority', 'text'], ['key', 'Lead key', 'text'],
];

const clean = (v, n = 80) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, n);

export function checkPeopleSearch(body) {
  const s = {
    source: 'people', title: clean(body?.title), company_domain: body?.company_domain ? normalizeDomain(body.company_domain) || fail(400, 'Company domain looks wrong') : '',
    location: clean(body?.location), q: clean(body?.q, 120),
    keywords: (Array.isArray(body?.keywords) ? body.keywords : String(body?.keywords || '').split(',')).map((k) => clean(k, 40)).filter(Boolean).slice(0, 10),
    limit: Math.min(50, Math.max(1, Number.parseInt(body?.limit, 10) || 25)),
  };
  if (!s.title && !s.company_domain && !s.q && !s.keywords.length) fail(400, 'Give a job title, a company domain or some keywords');
  return s;
}

/** Stable per person, so importing the same search twice adds nobody twice. */
const keyOf = (p) => `${p.full_name}|${p.domain || p.company || ''}`.toLowerCase();

export async function peopleSearch(env, deps, body) {
  const db = env.DB;
  const s = checkPeopleSearch(body);
  const settings = Object.fromEntries((await db.prepare(`SELECT key, value FROM settings WHERE key='default_budget_micros'`).all()).results.map((r) => [r.key, parseJson(r.value, null)]));
  const budget = settings.default_budget_micros ?? 1_000_000;
  const asked = Number.isFinite(body?.max_usd) ? Math.round(body.max_usd * 1e6) : PEOPLE_SEARCH_CAP;
  const cap = Math.min(asked, budget, 1_000_000);
  if (cap <= 0) fail(400, 'Your budget per run is $0, so a paid search cannot run. Raise it in Settings.');
  let charged = 0; let foundBy = null;
  const { value, cached: hit } = await cached(db, 'people-results', JSON.stringify(s), 7 * DAY, async () => {
    // Bound: Workers throw "Illegal invocation" when the global fetch is called as ctx.fetch(...).
    const ctx = { fetch: deps.fetch || globalThis.fetch.bind(globalThis), secret: (n) => secretValue(env, n) };
    let r;
    try { r = await tregPeopleSearch(ctx, s, cap); }
    catch (e) {
      if (e.cost_micros) await ledger(db, e.cost_micros, 'error', e.message);
      fail(/TREG_TOKEN is not set/.test(e.message) ? 400 : 502, e.message);
    }
    charged = r.cost; foundBy = r.servedBy;
    await ledger(db, r.cost, r.people.length ? 'done' : 'no_result', `people search via ${r.servedBy || 'treg'}: ${r.people.length} found`);
    return r.people.map((p) => ({ ...p, key: keyOf(p) }));
  }, deps.nowMs);
  return { search: s, results: value, cost_micros: hit ? 0 : charged, cap_micros: cap, found_by: foundBy, cached: hit };
}

function ledger(db, cost, outcome, note) {
  return db.prepare(`INSERT INTO ledger (ts, provider, cost_micros, outcome, note) VALUES (?1, 'treg:people.search', ?2, ?3, ?4)`).bind(nowIso(), cost || 0, outcome, String(note).slice(0, 300)).run();
}

export async function savedPeople(db, deps, search) {
  const hit = await peek(db, 'people-results', JSON.stringify(checkPeopleSearch(search)), deps.nowMs);
  if (!hit) fail(409, 'That search is not saved any more. Search again.');
  return hit;
}

export async function peopleToAudience(db, deps, body) {
  const results = await savedPeople(db, deps, body?.search);
  const only = Array.isArray(body.only) && body.only.length ? new Set(body.only) : null;
  return upsertRecords(db, 'people', results.filter((p) => !only || only.has(p.key)), 'Find leads: people (treg)');
}
