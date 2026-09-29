/**
 * The local-business search, shared by the browser and the Worker (src/opendata/osm.js).
 *
 * Why the browser runs the query: in the live check of 2026-09-28 every public Overpass server
 * failed from the Worker (overpass-api.de 521; the two backups timed out after ~2 minutes), while
 * the same servers accept requests from an ordinary browser and allow them cross-site (CORS). So
 * the browser asks Overpass, and the Worker checks, caches and imports what came back.
 */

/** Trades and local services, as their usual OSM tags. A search can also use any key=value tag. */
export const LOCAL_CATEGORIES = {
  roofer: ['Roofers', 'craft=roofer'],
  plumber: ['Plumbers', 'craft=plumber'],
  hvac: ['HVAC', 'craft=hvac'],
  electrician: ['Electricians', 'craft=electrician'],
  painter: ['Painters', 'craft=painter'],
  carpenter: ['Carpenters', 'craft=carpenter'],
  gardener: ['Landscapers and gardeners', 'craft=gardener'],
  car_repair: ['Auto repair', 'shop=car_repair'],
  dentist: ['Dentists', 'amenity=dentist'],
  doctors: ['Doctors', 'amenity=doctors'],
  veterinary: ['Vets', 'amenity=veterinary'],
  hairdresser: ['Hair salons and barbers', 'shop=hairdresser'],
  fitness: ['Gyms', 'leisure=fitness_centre'],
  lawyer: ['Lawyers', 'office=lawyer'],
  accountant: ['Accountants', 'office=accountant'],
  estate_agent: ['Real estate agents', 'office=estate_agent'],
  insurance: ['Insurance agents', 'office=insurance'],
  cleaning: ['Cleaning services', 'craft=cleaning'],
};

/** Public Overpass servers, in the order tried (wiki.openstreetmap.org/wiki/Overpass_API). */
export const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const TAG_RE = /^([a-z][a-z0-9_:]{0,40})=([a-z0-9_ ;:.-]{1,60})$/i;
export const MAX_RADIUS_M = 25_000;
export const MAX_RESULTS = 200;

export class AreaError extends Error {}

/** A search, checked and normalised. It is also the cache key, so both sides must agree on it. */
export function checkArea(body) {
  const lat = Number(body?.lat); const lon = Number(body?.lon); const r = Math.round(Number(body?.radius_m));
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) throw new AreaError('Pick a point on the map first');
  if (!(r >= 100 && r <= MAX_RADIUS_M)) throw new AreaError(`Radius must be 100 m to ${MAX_RADIUS_M / 1000} km`);
  const tag = body.category ? LOCAL_CATEGORIES[body.category]?.[1] : String(body.tag || '').trim();
  const m = TAG_RE.exec(tag || '');
  if (!m) throw new AreaError(body.category ? 'Unknown category' : 'Pick a category, or type an OSM tag like craft=roofer');
  // 5 decimals is ~1 m: enough precision, and near-identical searches share a cache entry.
  return { lat: +lat.toFixed(5), lon: +lon.toFixed(5), r, key: m[1], value: m[2] };
}

/**
 * The square around the circle, as south, west, north, east. Overpass answers a bounding box
 * straight from its index; around:radius makes it measure distance to every candidate, which is
 * the slow form and the likeliest reason for the 504s and 429s in the live runs. The corners of
 * the square are trimmed afterwards by inCircle.
 */
const EARTH_R = 6_371_000;
const M_PER_DEG = (2 * Math.PI * EARTH_R) / 360;   // same Earth as distanceM, so the box holds the whole circle

export function bbox(a) {
  const dLat = a.r / M_PER_DEG;
  const dLon = a.r / (M_PER_DEG * Math.max(0.01, Math.cos((a.lat * Math.PI) / 180)));
  const f = (n) => +n.toFixed(5);
  return { s: f(a.lat - dLat), w: f(a.lon - dLon), n: f(a.lat + dLat), e: f(a.lon + dLon) };
}

/** Metres between two points (haversine). */
export function distanceM(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const x = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(x));
}

/** Keep businesses inside the circle; one with no known point is kept (it matched the box). */
export function inCircle(a, list) {
  return list.filter((b) => b.lat === null || b.lon === null || distanceM(a.lat, a.lon, b.lat, b.lon) <= a.r);
}

/** Named places with the tag inside the box; ways and relations come back with a center point. */
export function overpassQuery(a) {
  const b = bbox(a);
  return `[out:json][timeout:25];nwr["${a.key}"="${a.value}"]["name"](${b.s},${b.w},${b.n},${b.e});out center tags ${MAX_RESULTS};`;
}

/** Thrown when no server gave an answer; .log says what each one did. */
export class OverpassError extends Error {
  constructor(message, log) { super(message); this.log = log; }
}

/**
 * Run the query from the browser: each server in turn, 25 s each. Returns Overpass's elements.
 * A 429 (this address has used its query slots, often by earlier clicks still running) waits 5 s
 * and tries that server once more. A 400 means the query itself is wrong, so it stops there.
 */
export async function runOverpass(a, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const body = 'data=' + encodeURIComponent(overpassQuery(a));
  const log = [];
  for (const url of OVERPASS_SERVERS) {
    const host = new URL(url).host;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetchFn(url, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(25_000) });
      } catch (e) {
        log.push(`${host} ${e.name === 'TimeoutError' ? 'no answer in 25 s' : 'unreachable'}`);
        break;
      }
      if (res.ok) return (await res.json()).elements || [];
      if (res.status === 400) throw new AreaError('OpenStreetMap could not read that search. Check the tag.');
      if (res.status === 429 && attempt === 0) { await sleep(5000); continue; }
      log.push(`${host} ${res.status}${res.status === 429 ? ' (too many requests, after one retry)' : res.status === 504 ? ' (timed out)' : ''}`);
      break;
    }
  }
  throw new OverpassError(`No OpenStreetMap server could run the search: ${log.join(', ')}.`, log);
}
