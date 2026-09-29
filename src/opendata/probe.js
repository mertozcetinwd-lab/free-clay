/**
 * The data-source check (Settings, Data sources, "Run check"). One small request to each free
 * service Find leads will use, from the Worker itself, because that is where the real requests
 * come from: this proves each one answers from Cloudflare, how fast, and what rate-limit headers
 * it sends. No keys, no paid calls; twelve requests per click. Bodies are not read beyond the
 * status, so the big ones (SEC) cost no CPU.
 */

import { openFetch, contactEmail } from './http.js';
import { OVERPASS_SERVERS } from './osm.js';

export const PROBES = [
  { id: 'nominatim', name: 'Nominatim (place search)', needsContact: true,
    url: 'https://nominatim.openstreetmap.org/search?q=Gainesville%2C+Florida&format=jsonv2&limit=1' },
  ...OVERPASS_SERVERS.map((url, i) => ({ id: `overpass${i || ''}`, name: `Overpass ${i ? `backup ${i}` : 'main'} (${new URL(url).host})`, url,
    init: { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent('[out:json][timeout:10];node(29.60,-82.40,29.70,-82.30)[craft=roofer];out 1;') } })),
  { id: 'sec', name: 'SEC EDGAR (public companies)', needsContact: true,
    url: 'https://data.sec.gov/submissions/CIK0000320193.json' },
  { id: 'wikidata', name: 'Wikidata (company facts)',
    url: 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent('SELECT ?x WHERE { wd:Q312 wdt:P856 ?x } LIMIT 1') },
  { id: 'gleif', name: 'GLEIF (legal entities)',
    url: 'https://api.gleif.org/api/v1/lei-records?page%5Bsize%5D=1&filter%5Bentity.legalName%5D=Apple%20Inc.' },
  { id: 'greenhouse', name: 'Greenhouse job boards',
    url: 'https://boards-api.greenhouse.io/v1/boards/gitlab/jobs' },
  { id: 'lever', name: 'Lever job boards',
    url: 'https://api.lever.co/v0/postings/leverdemo?mode=json&limit=1' },
  { id: 'ashby', name: 'Ashby job boards',
    url: 'https://api.ashbyhq.com/posting-api/job-board/ashby' },
  { id: 'sec-tickers', name: 'SEC company list (tickers)', needsContact: true,
    url: 'https://www.sec.gov/files/company_tickers_exchange.json' },
  { id: 'gdelt', name: 'GDELT (news)',
    url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=roofing%20florida&mode=artlist&maxrecords=1&format=json' },
];

const LIMIT_HEADER = /rate|limit|retry-after/i;

export async function runProbe(env, deps = {}) {
  const email = await contactEmail(env.DB);
  const now = deps.now || new Date();
  const results = await Promise.all(PROBES.map(async (p) => {
    if (p.needsContact && !email) return { id: p.id, name: p.name, ok: false, skipped: true, note: 'Needs a contact email first' };
    const t0 = Date.now();
    try {
      // 15 s each: in the live check two Overpass backups held the request for about two minutes.
      const res = await openFetch(env.DB, deps, p.url, { needsContact: p.needsContact, init: { ...(p.init || {}), signal: AbortSignal.timeout(15_000) } });
      const limits = {};
      res.headers.forEach((v, k) => { if (LIMIT_HEADER.test(k)) limits[k] = v; });
      await res.body?.cancel?.();
      return { id: p.id, name: p.name, ok: res.ok, status: res.status, ms: Date.now() - t0, type: (res.headers.get('content-type') || '').split(';')[0], limits };
    } catch (e) {
      return { id: p.id, name: p.name, ok: false, ms: Date.now() - t0, note: String(e?.message || e).slice(0, 200) };
    }
  }));
  return { checked_at: now.toISOString(), contact_set: !!email, results };
}
