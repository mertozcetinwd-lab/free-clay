/**
 * Local businesses from OpenStreetMap, the free alternative to Clay's Google Maps source.
 *
 * geocode: Nominatim turns "Gainesville, FL" into a point. Its policy allows 1 request per second
 * summed over all users, needs an identifying User-Agent and requires caching
 * (operations.osmfoundation.org/policies/nominatim, read 2026-09-28), so every answer is cached 30
 * days and a search makes at most one call. It works from the Worker (47 ms in the live check).
 * localBusinesses: the browser runs the Overpass query (public/js/overpass.js says why); the Worker
 * checks what came back, caches it 7 days and imports from that cache. OSM data is ODbL: the import
 * records the OSM link on every row.
 */

import { fail } from '../util.js';
import { openFetch } from './http.js';
import { cached, peek, DAY } from './cache.js';
import { checkArea, AreaError, MAX_RESULTS, LOCAL_CATEGORIES, bbox, inCircle } from '../../public/js/overpass.js';

export { LOCAL_CATEGORIES, OVERPASS_SERVERS, MAX_RADIUS_M, MAX_RESULTS } from '../../public/js/overpass.js';

const MAX_ELEMENTS = 1000;
const TYPES = ['node', 'way', 'relation'];

export async function geocode(db, deps, q) {
  q = String(q || '').trim();
  if (!q || q.length > 200) fail(400, 'Type a place, like "Gainesville, FL"');
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const { value, cached: hit } = await cached(db, 'nominatim', q.toLowerCase(), 30 * DAY, async () => {
    const res = await openFetch(db, deps, url, { needsContact: true });
    if (!res.ok) fail(502, `OpenStreetMap place search answered ${res.status}. Try again in a minute.`);
    const [first] = await res.json();
    return first ? { lat: Number(first.lat), lon: Number(first.lon), name: first.display_name } : null;
  }, deps.nowMs);
  if (!value) fail(404, `No place called "${q}" on OpenStreetMap`);
  return { ...value, cached: hit };
}

export function checkedArea(body) { return area(body); }

function area(body) {
  try { return checkArea(body); } catch (e) { if (e instanceof AreaError) fail(400, e.message); throw e; }
}

/**
 * body: the search, plus `elements` when the browser has just run it against Overpass. The Worker
 * checks each element, keeps the fields it knows (toBusiness caps every string), caches the result
 * for 7 days and returns it. Without elements it answers from the cache, which is how an import
 * gets the same rows the person previewed. The Worker never calls Overpass itself: from Cloudflare
 * every server failed or hung for minutes (live check 2026-09-28).
 */
export async function localBusinesses(db, deps, body) {
  const a = area(body);
  const key = JSON.stringify(a);
  if (Array.isArray(body.elements)) {
    if (body.elements.length > MAX_ELEMENTS) fail(400, `Up to ${MAX_ELEMENTS} results per search`);
    const ok = body.elements.filter((el) => el && typeof el === 'object' && TYPES.includes(el.type) && Number.isInteger(el.id) && el.tags && typeof el.tags === 'object');
    const results = inCircle(a, ok.map(toBusiness).filter(Boolean)).slice(0, MAX_RESULTS);
    await cached(db, 'local-results', key, 7 * DAY, async () => results, deps.nowMs, { replace: true });
    return { area: a, results, cached: false };
  }
  const hit = await peek(db, 'local-results', key, deps.nowMs);
  if (!hit) fail(409, 'That search is not saved any more. Press Search this area again.');
  return { area: a, results: hit, cached: true };
}

/**
 * The second route, from the Worker: Nominatim's search for the category word inside the box.
 * Nominatim answered the Worker in both live checks while every Overpass server failed, but it is
 * a place search, not a tag query: it returns at most 50 results and can miss businesses that
 * Overpass would find, so the page says so. One request per search (its policy allows 1 per
 * second), cached 7 days under the same key as Overpass so Import works the same way.
 */
export async function nominatimBusinesses(db, deps, body) {
  const a = area(body);
  const key = JSON.stringify(a);
  const word = body.category ? LOCAL_CATEGORIES[body.category][0].toLowerCase() : a.value.replace(/_/g, ' ');
  const b = bbox(a);
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=50&bounded=1&extratags=1&addressdetails=1`
    + `&viewbox=${b.w},${b.n},${b.e},${b.s}&q=${encodeURIComponent(word)}`;
  const { value } = await cached(db, 'nominatim-local', key, 7 * DAY, async () => {
    const res = await openFetch(db, deps, url, { needsContact: true });
    if (!res.ok) fail(502, `OpenStreetMap place search answered ${res.status}. Try again in a minute.`);
    const list = await res.json();
    return (Array.isArray(list) ? list : []).map(fromNominatim).filter(Boolean);
  }, deps.nowMs);
  const results = inCircle(a, value).slice(0, MAX_RESULTS);
  // Stored where Import looks, so importing these works exactly like an Overpass search.
  await cached(db, 'local-results', key, 7 * DAY, async () => results, deps.nowMs, { replace: true });
  return { area: a, results, via: 'nominatim' };
}

/** A Nominatim result, reshaped into an OSM element so toBusiness reads both routes the same way. */
function fromNominatim(r) {
  if (!r || !['node', 'way', 'relation'].includes(r.osm_type) || !Number.isInteger(r.osm_id)) return null;
  const ad = r.address || {};
  const tags = { ...(r.extratags || {}), name: r.name || String(r.display_name || '').split(',')[0] };
  const put = (k, v) => { if (v) tags[k] = String(v); };
  put('addr:housenumber', ad.house_number); put('addr:street', ad.road);
  put('addr:city', ad.city || ad.town || ad.village || ad.hamlet); put('addr:state', ad.state); put('addr:postcode', ad.postcode);
  return toBusiness({ type: r.osm_type, id: r.osm_id, lat: Number(r.lat), lon: Number(r.lon), tags });
}

/** One OSM element to one business. Tags follow the OSM wiki (contact:* and addr:*). */
export function toBusiness(el) {
  const t = {};
  // Every value is capped: the browser sends these elements, so the Worker trusts no length.
  for (const [k, v] of Object.entries(el.tags || {})) if (typeof v === 'string') t[k] = v.slice(0, 300);
  if (!t.name) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const lat = num(el.lat ?? el.center?.lat); const lon = num(el.lon ?? el.center?.lon);
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const website = t.website || t['contact:website'] || null;
  return {
    name: t.name,
    phone: t.phone || t['contact:phone'] || null,
    website,
    email: t.email || t['contact:email'] || null,
    address: [street, t['addr:city'], [t['addr:state'], t['addr:postcode']].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
    city: t['addr:city'] || null,
    hours: t.opening_hours || null,
    lat, lon,
    osm_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}
