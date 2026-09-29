/**
 * Open data search: businesses from Overture Maps Places, served as static tiles by the Worker's
 * own assets, so a search costs nothing and calls no outside server. Shared by the browser (which
 * reads the tiles) and the Worker (which checks what the browser found before it is imported).
 *
 * Why tiles and not D1: the Florida slice is 1.18M places (Overture release 2026-09-23.0), and the
 * D1 free plan allows 100,000 rows written a day, enforced since 2026-09-01 (Cloudflare changelog),
 * so loading it would take 12 days. Static assets are free: 20,000 files of up to 25 MiB each on
 * the free plan. The whole US would be far more than 20,000 tiles on a fixed 0.1 degree grid, so
 * tiles are adaptive (a quadtree): a 1 degree cell is split in four while it holds more than
 * TILE_MAX_ROWS places, down to 1/64 degree (about 1.7 km). Wyoming stays in big tiles, Miami
 * in small ones: 5,898 tiles for 15.5M US places, the largest 6.3 MB (Manhattan). dev/get-places.mjs builds them from
 * github.com/mertozcetinwd-lab/free-clay-data.
 *
 * Licences: Overture Places is CDLA Permissive 2.0, with some records Apache 2.0 (Foursquare) or
 * CC0 (AllThePlaces); every one allows commercial use. The page credits Overture.
 */

import { bbox, distanceM, LOCAL_CATEGORIES, AreaError, MAX_RADIUS_M } from './overpass.js';

export const TILE_ROOT = '/data/places';
export const TILE_MAX_ROWS = 8_000;
export const MAX_LEVEL = 6;          // 1 degree / 2^6 = 1/64 degree, about 1.7 km
export const MAX_OPEN_RESULTS = 1000;
export const MAX_TILES = 150;        // a 25 km circle over the densest cities; past this the download is too big

/** Our categories, as Overture's category names (checked against the Florida data, 2026-09-28). */
export const OPEN_CATEGORIES = {
  roofer: ['roofing', 'ceiling_and_roofing_repair_and_service'],
  plumber: ['plumbing'],
  hvac: ['hvac_service'],
  electrician: ['electrician'],
  painter: ['painting'],
  carpenter: ['carpenter'],
  gardener: ['landscaping', 'gardener', 'lawn_service'],
  car_repair: ['automotive_repair', 'auto_body_shop', 'automotive_service'],
  dentist: ['dental_clinic', 'general_dentistry', 'cosmetic_dentistry', 'pediatric_dentistry'],
  doctors: ['doctors_office'],
  veterinary: ['veterinarian', 'veterinary_care'],
  hairdresser: ['hair_salon', 'barber', 'hair_stylist'],
  fitness: ['gym', 'fitness_trainer', 'sport_or_fitness_facility'],
  lawyer: ['attorney_or_law_firm'],
  accountant: ['accountant'],
  estate_agent: ['real_estate_agent'],
  insurance: ['insurance_agency'],
  cleaning: ['home_cleaning', 'cleaning_service', 'office_cleaning', 'carpet_cleaning'],
};

/** A tile row, in this order. dev/get-places.mjs writes it; nothing else does. */
export const TILE_COLUMNS = ['id', 'name', 'category', 'alt_categories', 'phone', 'website', 'email', 'address', 'city', 'zip', 'lat', 'lon', 'state'];

const WORD_RE = /^[a-z][a-z0-9_]{1,59}$/;

/** A search, checked. `cats` is the list of Overture categories it matches. Also the cache key. */
export function checkOpenArea(body) {
  const lat = Number(body?.lat); const lon = Number(body?.lon); const r = Math.round(Number(body?.radius_m));
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) throw new AreaError('Pick a point on the map first');
  if (!(r >= 100 && r <= MAX_RADIUS_M)) throw new AreaError(`Radius must be 100 m to ${MAX_RADIUS_M / 1000} km`);
  let cats;
  if (body.category) {
    cats = OPEN_CATEGORIES[body.category];
    if (!cats) throw new AreaError('Unknown category');
  } else {
    const w = String(body.tag || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!WORD_RE.test(w)) throw new AreaError('Pick a category, or type one like pest_control_service');
    cats = [w];
  }
  return { source: 'open', lat: +lat.toFixed(5), lon: +lon.toFixed(5), r, cats };
}

// Rounded to micro-degrees first, so 29.5 lands in the right cell and not the one below through float error.
export const cellAt = (d, level) => Math.floor((Math.round(d * 1e6) * 2 ** level) / 1e6);
/** The tile at a level: "level_y_x". Tiles at different levels never overlap (a quadtree's leaves). */
export const tileName = (lat, lon, level = 0) => `${level}_${cellAt(lat, level)}_${cellAt(lon, level)}`;

/** Every existing tile the circle's box touches, at whatever level it was cut. have: Set of names. */
export function tilesFor(a, have) {
  const b = bbox(a); const out = [];
  for (let L = 0; L <= MAX_LEVEL; L++) {
    for (let y = cellAt(b.s, L); y <= cellAt(b.n, L); y++) {
      for (let x = cellAt(b.w, L); x <= cellAt(b.e, L); x++) { const t = `${L}_${y}_${x}`; if (have.has(t)) out.push(t); }
    }
  }
  return out;
}

/**
 * Cut rows into tiles. countAt maps every cell name, at every level, to how many rows fall in it;
 * a cell is split while it holds more than maxRows and is above MAX_LEVEL. Returns a function from
 * a point to its leaf tile name. dev/get-places.mjs counts in a first pass and writes in a second.
 */
export function leafFinder(countAt, maxRows = TILE_MAX_ROWS) {
  return (lat, lon) => {
    for (let L = 0; L < MAX_LEVEL; L++) {
      const t = tileName(lat, lon, L);
      if ((countAt.get(t) || 0) <= maxRows) return t;
    }
    return tileName(lat, lon, MAX_LEVEL);
  };
}

/** A tile file: one JSON row per line, each ending in a comma, so the builder can append. */
export const parseTile = (text) => JSON.parse('[' + text.replace(/,\s*$/, '') + ']');

/** The link on every row, and the key Import dedupes on: Google Maps, searched by name and address. */
export function placeLink(name, address) {
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([name, address].filter(Boolean).join(', '));
}

function matches(cats, category, alt) {
  if (cats.includes(category)) return true;
  if (!alt) return false;
  return alt.split(';').some((c) => cats.includes(c));
}

/** US numbers as (352) 900-3335; the data mixes 3529003335, +13529003335 and 352-900-3335. Others stay as they came. */
export function tidyPhone(p) {
  if (!p) return null;
  const d = String(p).replace(/\D/g, '');
  const n = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return n.length === 10 ? `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` : String(p).trim();
}

/**
 * Sites that list a business but are not its own site: 10,747 of the 929,488 Florida websites
 * (1.2%, counted 2026-09-28), mostly linktr.ee, Instagram and Facebook. Kept as Listing, so an
 * enrichment that scrapes the Website column does not scrape Yelp instead of the roofer.
 * Subdomains count (m.facebook.com), except Google's: sites.google.com is a business's own site.
 */
const GOOGLE_LISTINGS = ['google.com', 'maps.google.com', 'business.google.com', 'goo.gl', 'maps.app.goo.gl'];
export const DIRECTORY_HOSTS = ['bbb.org', 'yelp.com', 'facebook.com', 'instagram.com', 'yellowpages.com', 'angi.com', 'angieslist.com',
  'homeadvisor.com', 'thumbtack.com', 'nextdoor.com', 'houzz.com', 'manta.com', 'mapquest.com', 'linktr.ee', 'porch.com', 'buildzoom.com',
  'g.page', 'x.com', 'twitter.com', 'linkedin.com', 'tiktok.com', 'youtube.com'];
const TRACKING = /^(utm_\w+|gclid|fbclid|msclkid|y_source|mc_\w+)$/i;

/** {website, listing}: tracking parameters removed, https:// added when missing, directories moved to listing. */
export function tidyWebsite(w) {
  if (!w) return { website: null, listing: null };
  let u;
  try { u = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`); } catch { return { website: String(w).trim(), listing: null }; }
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  const clean = u.toString().replace(/\?$/, '');
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const dir = GOOGLE_LISTINGS.includes(host) || DIRECTORY_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
  return dir ? { website: null, listing: clean } : { website: clean, listing: null };
}

export function rowToBusiness(row) {
  const [id, name, category, , phone, website, email, address, city, zip, lat, lon, state] = row;
  const tidy = (v) => (v ? String(v).replace(/\s+/g, ' ').trim() : '');   // the data has "St  Ste 1110"
  const full = [tidy(address), tidy(city), [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return { name, phone: tidyPhone(phone), ...tidyWebsite(website), email: email || null, address: full, city: city || null, hours: null,
    category: category || null, lat, lon, osm_url: placeLink(name, full), source_id: id };
}

/**
 * Search the tiles. index: {tiles: [names]} from index.json; getTile(name) resolves to its rows.
 * Nearest first, at most MAX_OPEN_RESULTS. Returns {results, tiles} or throws AreaError.
 */
export async function searchOpenPlaces(a, index, getTile) {
  const names = tilesFor(a, new Set(index.tiles || []));
  if (names.length > MAX_TILES) throw new AreaError('That search covers too many places to load in the browser. Use a smaller radius here.');
  if (!names.length) throw new AreaError(`Open data covers ${index.region || 'the US'}. Move the map there, or use Google Maps.`);
  const rows = (await Promise.all(names.map(getTile))).flat();
  const found = [];
  for (const row of rows) {
    if (!matches(a.cats, row[2], row[3])) continue;
    const d = distanceM(a.lat, a.lon, row[10], row[11]);
    if (d <= a.r) found.push([d, row]);
  }
  found.sort((x, y) => x[0] - y[0]);
  return { results: found.slice(0, MAX_OPEN_RESULTS).map(([, row]) => rowToBusiness(row)), tiles: names.length };
}

export { LOCAL_CATEGORIES };
