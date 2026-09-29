/**
 * Open roles from public job boards (LOAM-PLAN.md phase 6c), Clay's "Find jobs" and the raw
 * material for its hiring signals. Greenhouse, Lever and Ashby each publish a company's board as
 * a public JSON API with no key; a company uses one of them, so each slug is tried on all three
 * at once and whichever answers wins. Up to MAX_SLUGS companies per search (3 requests each,
 * under the Worker's 50 subrequests), each board cached a day.
 */

import { fail } from '../util.js';
import { openFetch } from './http.js';
import { cached, DAY } from './cache.js';

export const MAX_SLUGS = 10;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

/** "discord.com", "https://jobs.lever.co/netflix", "Discord" -> a board slug. */
export function toSlug(s) {
  let v = String(s || '').trim().toLowerCase();
  const m = /(?:greenhouse\.io|lever\.co|ashbyhq\.com)\/(?:v1\/boards\/)?([a-z0-9-]+)/.exec(v);
  if (m) return m[1];
  v = v.replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  if (v.includes('.')) v = v.split('.').slice(0, -1).pop();   // discord.com -> discord, careers.acme.co -> acme
  return v.replace(/[^a-z0-9-]/g, '');
}

export function checkJobSearch(body) {
  const raw = Array.isArray(body?.companies) ? body.companies : String(body?.companies || '').split(/[\s,;]+/);
  const slugs = [...new Set(raw.map(toSlug).filter((x) => SLUG_RE.test(x)))].sort();
  if (!slugs.length) fail(400, 'Type one or more companies, like discord, notion.so or figma');
  if (slugs.length > MAX_SLUGS) fail(400, `Up to ${MAX_SLUGS} companies per search`);
  const keyword = String(body?.keyword || '').trim().toLowerCase().slice(0, 60);
  return { source: 'jobs', slugs, keyword };
}

const cap = (v, n = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
const day = (v) => { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : null; };
const httpsOnly = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u.slice(0, 500) : null);

export const BOARDS = {
  greenhouse: {
    url: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    parse: (j) => (j.jobs || []).map((x) => ({ title: cap(x.title), location: cap(x.location?.name), department: cap(x.departments?.[0]?.name),
      posted: day(x.first_published || x.updated_at), url: httpsOnly(x.absolute_url) })),
  },
  lever: {
    url: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    parse: (j) => (Array.isArray(j) ? j : []).map((x) => ({ title: cap(x.text), location: cap(x.categories?.location), department: cap(x.categories?.team),
      posted: typeof x.createdAt === 'number' ? day(x.createdAt) : null, url: httpsOnly(x.hostedUrl) })),
  },
  ashby: {
    url: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    parse: (j) => (j.jobs || []).filter((x) => x.isListed !== false).map((x) => ({ title: cap(x.title), location: cap(x.location), department: cap(x.department),
      posted: day(x.publishedAt), url: httpsOnly(x.jobUrl) })),
  },
};

/** One company's open roles: {ats, jobs} from whichever board has it, or {ats: null}. */
async function board(db, deps, slug) {
  const { value } = await cached(db, 'job-board', slug, DAY, async () => {
    const tries = await Promise.all(Object.entries(BOARDS).map(async ([ats, b]) => {
      try {
        const res = await openFetch(db, deps, b.url(slug), { init: { signal: AbortSignal.timeout(15_000) } });
        if (!res.ok) { await res.body?.cancel?.(); return null; }
        return { ats, jobs: b.parse(await res.json()).filter((x) => x.title && x.url) };
      } catch { return null; }
    }));
    return tries.find((t) => t && t.jobs.length) || tries.find(Boolean) || { ats: null, jobs: [] };
  }, deps.nowMs);
  return value;
}

export async function jobSearch(db, deps, body) {
  const s = checkJobSearch(body);
  const boards = await Promise.all(s.slugs.map((slug) => board(db, deps, slug)));
  const results = []; const found = {};
  s.slugs.forEach((slug, i) => {
    const b = boards[i];
    found[slug] = b.ats ? `${b.ats}, ${b.jobs.length} open` : 'no public board found';
    for (const j of b.jobs) {
      if (s.keyword && !`${j.title} ${j.department || ''}`.toLowerCase().includes(s.keyword)) continue;
      results.push({ ...j, company: slug, ats: b.ats });
    }
  });
  await cached(db, 'job-results', JSON.stringify(s), DAY, async () => results, deps.nowMs, { replace: true });
  return { search: s, results, boards: found };
}
