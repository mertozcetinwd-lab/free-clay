/**
 * Sources: ways rows get INTO a table besides CSV. Google Places search (your key) makes one row
 * per business. Rows already in the table (same Place ID) are skipped, so re-running a search
 * never duplicates.
 */

import { fail, nowIso, parseJson } from './util.js';
import { getTableRow, loadColumns, createColumn, insertRows, hooks } from './tables.js';
import { mapHeaders } from './csv.js';
import { secretValue } from './runner.js';
import { placesSearch, placeRow, PLACES_COST } from './functions/byok.js';

const PLACE_COLUMNS = [
  ['name', 'Name', 'text'], ['address', 'Address', 'text'], ['phone', 'Phone', 'text'], ['website', 'Website', 'url'],
  ['rating', 'Rating', 'number'], ['reviews', 'Reviews', 'number'], ['maps_url', 'Maps link', 'url'],
  ['place_id', 'Place ID', 'text'], ['status', 'Business status', 'select'],
];

export async function placesSource(env, tableId, body, deps = {}) {
  const db = env.DB;
  const fetch = deps.fetch || globalThis.fetch;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  await getTableRow(db, tableId);
  const query = String(body?.query || '').trim();
  if (!query || query.length > 300) fail(400, 'Type what to search for, like "roofers in Gainesville FL"');
  const pages = Math.max(1, Math.min(3, Number(body.pages) || 1));    // Google stops at 3 pages of 20
  const budget = Number.isInteger(body.budget_micros) ? body.budget_micros : parseJson((await db.prepare(`SELECT value FROM settings WHERE key='default_budget_micros'`).first())?.value, 1_000_000);
  const overrides = parseJson((await db.prepare(`SELECT value FROM settings WHERE key='cost_overrides'`).first())?.value, {}) || {};
  const perCall = Number.isInteger(overrides.places_lookup) ? overrides.places_lookup : PLACES_COST;
  if (perCall * pages > budget) fail(400, `${pages} page${pages > 1 ? 's' : ''} can cost up to $${(perCall * pages / 1e6).toFixed(3)}, over this search's $${(budget / 1e6).toFixed(2)} budget`);
  const key = secretValue(env, 'GOOGLE_MAPS_API_KEY');

  const places = []; const ledger = []; let token = null;
  for (let i = 0; i < pages; i++) {
    if (i) await sleep(2000);   // a next-page token is not valid for ~2 s (references/google-places-api.md)
    let j;
    try { j = await placesSearch(fetch, key, query, token); }
    catch (e) { ledger.push([0, 'error', e.message]); if (!places.length) { await writeLedger(db, tableId, ledger); fail(502, e.message); } break; }
    ledger.push([perCall, 'done', `${query} (page ${i + 1})`]);
    places.push(...(j.places || []));
    token = j.nextPageToken;
    if (!token) break;
  }
  await writeLedger(db, tableId, ledger);

  let cols = await loadColumns(db, tableId);
  const mapped = mapHeaders(PLACE_COLUMNS.map((c) => c[1]), cols);
  const keyFor = {};
  for (let i = 0; i < PLACE_COLUMNS.length; i++) {
    const [field, label, type] = PLACE_COLUMNS[i];
    if (!mapped[i]) { const c = await createColumn(db, tableId, { name: label, type }); cols.push(c); mapped[i] = c.key; }
    keyFor[field] = mapped[i];
  }
  const { results } = await db.prepare(`SELECT json_extract(data, ?2) AS pid FROM rows WHERE table_id=?1`).bind(tableId, `$."${keyFor.place_id}"`).all();
  const have = new Set(results.map((r) => r.pid).filter(Boolean));
  const fresh = places.map(placeRow).filter((p) => p.place_id && !have.has(p.place_id) && have.add(p.place_id));
  const rows = fresh.map((p) => Object.fromEntries(Object.entries(p).map(([f, v]) => [keyFor[f], v])));
  const added = rows.length ? await insertRows(db, tableId, rows, cols) : 0;
  if (added) await hooks.afterWrite(db, tableId, { newRows: true });
  return { found: places.length, added, skipped_duplicates: places.length - added, cost_micros: ledger.reduce((a, l) => a + l[0], 0) };
}

export async function writeLedger(db, tableId, entries) {
  if (!entries.length) return;
  const ts = nowIso();
  await db.batch(entries.map(([cost, outcome, note]) => db.prepare(`INSERT INTO ledger (ts, table_id, provider, cost_micros, outcome, note)
      VALUES (?1, ?2, 'places_search', ?3, ?4, ?5)`).bind(ts, tableId, cost, outcome, String(note).slice(0, 300))));
}
