/**
 * treg (treg.to, open source: github.com/superdesigndev/treg): "OpenRouter for agent tools". One
 * token (TREG_TOKEN) reaches thousands of provider endpoints, billed per call at the provider's
 * price with 0% markup (treg's claim). Its routed endpoints are waterfalls of their own: e.g.
 * treg.people.email.find tries up to 23 providers, cheapest first, and a miss on most of them
 * costs nothing (treg catalog, read 2026-09-29).
 *
 * WHY IT FITS FREE CLAY. Clay resells data from ~130 providers behind its credits (Clay's count).
 * treg sells the same kind of calls at the provider's price. Measured 2026-09-29: a company
 * enrich cost $0.0019, a Google search $0.0005, a web page extract $0 (treg's X-Treg-Cost-Micro
 * header). Clay's Enrich company chip is 0.5 credits, $0.025 at Launch's credit price (Clay's
 * figures, teardown-v2).
 *
 * MONEY RULES (from references/treg-api.md in the author's repo, proven on real calls):
 *   - Every call sends X-Treg-Route-Max-Cost = this function's cap. treg refuses (402, no charge)
 *     rather than spend more, and it has NO default cap of its own below $1 a call.
 *   - The charge is the X-Treg-Cost-Micro response header, never a number in the body.
 *   - costMicros below is the cap, so a run's budget reserves the worst case; the ledger records
 *     what treg really charged, which is usually far less.
 *
 * Output: routed endpoints answer {output, raw, _treg: {served_by, tried}}; we keep `output`,
 * flattened. LinkedIn fields are dropped: Free Clay does not store LinkedIn data.
 */

import { normalizeDomain, readCapped } from './web.js';

export const TREG_BASE = 'https://treg.to';
const CHECKED = '2026-09-29';

const done = (data, cost) => ({ status: 'done', data, cost_micros: cost });
const none = (data, cost) => ({ status: 'no_result', data, cost_micros: cost });

/** One capped call. Returns {output, servedBy, cost}; throws a readable error (with its cost). */
export async function tregCall(ctx, route, body, capMicros) {
  const r = await ctx.fetch(`${TREG_BASE}/call/${route}`, { method: 'POST', body: JSON.stringify(body), headers: {
    'content-type': 'application/json', 'x-treg-token': ctx.secret('TREG_TOKEN'),
    'x-treg-route-max-cost': (capMicros / 1e6).toFixed(4), 'user-agent': 'free-clay/1.0' } });
  const cost = Number.parseInt(r.headers.get('x-treg-cost-micro') || '0', 10) || 0;
  const servedBy = r.headers.get('x-treg-served-by') || null;
  if (!r.ok) {
    const text = (await readCapped(r, 2000).catch(() => '')).replace(/\s+/g, ' ');
    const why = r.status === 402 ? (/route_max_cost/.test(text) ? `every provider would cost more than this row's $${(capMicros / 1e6).toFixed(3)} cap` : 'your treg balance is empty (top up at treg.to)')
      : r.status === 401 || r.status === 403 ? 'check TREG_TOKEN' : r.status === 429 ? 'rate limited, try again later' : r.status === 503 ? 'no provider has capacity right now' : text.slice(0, 160);
    throw Object.assign(new Error(`treg HTTP ${r.status}: ${why}`), { cost_micros: cost });
  }
  const j = await r.json().catch(() => ({}));
  return { output: j.output && typeof j.output === 'object' ? j.output : {}, servedBy: servedBy || j._treg?.served_by || null, cost };
}

/** Top-level scalars of an object, strings capped, LinkedIn fields dropped. */
export function flatten(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (/linkedin/i.test(k) || v === null || v === undefined) continue;
    const key = String(k).toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
    if (typeof v === 'string') out[key] = v.slice(0, 2000);
    else if (typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/** The first present value among candidate keys. */
const pick = (o, ...keys) => { for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '') return o[k]; return null; };
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const provider = (s) => (s ? String(s).split('.')[0] : null);

function tregFn(spec) {
  return {
    id: spec.id, name: `treg: ${spec.name}`, provider: 'treg', secret: 'TREG_TOKEN', group: 'Your key', category: spec.category,
    blurb: `${spec.blurb} Usually about $${spec.typical} (treg's price); never more than $${(spec.cap / 1e6).toFixed(3)} a row.`,
    inputs: spec.inputs, outputs: [...spec.outputs, { key: 'found_by', label: 'Found by (provider)', type: 'text' }],
    primary: spec.primary, type: spec.type, subrequests: 1, billing: 'per_hit', validates: spec.validates,
    costMicros: spec.cap,
    costSource: `treg (treg.to), routed over several providers. Typical price per hit about $${spec.typical}, treg's catalog read ${CHECKED}; `
      + `this is the cap sent as X-Treg-Route-Max-Cost, so a run never reserves less than it could spend. The ledger records treg's real charge (X-Treg-Cost-Micro).`,
    async run(input, ctx) {
      const body = spec.body(input);
      const cap = Number.isInteger(ctx.capMicros) && ctx.capMicros > 0 ? ctx.capMicros : spec.cap;
      const { output, servedBy, cost } = await tregCall(ctx, spec.route, body, cap);
      const data = { ...spec.map(output), found_by: provider(servedBy) };
      return spec.hit(data) ? done(data, cost) : none(data, cost);
    },
  };
}

const needName = (i) => {
  if (!str(i.full_name) && !(str(i.first_name) && str(i.last_name))) throw new Error('Needs a full name, or a first and a last name');
};
const domainFrom = (v) => normalizeDomain(v) || (() => { throw new Error(`Not a domain: ${str(v).slice(0, 80)}`); })();
const listText = (items, f) => items.slice(0, 10).map(f).filter(Boolean).join('\n') || null;

export const treg_email_find = tregFn({
  id: 'treg_email_find', route: 'treg.people.email.find', name: 'find work email (23 providers)', category: 'email', typical: '0.005', cap: 20_000,
  blurb: 'A person’s work email from their name and company domain. treg tries up to 23 providers, cheapest first, and misses are mostly free.',
  inputs: [{ key: 'full_name', label: 'Full name' }, { key: 'first_name', label: 'First name' }, { key: 'last_name', label: 'Last name' }, { key: 'domain', label: 'Company domain or website', required: true }],
  outputs: [{ key: 'email', label: 'Work email', type: 'email' }],
  primary: 'email', type: 'email',
  body: (i) => { needName(i); return Object.fromEntries(Object.entries({ full_name: str(i.full_name), first_name: str(i.first_name), last_name: str(i.last_name), domain: domainFrom(i.domain) }).filter(([, v]) => v)); },
  map: (o) => ({ email: pick(o, 'email', 'work_email') }),
  hit: (d) => !!d.email,
});

export const treg_email_verify = tregFn({
  id: 'treg_email_verify', route: 'treg.people.email.verify', name: 'verify email', category: 'email', typical: '0.000', cap: 10_000, validates: 'email',
  blurb: 'Checks the mailbox with a verification provider (SMTP-level, which a Worker cannot do). Works as a waterfall validation step.',
  inputs: [{ key: 'email', label: 'Email', required: true }],
  outputs: [{ key: 'status', label: 'Verification', type: 'select' }, { key: 'valid', label: 'Deliverable', type: 'checkbox' }],
  primary: 'status', type: 'select',
  body: (i) => ({ email: str(i.email).toLowerCase() }),
  map: (o) => {
    const status = str(pick(o, 'status', 'result', 'verdict')).toLowerCase() || null;
    return { status, valid: status ? ['valid', 'deliverable', 'ok', 'safe', 'verified'].includes(status) : null };
  },
  hit: (d) => !!d.status,
});

export const treg_phone_find = tregFn({
  id: 'treg_phone_find', route: 'treg.people.phone.find', name: 'find phone number (13 providers)', category: 'contact', typical: '0.005', cap: 50_000,
  blurb: 'A direct business phone from an email, or a name and company domain. Misses are free on all 13 providers.',
  inputs: [{ key: 'full_name', label: 'Full name' }, { key: 'email', label: 'Email' }, { key: 'domain', label: 'Company domain' }],
  outputs: [{ key: 'phone', label: 'Phone', type: 'text' }],
  primary: 'phone', type: 'text',
  body: (i) => {
    const b = Object.fromEntries(Object.entries({ full_name: str(i.full_name), email: str(i.email), domain: normalizeDomain(i.domain) || '' }).filter(([, v]) => v));
    if (!b.email && !(b.full_name && b.domain)) throw new Error('Needs an email, or a full name and a company domain');
    return b;
  },
  map: (o) => ({ phone: pick(o, 'phone', 'mobile', 'phone_number', 'direct_phone') }),
  hit: (d) => !!d.phone,
});

export const treg_person_enrich = tregFn({
  id: 'treg_person_enrich', route: 'treg.people.enrich', name: 'enrich a person (22 providers)', category: 'contact', typical: '0.0026', cap: 20_000,
  blurb: 'Job title, company, location and more for a person, from an email or a name and company domain.',
  inputs: [{ key: 'email', label: 'Email' }, { key: 'full_name', label: 'Full name' }, { key: 'domain', label: 'Company domain' }],
  outputs: [{ key: 'full_name', label: 'Name', type: 'text' }, { key: 'title', label: 'Job title', type: 'text' }, { key: 'company', label: 'Company', type: 'text' },
    { key: 'location', label: 'Location', type: 'text' }, { key: 'seniority', label: 'Seniority', type: 'text' }],
  primary: 'title', type: 'text',
  body: (i) => {
    const b = Object.fromEntries(Object.entries({ email: str(i.email), full_name: str(i.full_name), domain: normalizeDomain(i.domain) || '' }).filter(([, v]) => v));
    if (!b.email && !(b.full_name && b.domain)) throw new Error('Needs an email, or a full name and a company domain');
    return b;
  },
  map: (o) => {
    const f = flatten(o);
    return { ...f, full_name: pick(o, 'full_name', 'name'), title: pick(o, 'title', 'job_title', 'headline', 'position'), company: pick(o, 'company', 'company_name', 'organization'),
      location: pick(o, 'location', 'city', 'country'), seniority: pick(o, 'seniority', 'level') };
  },
  hit: (d) => !!(d.full_name || d.title),
});

export const treg_company_enrich = tregFn({
  id: 'treg_company_enrich', route: 'treg.companies.enrich', name: 'enrich a company (26 providers)', category: 'company', typical: '0.0018', cap: 10_000,
  blurb: 'Name, industry, size, founding year, description and location from a domain.',
  inputs: [{ key: 'domain', label: 'Domain or website', required: true }],
  outputs: [{ key: 'name', label: 'Company name', type: 'text' }, { key: 'industry', label: 'Industry', type: 'text' }, { key: 'employees', label: 'Employees', type: 'number' },
    { key: 'founded', label: 'Founded', type: 'number' }, { key: 'location', label: 'Location', type: 'text' }, { key: 'description', label: 'Description', type: 'text' }],
  primary: 'name', type: 'text',
  body: (i) => ({ domain: domainFrom(i.domain) }),
  map: (o) => ({ ...flatten(o), name: pick(o, 'name', 'company_name'), industry: pick(o, 'industry', 'sector'), employees: pick(o, 'employees', 'employee_count', 'headcount'),
    founded: pick(o, 'founded', 'founded_year', 'year_founded'), location: pick(o, 'location', 'headquarters', 'city'), description: pick(o, 'description', 'summary') }),
  hit: (d) => !!d.name,
});

export const treg_web_extract = tregFn({
  id: 'treg_web_extract', route: 'treg.web.extract', name: 'read a web page (10 providers)', category: 'web', typical: '0.000', cap: 5_000,
  blurb: 'The page as clean text through scraping providers, for sites that block a plain fetch or need JavaScript. Most answers are free.',
  inputs: [{ key: 'url', label: 'URL', required: true }],
  outputs: [{ key: 'text', label: 'Page text', type: 'text' }, { key: 'title', label: 'Title', type: 'text' }, { key: 'final_url', label: 'Final URL', type: 'url' }],
  primary: 'text', type: 'text',
  body: (i) => ({ url: /^https?:\/\//i.test(str(i.url)) ? str(i.url) : `https://${domainFrom(i.url)}` }),
  map: (o) => { const p = (o.pages || [])[0] || {}; return { text: p.text ? String(p.text).slice(0, 8000) : null, title: p.title || null, final_url: p.final_url || p.url || null }; },
  hit: (d) => !!d.text,
});

export const treg_google_search = tregFn({
  id: 'treg_google_search', route: 'treg.google.serp.organic', name: 'Google search', category: 'web', typical: '0.0009', cap: 5_000,
  blurb: 'The top Google results for a query, like "{{company}} reviews" or "roofers in {{city}}".',
  inputs: [{ key: 'query', label: 'Search query', required: true }],
  outputs: [{ key: 'top_url', label: 'Top result', type: 'url' }, { key: 'top_title', label: 'Top result title', type: 'text' }, { key: 'results', label: 'Top 10 results', type: 'text' }, { key: 'count', label: 'Results', type: 'number' }],
  primary: 'top_url', type: 'url',
  body: (i) => ({ q: str(i.query).slice(0, 300), limit: 10 }),
  map: (o) => { const rs = o.results || []; return { top_url: rs[0]?.link || null, top_title: rs[0]?.title || null, results: listText(rs, (x) => x.link && `${x.title || ''} ${x.link}`.trim()), count: rs.length }; },
  hit: (d) => !!d.top_url,
});

export const treg_maps_lookup = tregFn({
  id: 'treg_maps_lookup', route: 'treg.google.serp.maps', name: 'Google Maps lookup', category: 'company', typical: '0.00175', cap: 10_000,
  blurb: 'The first Google Maps match for "business name, town": phone, website, address, rating and reviews.',
  inputs: [{ key: 'query', label: 'Business and town', required: true }],
  outputs: [{ key: 'name', label: 'Name on Maps', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'website', label: 'Website', type: 'url' },
    { key: 'address', label: 'Address', type: 'text' }, { key: 'rating', label: 'Rating', type: 'number' }, { key: 'reviews', label: 'Reviews', type: 'number' }],
  primary: 'name', type: 'text',
  body: (i) => ({ q: str(i.query).slice(0, 300) }),
  map: (o) => { const p = (o.places || [])[0] || {}; return { name: pick(p, 'name', 'title'), phone: pick(p, 'phone', 'phone_number'), website: pick(p, 'website', 'site', 'url'),
    address: pick(p, 'address', 'formatted_address'), rating: pick(p, 'rating'), reviews: pick(p, 'reviews', 'reviews_count', 'user_ratings_total', 'rating_count') }; },
  hit: (d) => !!d.name,
});

export const treg_company_news = tregFn({
  id: 'treg_company_news', route: 'treg.companies.news', name: 'company news', category: 'company', typical: '0.01', cap: 20_000,
  blurb: 'Recent news about a company, from its domain. A reason to reach out this week.',
  inputs: [{ key: 'domain', label: 'Domain', required: true }],
  outputs: [{ key: 'latest_title', label: 'Latest headline', type: 'text' }, { key: 'latest_url', label: 'Latest story', type: 'url' }, { key: 'latest_date', label: 'Published', type: 'date' },
    { key: 'headlines', label: 'Headlines', type: 'text' }, { key: 'count', label: 'Stories', type: 'number' }],
  primary: 'latest_title', type: 'text',
  body: (i) => ({ domain: domainFrom(i.domain), limit: 10 }),
  map: (o) => { const a = o.articles || []; const f = a[0] || {}; return { latest_title: pick(f, 'title', 'headline'), latest_url: pick(f, 'url', 'link'), latest_date: pick(f, 'published_at', 'date', 'published'),
    headlines: listText(a, (x) => pick(x, 'title', 'headline')), count: a.length }; },
  hit: (d) => !!d.latest_title,
});

export const treg_company_jobs = tregFn({
  id: 'treg_company_jobs', route: 'treg.companies.jobs.search', name: 'open jobs', category: 'company', typical: '0.009', cap: 20_000,
  blurb: 'Open roles at a company from job-board providers, for companies not on Greenhouse, Lever or Ashby (those are free under Find leads, Jobs).',
  inputs: [{ key: 'domain', label: 'Domain' }, { key: 'name', label: 'Company name' }],
  outputs: [{ key: 'count', label: 'Open roles', type: 'number' }, { key: 'titles', label: 'Roles', type: 'text' }, { key: 'latest_title', label: 'Newest role', type: 'text' }],
  primary: 'count', type: 'number',
  body: (i) => {
    const b = Object.fromEntries(Object.entries({ domain: normalizeDomain(i.domain) || '', name: str(i.name) }).filter(([, v]) => v));
    if (!b.domain && !b.name) throw new Error('Needs a domain or a company name');
    return { ...b, limit: 25 };
  },
  map: (o) => { const js = o.jobs || []; return { count: js.length, titles: listText(js, (x) => pick(x, 'title', 'name', 'position')), latest_title: pick(js[0] || {}, 'title', 'name', 'position') }; },
  hit: (d) => d.count > 0,
});

export const TREG = [treg_email_find, treg_email_verify, treg_phone_find, treg_person_enrich, treg_company_enrich, treg_web_extract, treg_google_search, treg_maps_lookup,
  treg_company_news, treg_company_jobs];

/* ---------------------------------------------------------------- people search (Find leads, People) */

export const PEOPLE_SEARCH_CAP = 100_000;   // $0.10 a search unless the caller asks for less

/** One person from any provider's shape, LinkedIn fields dropped. */
export function toPerson(p) {
  if (!p || typeof p !== 'object') return null;
  const first = str(pick(p, 'first_name', 'firstname')); const last = str(pick(p, 'last_name', 'lastname'));
  const full = str(pick(p, 'full_name', 'name')) || [first, last].filter(Boolean).join(' ');
  if (!full) return null;
  const cap = (v) => (str(v) ? str(v).slice(0, 300) : null);
  const domain = normalizeDomain(pick(p, 'company_domain', 'domain', 'company_website', 'website') || '') || null;
  return { full_name: cap(full), first_name: cap(first), last_name: cap(last), title: cap(pick(p, 'title', 'job_title', 'headline', 'position')),
    company: cap(pick(p, 'company', 'company_name', 'organization', 'organization_name', 'employer')), domain,
    location: cap(pick(p, 'location', 'city', 'country')), email: cap(pick(p, 'email', 'work_email')), seniority: cap(pick(p, 'seniority')) };
}

export async function tregPeopleSearch(ctx, s, capMicros = PEOPLE_SEARCH_CAP) {
  const body = Object.fromEntries(Object.entries({ title: s.title, company_domain: s.company_domain, location: s.location, q: s.q, limit: s.limit }).filter(([, v]) => v));
  if (s.keywords?.length) body.keywords = s.keywords;
  const { output, servedBy, cost } = await tregCall(ctx, 'treg.people.search', body, capMicros);
  const people = (Array.isArray(output.people) ? output.people : []).map(toPerson).filter(Boolean).slice(0, s.limit || 25);
  return { people, servedBy: provider(servedBy), cost };
}
