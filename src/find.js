/**
 * Find leads: search open data, preview for free, then import into a table (LOAM-PLAN.md phase 6).
 * An import re-runs the same search, which the cache answers, so the rows written are the rows
 * the server fetched, not whatever the browser sends back.
 */

import { fail } from './util.js';
import { getTableRow, loadColumns, createColumn, createTable, insertRows, hooks } from './tables.js';
import { mapHeaders } from './csv.js';
import { localBusinesses, checkedArea } from './opendata/osm.js';
import { inCircle, bbox, LOCAL_CATEGORIES, MAX_RESULTS } from '../public/js/overpass.js';
import { cached, peek, DAY } from './opendata/cache.js';
import { checkOpenArea, placeLink, tidyPhone, tidyWebsite, MAX_OPEN_RESULTS } from '../public/js/open-places.js';
import { AreaError, distanceM } from '../public/js/overpass.js';
import { secretValue } from './runner.js';
import { placesLocal, PLACES_COST } from './functions/byok.js';
import { writeLedger } from './sources.js';
import { checkCompanySearch } from './opendata/companies.js';
import { checkJobSearch } from './opendata/jobs.js';
import { parseJson } from './util.js';
import { upsertRecords } from './audiences.js';
import { savedPeople, PEOPLE_COLUMNS } from './people.js';

const LOCAL_COLUMNS = [
  ['name', 'Name', 'text'], ['phone', 'Phone', 'text'], ['website', 'Website', 'url'], ['email', 'Email', 'email'],
  ['address', 'Address', 'text'], ['city', 'City', 'text'], ['hours', 'Opening hours', 'text'],
  ['osm_url', 'Map link', 'url'], ['lat', 'Latitude', 'number'], ['lon', 'Longitude', 'number'],
  ['listing', 'Listing', 'url'],   // open data only: a directory page (BBB, Yelp) that was in the website field
];

/** Find or create the columns a source needs, matched by name like CSV headers. field -> key. */
export async function columnsFor(db, tableId, spec) {
  const cols = await loadColumns(db, tableId);
  const mapped = mapHeaders(spec.map((c) => c[1]), cols);
  const keyFor = {};
  for (let i = 0; i < spec.length; i++) {
    const [field, label, type] = spec[i];
    if (!mapped[i]) { const c = await createColumn(db, tableId, { name: label, type }); cols.push(c); mapped[i] = c.key; }
    keyFor[field] = mapped[i];
  }
  return { cols, keyFor };
}

/**
 * Google Maps for the same map search, on your own key: what Clay's "Find local businesses" uses
 * (site-teardowns/clay/teardown.md 3.4), without Clay's credits on top. Text Search Enterprise
 * (the tier that returns phone and website) is $35 per 1,000 requests with 1,000 free a month,
 * per Google's pricing as checked 2026-09-28 (references/loam-sources.md). One request returns up
 * to 20 businesses; up to 3 pages. The budget is checked before the first request and every
 * request is ledgered, like any paid call.
 */
export async function googleLocal(env, deps, body) {
  const db = env.DB;
  const a = checkedArea(body);
  const pages = Math.max(1, Math.min(3, Number(body.pages) || 1));
  const overrides = parseJson((await db.prepare(`SELECT value FROM settings WHERE key='cost_overrides'`).first())?.value, {}) || {};
  const perCall = Number.isInteger(overrides.places_lookup) ? overrides.places_lookup : PLACES_COST;
  const budget = parseJson((await db.prepare(`SELECT value FROM settings WHERE key='default_budget_micros'`).first())?.value, 1_000_000);
  if (perCall * pages > budget) fail(400, `${pages} page${pages > 1 ? 's' : ''} can cost up to $${(perCall * pages / 1e6).toFixed(3)}, over your $${(budget / 1e6).toFixed(2)} budget per run (Settings, General).`);
  let key;
  try { key = secretValue(env, 'GOOGLE_MAPS_API_KEY'); } catch { fail(400, 'Set your Google Maps key first. In the free-clay folder run: npx wrangler secret put GOOGLE_MAPS_API_KEY'); }
  const word = body.category ? LOCAL_CATEGORIES[body.category][0].toLowerCase() : a.value.replace(/_/g, ' ');
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const found = []; const ledger = []; let token = null;
  for (let i = 0; i < pages; i++) {
    if (i) await sleep(2000);   // a next-page token is not valid for ~2 s (references/google-places-api.md)
    let j;
    try { j = await placesLocal(deps.fetch || fetch, key, word, bbox(a), token); }
    catch (e) { ledger.push([0, 'error', e.message]); if (!found.length) { await writeLedger(db, null, ledger); fail(502, e.message); } break; }
    ledger.push([perCall, 'done', `${word} near ${a.lat},${a.lon} (page ${i + 1})`]);
    found.push(...(j.places || []));
    token = j.nextPageToken;
    if (!token) break;
  }
  await writeLedger(db, null, ledger);
  const results = inCircle(a, found.map(googleBusiness).filter(Boolean)).slice(0, MAX_RESULTS);
  await cached(db, 'local-results', JSON.stringify(a), 7 * DAY, async () => results, deps.nowMs, { replace: true });
  return { area: a, results, via: 'google', cost_micros: ledger.reduce((s2, l) => s2 + l[0], 0) };
}

function googleBusiness(p) {
  const name = p.displayName?.text;
  if (!name || !p.googleMapsUri) return null;
  const parts = String(p.formattedAddress || '').split(',').map((x) => x.trim());
  return {
    name, phone: p.nationalPhoneNumber || null, website: p.websiteUri || null, email: null,
    address: p.formattedAddress || null, city: parts.length >= 3 ? parts[parts.length - 3] : null, hours: null,
    lat: typeof p.location?.latitude === 'number' ? p.location.latitude : null,
    lon: typeof p.location?.longitude === 'number' ? p.location.longitude : null,
    osm_url: p.googleMapsUri,
  };
}

/**
 * Open data (Overture Places tiles, public/js/open-places.js). The browser searched the tiles; the
 * Worker checks each business, keeps only known fields with every string capped, drops any
 * outside the circle, rebuilds the link itself (it is also Import's dedupe key), and caches the
 * list 7 days so Import writes exactly what was previewed. The Worker does not read the tiles:
 * a Miami tile is 5.4 MB of JSON, too much parsing for the free plan's CPU time per request.
 */
export async function openBusinesses(db, deps, body) {
  const a = openArea(body);
  const list = body.places;
  if (!Array.isArray(list)) fail(400, 'places must be a list');
  if (list.length > MAX_OPEN_RESULTS) fail(400, `Up to ${MAX_OPEN_RESULTS} results per search`);
  const results = list.map(cleanPlace).filter((b) => b && distanceM(a.lat, a.lon, b.lat, b.lon) <= a.r + 1);
  await cached(db, 'local-results', JSON.stringify(a), 7 * DAY, async () => results, deps.nowMs, { replace: true });
  return { area: a, results, via: 'open' };
}

function openArea(body) {
  try { return checkOpenArea(body); } catch (e) { if (e instanceof AreaError) fail(400, e.message); throw e; }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);

function cleanPlace(p) {
  if (!p || typeof p !== 'object') return null;
  const name = str(p.name);
  const lat = Number(p.lat); const lon = Number(p.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const address = str(p.address);
  // Tidied here too (both are idempotent), so a row is clean whatever the browser sent.
  const site = tidyWebsite(str(p.website) || str(p.listing));
  return { name, phone: str(tidyPhone(str(p.phone))), website: str(site.website), listing: str(site.listing), email: str(p.email), address, city: str(p.city), hours: null,
    lat, lon, osm_url: placeLink(name, address) };
}

/** The previewed rows of a search, from the cache. Open data and OpenStreetMap/Google key differently. */
async function savedResults(db, deps, search) {
  if (search?.source !== 'open') return (await localBusinesses(db, deps, search)).results;
  const hit = await peek(db, 'local-results', JSON.stringify(openArea(search)), deps.nowMs);
  if (!hit) fail(409, 'That search is not saved any more. Press Search this area again.');
  return hit;
}

/** body: {search, table_id | new_name, only?: [osm_url]} */
export async function importLocal(db, deps, body) {
  const results = await savedResults(db, deps, body?.search);
  // The Listing column only when this import has listings, so OSM and Google imports stay as they were.
  const spec = results.some((b) => b.listing) ? LOCAL_COLUMNS : LOCAL_COLUMNS.filter(([f]) => f !== 'listing');
  return importFound(db, body, results, spec, 'osm_url', 'Local businesses');
}

const COMPANY_COLUMNS = [
  ['name', 'Company', 'text'], ['website', 'Website', 'url'], ['domain', 'Domain', 'text'], ['industry', 'Industry', 'text'],
  ['employees', 'Employees', 'number'], ['founded', 'Founded', 'number'], ['hq', 'Headquarters', 'text'], ['state', 'State', 'text'],
  ['phone', 'Phone', 'text'], ['ticker', 'Ticker', 'text'], ['exchange', 'Exchange', 'text'], ['source_url', 'Source link', 'url'],
];
const JOB_COLUMNS = [
  ['title', 'Role', 'text'], ['company', 'Company', 'text'], ['location', 'Location', 'text'], ['department', 'Department', 'text'],
  ['posted', 'Posted', 'date'], ['ats', 'Job board', 'text'], ['url', 'Job link', 'url'],
];

async function saved(db, deps, source, search) {
  const hit = await peek(db, source, JSON.stringify(search), deps.nowMs);
  if (!hit) fail(409, 'That search is not saved any more. Search again.');
  return hit;
}

/** body: {search, table_id | new_name, only?: [source_url]} */
export async function importCompanies(db, deps, body) {
  const results = await saved(db, deps, 'company-results', checkCompanySearch(body?.search));
  return importFound(db, body, results, COMPANY_COLUMNS, 'source_url', 'Companies');
}

/** body: {search, table_id | new_name, only?: [url]} */
export async function importJobs(db, deps, body) {
  const results = await saved(db, deps, 'job-results', checkJobSearch(body?.search));
  return importFound(db, body, results, JOB_COLUMNS, 'url', 'Open roles');
}

/**
 * Write saved search results into a table. keyField is the link each row carries: Import skips
 * rows whose link is already in the table, so importing the same search twice adds nothing.
 */
async function importFound(db, body, results, spec, keyField, defaultName) {
  let tableId = body.table_id;
  if (tableId) await getTableRow(db, tableId);
  else {
    const t = await createTable(db, { name: String(body.new_name || defaultName).slice(0, 80) });
    tableId = t.id;
    // A new table starts with an empty Name column; the source's own Name takes its place.
  }
  const { cols, keyFor } = await columnsFor(db, tableId, spec);
  const only = Array.isArray(body.only) ? new Set(body.only) : null;
  const { results: have } = await db.prepare('SELECT json_extract(data, ?2) AS u FROM rows WHERE table_id=?1').bind(tableId, `$."${keyFor[keyField]}"`).all();
  const seen = new Set(have.map((r) => r.u).filter(Boolean));
  const fresh = results.filter((b) => (!only || only.has(b[keyField])) && !seen.has(b[keyField]) && seen.add(b[keyField]));
  if (only && !fresh.length && !results.some((b) => only.has(b[keyField]))) fail(400, 'None of the picked rows are in this search any more. Search again.');
  const rows = fresh.map((b) => Object.fromEntries(Object.entries(b).filter(([f]) => keyFor[f]).map(([f, v]) => [keyFor[f], v])));
  const added = rows.length ? await insertRows(db, tableId, rows, cols) : 0;
  if (added) await hooks.afterWrite(db, tableId, { newRows: true });
  return { table_id: tableId, added, skipped_duplicates: (only ? only.size : results.length) - added };
}

/**
 * Save picked results into the Companies database instead of a table (phase 7). Same saved search
 * as Import, so what is written is what the server fetched. body: {search, only?: [link]}
 */
export async function localToCompanies(db, deps, body) {
  const results = await savedResults(db, deps, body?.search);
  const only = Array.isArray(body.only) && body.only.length ? new Set(body.only) : null;
  const list = results.filter((b) => !only || only.has(b.osm_url)).map((b) => ({ name: b.name, phone: b.phone, website: b.website, email: b.email,
    address: b.address, city: b.city, map_link: b.osm_url }));
  return upsertRecords(db, 'companies', list, 'Find leads: local businesses');
}

export async function companiesToAudience(db, deps, body) {
  const results = await saved(db, deps, 'company-results', checkCompanySearch(body?.search));
  const only = Array.isArray(body.only) && body.only.length ? new Set(body.only) : null;
  const list = results.filter((b) => !only || only.has(b.source_url)).map((b) => ({ name: b.name, website: b.website, domain: b.domain, industry: b.industry,
    employees: b.employees, founded: b.founded, city: b.hq, state: b.state, phone: b.phone, ticker: b.ticker }));
  return upsertRecords(db, 'companies', list, 'Find leads: companies');
}

/** body: {search, table_id | new_name, only?: [key]}. The rows are the cached treg answer. */
export async function importPeople(db, deps, body) {
  const results = await savedPeople(db, deps, body?.search);
  const spec = results.some((p) => p.email) ? PEOPLE_COLUMNS : PEOPLE_COLUMNS.filter(([f]) => f !== 'email');
  return importFound(db, body, results, spec, 'key', 'People');
}
