/**
 * Functions that run on YOUR key. You pay the provider directly; free-clay adds nothing.
 * Request shapes are ported from the lead engine, where each was proven against the live API
 * (scripts/emailfind.py, scripts/exa.py, references/google-places-api.md). Tests use a fake fetch.
 *
 * COSTS. costMicros is the estimate a run reserves against its budget. Where a provider's free
 * tier covers normal use, the estimate is $0 and says so; once you are on a paid plan, put your
 * real per-call price in Settings, Prices, and every estimate and budget uses it.
 */

import { normalizeDomain, readCapped } from './web.js';

const done = (data) => ({ status: 'done', data });
const none = (data = {}) => ({ status: 'no_result', data });

/** A provider error with its own words, and the HTTP status for the ledger note. */
async function providerError(name, r) {
  let detail = '';
  try { detail = (await readCapped(r, 2000)).replace(/\s+/g, ' ').slice(0, 200); } catch { /* body unreadable */ }
  const hint = r.status === 401 || r.status === 403 ? ' (check the key)' : r.status === 429 ? ' (rate limit or out of credits)' : '';
  return new Error(`${name} HTTP ${r.status}${hint}: ${detail}`);
}

const splitName = (full) => { const p = String(full || '').trim().split(/\s+/); return [p[0] || '', p.length > 1 ? p[p.length - 1] : '']; };
const GOOD = ['valid', 'verified', 'deliverable'];

/* ---------------------------------------------------------------- Hunter */

export const hunter_email_finder = {
  id: 'hunter_email_finder', category: 'email', name: 'Hunter: find work email', group: 'Your key', secret: 'HUNTER_API_KEY',
  blurb: 'Email from first name, last name and company domain. Hunter only charges when it finds one.',
  inputs: [{ key: 'first_name', label: 'First name', required: true }, { key: 'last_name', label: 'Last name', required: true }, { key: 'domain', label: 'Company domain', required: true }],
  outputs: [
    { key: 'email', label: 'Email', type: 'email' }, { key: 'score', label: 'Hunter score', type: 'number' },
    { key: 'status', label: 'Verification', type: 'select' }, { key: 'position', label: 'Position', type: 'text' },
  ],
  primary: 'email', type: 'email', subrequests: 1, billing: 'per_hit',
  costMicros: 0, costSource: 'Free plan: 50 credits a month (Hunter, checked against the account 2026-07-31). On a paid plan, set your per-find price in Settings.',
  async run({ first_name, last_name, domain }, { fetch, secret }) {
    const d = normalizeDomain(domain);
    if (!d) throw new Error(`Not a domain: ${domain}`);
    const q = new URLSearchParams({ domain: d, first_name, last_name, api_key: secret('HUNTER_API_KEY') });
    const r = await fetch(`https://api.hunter.io/v2/email-finder?${q}`, { headers: { accept: 'application/json', 'user-agent': 'free-clay/1.0' } });
    if (r.status === 404) return none();
    if (!r.ok) throw await providerError('Hunter', r);
    const data = (await r.json())?.data || {};
    if (!data.email) return none();
    let status = String(data.verification?.status || '').toLowerCase();
    // Hunter reports catch-all at the top level, not in `verification` (scripts/emailfind.py found
    // this on stripe.com): a catch-all domain accepts anything, so the address is unproven.
    if (data.accept_all && !GOOD.includes(status)) status = 'accept_all';
    return done({ email: data.email, score: data.score ?? null, status: status || null, position: data.position || null });
  },
};

const RISKY = ['accept_all', 'accept-all', 'catch_all', 'risky'];   // see treg.js RISKY
export const hunter_email_verifier = {
  id: 'hunter_email_verifier', category: 'email', name: 'Hunter: verify email', group: 'Your key', secret: 'HUNTER_API_KEY', validates: 'email',
  blurb: 'Hunter checks the mailbox itself (SMTP), which a Worker cannot. Usable as a waterfall validation step.',
  inputs: [{ key: 'email', label: 'Email', required: true }],
  outputs: [{ key: 'result', label: 'Verification', type: 'select' }, { key: 'valid', label: 'Deliverable', type: 'checkbox' }, { key: 'score', label: 'Hunter score', type: 'number' },
    { key: 'acceptable', label: 'Valid or catch-all (risky)', type: 'checkbox' }],
  primary: 'result', type: 'select', subrequests: 1,
  costMicros: 0, costSource: 'Counts against your Hunter verification credits. Set a per-call price in Settings once you pay for them.',
  async run({ email }, { fetch, secret }) {
    const q = new URLSearchParams({ email: String(email).trim(), api_key: secret('HUNTER_API_KEY') });
    const r = await fetch(`https://api.hunter.io/v2/email-verifier?${q}`, { headers: { accept: 'application/json', 'user-agent': 'free-clay/1.0' } });
    if (!r.ok) throw await providerError('Hunter', r);
    const data = (await r.json())?.data || {};
    const result = String(data.status || data.result || '').toLowerCase() || 'unknown';
    return done({ result, valid: GOOD.includes(result), score: data.score ?? null, acceptable: GOOD.includes(result) || RISKY.includes(result) });
  },
};

/* ---------------------------------------------------------------- Prospeo */

export const prospeo_enrich_person = {
  id: 'prospeo_enrich_person', category: 'email', name: 'Prospeo: find work email', group: 'Your key', secret: 'PROSPEO_API_KEY',
  blurb: 'Email from full name and company website, or from a profile URL you already have. Misses are common on name alone.',
  inputs: [{ key: 'full_name', label: 'Full name', required: true }, { key: 'domain', label: 'Company website', required: true }, { key: 'profile_url', label: 'Profile URL you already have' }],
  outputs: [{ key: 'email', label: 'Email', type: 'email' }, { key: 'status', label: 'Prospeo status', type: 'select' }, { key: 'title', label: 'Job title', type: 'text' }],
  primary: 'email', type: 'email', subrequests: 1,
  costMicros: 0, costSource: 'Free plan: 75 credits a month (Prospeo, checked against the account 2026-07-31). On a paid plan, set your per-call price in Settings.',
  async run({ full_name, domain, profile_url }, { fetch, secret }) {
    // /enrich-person with a nested body: the old /email-finder answers 400 DEPRECATED since 2026-07 (scripts/emailfind.py).
    const data = profile_url ? { linkedin_url: String(profile_url).trim() } : { full_name: String(full_name).trim(), company_website: normalizeDomain(domain) || String(domain) };
    const r = await fetch('https://api.prospeo.io/enrich-person', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-KEY': secret('PROSPEO_API_KEY') },
      body: JSON.stringify({ only_verified_email: false, data }),
    });
    if (!r.ok) {
      // NO_MATCH arrives as HTTP 400: a clean miss, not a fault.
      const text = await readCapped(r, 2000);
      if (/NO_MATCH/i.test(text)) return none();
      throw new Error(`Prospeo HTTP ${r.status}: ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    const j = await r.json();
    const p = j?.response || {};
    const e = p.email;
    const email = typeof e === 'object' && e ? e.email || e.value : e;
    if (!email) return none();
    const status = String((typeof e === 'object' && e ? e.email_status || e.status : p.email_status) || '').toLowerCase() || null;
    return done({ email, status, title: p.job_title || p.title || null });
  },
};

/* ---------------------------------------------------------------- Exa */

const exaCost = (j) => Math.round(Number(j?.costDollars?.total || 0) * 1e6);

async function exa(fetch, secret, path, body) {
  const r = await fetch(`https://api.exa.ai${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': secret('EXA_API_KEY') }, body: JSON.stringify(body) });
  if (!r.ok) throw await providerError('Exa', r);
  return r.json();
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

export const exa_find_similar = {
  id: 'exa_find_similar', category: 'company', name: 'Exa: lookalike companies', group: 'Your key', secret: 'EXA_API_KEY',
  blurb: 'Sites most like this one, by meaning. Results can include pages ABOUT the company; check them.',
  inputs: [{ key: 'url', label: 'Website', required: true }],
  outputs: [{ key: 'similar', label: 'Lookalike domains', type: 'text' }, { key: 'top', label: 'Closest lookalike', type: 'url' }],
  primary: 'similar', type: 'text', subrequests: 1,
  costMicros: 7000, costSource: 'Measured: a findSimilar with 5 results billed $0.007 (scripts/exa.py, 2026-08-06). Exa returns the real cost, which the ledger records.',
  async run({ url }, { fetch, secret }) {
    const target = /^https?:\/\//i.test(String(url)) ? String(url) : `https://${normalizeDomain(url) || url}`;
    const self = hostOf(target);
    const j = await exa(fetch, secret, '/findSimilar', { url: target, numResults: 5 });
    const hosts = [...new Set((j.results || []).map((x) => hostOf(x.url)).filter((h) => h && h !== self))];
    const out = hosts.length ? done({ similar: hosts.join(', '), top: `https://${hosts[0]}` }) : none();
    return { ...out, cost_micros: exaCost(j) || undefined };
  },
};

export const exa_search = {
  id: 'exa_search', category: 'web', name: 'Exa: web search', group: 'Your key', secret: 'EXA_API_KEY',
  blurb: 'Search the web by meaning (e.g. "{{company}} roofing reviews"). Returns the top 5 results.',
  inputs: [{ key: 'query', label: 'Search query', required: true }],
  outputs: [{ key: 'top_url', label: 'Top result', type: 'url' }, { key: 'results', label: 'Top 5 results', type: 'text' }, { key: 'top_title', label: 'Top result title', type: 'text' }],
  primary: 'top_url', type: 'url', subrequests: 1,
  costMicros: 7000, costSource: 'Estimate from the measured findSimilar call (scripts/exa.py). Exa returns the real cost, which the ledger records.',
  async run({ query }, { fetch, secret }) {
    const j = await exa(fetch, secret, '/search', { query: String(query).slice(0, 500), numResults: 5 });
    const list = (j.results || []).filter((x) => x.url);
    const out = list.length ? done({ top_url: list[0].url, top_title: list[0].title || null, results: list.map((x) => x.url).join('\n') }) : none();
    return { ...out, cost_micros: exaCost(j) || undefined };
  },
};

/* ---------------------------------------------------------------- Google Places */

export const PLACES_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.rating,places.userRatingCount,places.googleMapsUri,places.businessStatus';
/** Enterprise SKU: websiteUri and phone bill at Enterprise. 1,000 free a month, then $35 per 1,000
 *  (Google's pricing page read 2026-09-15, references/google-places-api.md). The estimate uses the
 *  paid rate so a budget is never undercounted. */
export const PLACES_COST = 35_000;

export async function placesSearch(fetch, key, textQuery, pageToken) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACES_FIELDS + ',nextPageToken' },
    body: JSON.stringify({ textQuery, pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
  });
  if (!r.ok) throw await providerError('Google Places', r);
  return r.json();
}

/** Text Search inside a box (Places API New: locationRestriction takes a rectangle). */
export async function placesLocal(fetch, key, textQuery, box, pageToken) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': PLACES_FIELDS + ',places.location,nextPageToken' },
    body: JSON.stringify({ textQuery, pageSize: 20, ...(pageToken ? { pageToken } : {}),
      locationRestriction: { rectangle: { low: { latitude: box.s, longitude: box.w }, high: { latitude: box.n, longitude: box.e } } } }),
  });
  if (!r.ok) throw await providerError('Google Places', r);
  return r.json();
}

export const placeRow = (p) => ({
  name: p.displayName?.text || null, address: p.formattedAddress || null, phone: p.nationalPhoneNumber || null,
  website: p.websiteUri || null, rating: p.rating ?? null, reviews: p.userRatingCount ?? null,
  maps_url: p.googleMapsUri || null, place_id: p.id || null, status: p.businessStatus || null,
});

export const places_lookup = {
  id: 'places_lookup', category: 'company', name: 'Google Places: look up business', group: 'Your key', secret: 'GOOGLE_MAPS_API_KEY',
  blurb: 'Find this business on Google Maps: phone, website, rating, reviews. Best with name + city.',
  inputs: [{ key: 'query', label: 'Business name and city', required: true }],
  outputs: [
    { key: 'website', label: 'Website (Google)', type: 'url' }, { key: 'phone', label: 'Phone (Google)', type: 'text' },
    { key: 'address', label: 'Address', type: 'text' }, { key: 'rating', label: 'Rating', type: 'number' },
    { key: 'reviews', label: 'Review count', type: 'number' }, { key: 'maps_url', label: 'Maps link', type: 'url' },
    { key: 'status', label: 'Business status', type: 'select' },
  ],
  primary: 'maps_url', type: 'url', subrequests: 1,
  costMicros: PLACES_COST, costSource: 'Text Search Enterprise: 1,000 free a month, then $0.035 per request (Google, read 2026-09-15). Estimated at the paid rate.',
  async run({ query }, { fetch, secret }) {
    const j = await placesSearch(fetch, secret('GOOGLE_MAPS_API_KEY'), String(query).slice(0, 300));
    const p = (j.places || [])[0];
    return p ? done(placeRow(p)) : none();
  },
};

export const BYOK = [hunter_email_finder, hunter_email_verifier, prospeo_enrich_person, exa_find_similar, exa_search, places_lookup];
