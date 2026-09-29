/**
 * Find leads, Lookalikes (LOAM-PLAN.md phase 6d; Clay's Lookalikes tab, teardown-v2 3.5): paste a
 * customer you like, get companies whose sites read like theirs, from Exa's findSimilar on YOUR
 * key. One request returns up to 25 results. Exa bills per request; the cost shown before the
 * search is the measured $0.007 (src/functions/byok.js, scripts/exa.py 2026-08-06) or your own
 * price from Settings, and Exa's own reported cost is what the ledger records.
 *
 * Results are pages, not companies: Exa can return an article ABOUT a company. The preview shows
 * the page title and domain so a person can judge; one row per domain.
 */

import { fail, nowIso, parseJson } from './util.js';
import { secretValue } from './runner.js';
import { normalizeDomain, readCapped } from './functions/web.js';
import { cached, DAY } from './opendata/cache.js';

export const LOOKALIKE_COST = 7000;
const NUM = 25;
const SKIP = ['linkedin.com', 'facebook.com', 'yelp.com', 'wikipedia.org', 'bbb.org', 'instagram.com', 'x.com', 'twitter.com', 'youtube.com', 'crunchbase.com', 'glassdoor.com', 'indeed.com'];

export function checkLookalikeSearch(body) {
  const d = normalizeDomain(body?.url || '');
  if (!d) fail(400, 'Paste a company website, like example.com');
  return { source: 'lookalikes', domain: d };
}

export async function lookalikes(env, deps, body) {
  const db = env.DB;
  const s = checkLookalikeSearch(body);
  const settings = Object.fromEntries((await db.prepare(`SELECT key, value FROM settings WHERE key IN ('default_budget_micros','cost_overrides')`).all()).results.map((r) => [r.key, parseJson(r.value, null)]));
  const est = Number.isInteger(settings.cost_overrides?.exa_find_similar) ? settings.cost_overrides.exa_find_similar : LOOKALIKE_COST;
  if (est > (settings.default_budget_micros ?? 1_000_000)) fail(400, `One search can cost about $${(est / 1e6).toFixed(3)}, over your budget per run`);
  const key = secretValue(env, 'EXA_API_KEY');
  const { value, cached: hit } = await cached(db, 'lookalikes', s.domain, 7 * DAY, async () => {
    const r = await (deps.fetch || fetch)('https://api.exa.ai/findSimilar', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ url: `https://${s.domain}`, numResults: NUM, excludeSourceDomain: true }) });
    const text = await readCapped(r, 400_000);
    if (!r.ok) fail(502, `Exa answered ${r.status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
    const j = parseJson(text, {});
    const cost = Math.round(Number(j?.costDollars?.total || 0) * 1e6) || est;
    await db.prepare(`INSERT INTO ledger (ts, provider, cost_micros, outcome, note) VALUES (?1, 'exa_find_similar', ?2, 'done', ?3)`).bind(nowIso(), cost, `lookalikes of ${s.domain}`).run();
    const seen = new Set([s.domain]); const out = [];
    for (const x of j.results || []) {
      const d = normalizeDomain(x.url);
      if (!d || seen.has(d) || SKIP.some((k) => d === k || d.endsWith(`.${k}`))) continue;
      seen.add(d);
      out.push({ name: String(x.title || d).slice(0, 200), website: `https://${d}`, domain: d, page: String(x.url).slice(0, 500), score: Number.isFinite(x.score) ? Math.round(x.score * 100) / 100 : null,
        source_url: String(x.url).slice(0, 500), industry: null, employees: null, founded: null, hq: null, state: null, phone: null, ticker: null, exchange: null });
    }
    return out;
  }, deps.nowMs);
  await cached(db, 'company-results', JSON.stringify(s), 7 * DAY, async () => value, deps.nowMs, { replace: true });
  return { search: s, results: value, cached: hit, cost_micros: hit ? 0 : est };
}
