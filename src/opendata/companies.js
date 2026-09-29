/**
 * Companies from open data (LOAM-PLAN.md phase 6c), the free side of Clay's "Find companies".
 *
 * Wikidata: companies by industry and US state, with website, employees and founding year. One
 * SPARQL query per search: the industry word is looked up with Wikidata's own search (mwapi
 * EntitySearch) so nobody has to know item ids, and the state is matched by its ISO code
 * (P300 "US-FL"), so there is no table of state ids to get wrong. CC0. Cached 7 days.
 * Wikidata is thin on small local firms; it is strongest on companies notable enough to have an
 * article. Local trades come from the Open data places search instead.
 *
 * SEC EDGAR: every company with a ticker, from company_tickers_exchange.json (public domain,
 * cached a day). A search matches name or ticker; "details" reads each picked company's
 * submissions record for industry (SIC), address, phone and website. SEC asks for at most 10
 * requests a second and a User-Agent with a contact email (references/loam-sources.md), so
 * details are capped at MAX_SEC_DETAILS per click, cached 30 days per company.
 */

import { checkLookalikeSearch } from '../lookalikes.js';
import { fail } from '../util.js';
import { openFetch } from './http.js';
import { cached, peek, DAY } from './cache.js';

export const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI',
  'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY'];
export const MAX_SEC_DETAILS = 10;
const MAX_WIKIDATA = 300;
const WORD_RE = /^[\p{L}\p{N} &'.,-]{2,60}$/u;

/* ---------------------------------------------------------------- Wikidata */

export function checkWikidataSearch(body) {
  const industry = String(body?.industry || '').trim().replace(/\s+/g, ' ');
  if (!WORD_RE.test(industry)) fail(400, 'Type an industry, like "construction" or "software"');
  const state = body?.state ? String(body.state).toUpperCase() : '';
  if (state && !US_STATES.includes(state)) fail(400, 'Pick a US state, or leave it on All states');
  return { source: 'wikidata', industry: industry.toLowerCase(), state };
}

/** The query text. Values are checked above; the industry is also escaped as a SPARQL string. */
export function wikidataQuery(s) {
  const lit = JSON.stringify(s.industry);   // a valid SPARQL string literal: quotes and backslashes escaped
  const where = s.state
    ? `?c wdt:P159 ?hq . ?st wdt:P300 "US-${s.state}" . ?hq wdt:P131* ?st .`
    : '?c wdt:P17 wd:Q30 .';
  return `SELECT ?c ?cLabel ?site ?emp ?inc ?hqLabel ?indLabel WHERE {
  SERVICE wikibase:mwapi { bd:serviceParam wikibase:api "EntitySearch"; wikibase:endpoint "www.wikidata.org";
    mwapi:search ${lit}; mwapi:language "en"; mwapi:limit "10". ?ind wikibase:apiOutputItem mwapi:item. }
  ?c wdt:P452 ?ind .
  ${where}
  FILTER NOT EXISTS { ?c wdt:P576 ?dissolved }
  OPTIONAL { ?c wdt:P856 ?site } OPTIONAL { ?c wdt:P1128 ?emp } OPTIONAL { ?c wdt:P571 ?inc } OPTIONAL { ?c wdt:P159 ?hq }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} LIMIT ${MAX_WIKIDATA}`;
}

const cap = (v, n = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/** SPARQL JSON rows to companies, one per item (the query repeats an item per website or HQ). */
export function fromWikidata(json) {
  const byId = new Map();
  for (const b of json?.results?.bindings || []) {
    const url = b.c?.value;
    if (!/^http:\/\/www\.wikidata\.org\/entity\/Q\d+$/.test(url || '')) continue;
    const name = cap(b.cLabel?.value);
    if (!name || /^Q\d+$/.test(name)) continue;   // no English label
    const prev = byId.get(url);
    const emp = Number(b.emp?.value);
    const row = prev || { name, website: null, domain: null, industry: null, employees: null, founded: null, hq: null, state: null, ticker: null, exchange: null,
      phone: null, source_url: url.replace('http://', 'https://') };
    row.website ||= cap(b.site?.value);
    row.domain ||= domainOf(row.website);
    row.industry ||= cap(b.indLabel?.value);
    if (Number.isFinite(emp) && emp > (row.employees || 0)) row.employees = Math.round(emp);
    const year = /^(\d{4})-/.exec(b.inc?.value || '')?.[1];
    row.founded ||= year ? Number(year) : null;
    row.hq ||= cap(b.hqLabel?.value);
    byId.set(url, row);
  }
  return [...byId.values()];
}

export function domainOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

export async function wikidataCompanies(db, deps, body) {
  const s = checkWikidataSearch(body);
  const key = JSON.stringify(s);
  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(wikidataQuery(s));
  const { value, cached: hit } = await cached(db, 'company-results', key, 7 * DAY, async () => {
    const res = await openFetch(db, deps, url, { init: { headers: { accept: 'application/sparql-results+json' } } });
    if (res.status === 429) fail(503, 'Wikidata is rate-limiting this address. Try again in a minute.');
    if (!res.ok) fail(502, `Wikidata answered ${res.status}. A very broad industry word can time out; try a narrower one.`);
    return fromWikidata(await res.json()).map((c) => ({ ...c, state: s.state || null }));
  }, deps.nowMs);
  return { search: s, results: value, cached: hit };
}

/* ---------------------------------------------------------------- SEC EDGAR */

export function checkSecSearch(body) {
  const q = String(body?.q || '').trim().replace(/\s+/g, ' ');
  if (q.length < 2 || q.length > 60) fail(400, 'Type a company name or ticker, like "Home Depot" or HD');
  return { source: 'sec', q: q.toLowerCase() };
}

/** The tickers file, reduced to [cik, name, ticker, exchange] and cached a day. */
async function secTickers(db, deps) {
  const { value } = await cached(db, 'sec', 'tickers', DAY, async () => {
    const res = await openFetch(db, deps, 'https://www.sec.gov/files/company_tickers_exchange.json', { needsContact: true });
    if (!res.ok) fail(502, `SEC answered ${res.status}. If it says 403, check the contact email in Settings.`);
    const j = await res.json();
    const at = Object.fromEntries((j.fields || []).map((f, i) => [f, i]));
    if (!('cik' in at && 'name' in at && 'ticker' in at)) fail(502, 'The SEC tickers file changed shape');
    return (j.data || []).map((r) => [r[at.cik], String(r[at.name]), String(r[at.ticker]), r[at.exchange] ?? null]);
  }, deps.nowMs);
  return value;
}

const cik10 = (cik) => String(cik).padStart(10, '0');
export const edgarUrl = (cik) => `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik10(cik)}`;

export async function secCompanies(db, deps, body) {
  const s = checkSecSearch(body);
  const all = await secTickers(db, deps);
  const seen = new Set(); const results = [];
  // Exact ticker first, then names that start with the words, then names that contain them.
  const score = ([, name, ticker]) => (ticker.toLowerCase() === s.q ? 0 : name.toLowerCase().startsWith(s.q) ? 1 : name.toLowerCase().includes(s.q) ? 2 : 9);
  for (const r of all.filter((r) => score(r) < 9).sort((a, b) => score(a) - score(b))) {
    if (seen.has(r[0])) continue;   // one row per company, not per share class
    seen.add(r[0]);
    results.push({ name: r[1], ticker: r[2], exchange: r[3], cik: r[0], website: null, domain: null, industry: null, employees: null, founded: null,
      hq: null, state: null, phone: null, source_url: edgarUrl(r[0]) });
    if (results.length >= 100) break;
  }
  await cached(db, 'company-results', JSON.stringify(s), 7 * DAY, async () => results, deps.nowMs, { replace: true });
  return { search: s, results };
}

/** Industry, address, phone and website for up to MAX_SEC_DETAILS picked companies. */
export async function secDetails(db, deps, body) {
  const s = checkSecSearch(body?.search);
  const ciks = [...new Set((Array.isArray(body?.ciks) ? body.ciks : []).filter((c) => Number.isInteger(c) && c > 0))];
  if (!ciks.length) fail(400, 'Pick at least one company');
  if (ciks.length > MAX_SEC_DETAILS) fail(400, `Up to ${MAX_SEC_DETAILS} companies at a time (SEC asks for at most 10 requests a second)`);
  const key = JSON.stringify(s);
  const list = await peek(db, 'company-results', key, deps.nowMs);
  if (!list) fail(409, 'That search is not saved any more. Search again.');
  const details = {};
  for (const cik of ciks) {
    const { value } = await cached(db, 'sec-company', String(cik), 30 * DAY, async () => {
      const res = await openFetch(db, deps, `https://data.sec.gov/submissions/CIK${cik10(cik)}.json`, { needsContact: true });
      if (!res.ok) fail(502, `SEC answered ${res.status} for company ${cik}`);
      const j = await res.json();
      const ad = j.addresses?.business || {};
      return { industry: cap(j.sicDescription), phone: cap(j.phone), website: cap(j.website) || null,
        hq: [cap(ad.street1), cap(ad.city), [cap(ad.stateOrCountry), cap(ad.zipCode)].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
        state: US_STATES.includes(ad.stateOrCountry) ? ad.stateOrCountry : null };
    }, deps.nowMs);
    details[cik] = value;
  }
  const merged = list.map((c) => (details[c.cik] ? { ...c, ...details[c.cik], domain: domainOf(details[c.cik].website) } : c));
  await cached(db, 'company-results', key, 7 * DAY, async () => merged, deps.nowMs, { replace: true });
  return { search: s, results: merged };
}

/** The saved rows of a company search, for Import. */
export function checkCompanySearch(body) {
  if (body?.source === 'lookalikes') return checkLookalikeSearch(body);
  return body?.source === 'sec' ? checkSecSearch(body) : checkWikidataSearch(body);
}

