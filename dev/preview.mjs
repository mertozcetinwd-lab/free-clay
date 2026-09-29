/**
 * Run free-clay on your own computer with no Cloudflare account and no wrangler:
 *
 *   node dev/preview.mjs            then open http://localhost:8787  (password: preview)
 *
 *   node dev/preview.mjs --fake-opendata --real-ai --real-treg   real Groq and treg from your environment
 *
 * It serves /public, answers /api/* with the real Worker code, keeps data in dev/preview.sqlite,
 * and drains the run queue every 5 seconds like the cron would. No provider keys are loaded, so
 * only the free functions can run here. `wrangler dev` is the closer match to production.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { makeD1 } from './d1.mjs';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const port = Number(process.env.PORT || 8787);
const file = process.argv.includes('--memory') ? ':memory:' : fileURLToPath(new URL('./preview.sqlite', import.meta.url));
const { DB, sql } = makeD1(file);
if (process.argv.includes('--seed')) sql.exec(await readFile(new URL('../seed.sql', import.meta.url), 'utf8'));
const env = { DB, APP_PASSWORD: process.env.APP_PASSWORD || 'preview' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * --fake-opendata: place search and Overpass answer with made-up businesses around the point asked
 * for, so the Find leads page can be tried (and screenshotted) without sending real requests to
 * OpenStreetMap. Every other request goes out as normal.
 */
const deps = {};
// --real-ai: agents and AI columns call real Groq with GROQ_API_KEY from your environment (free tier).
const REAL_AI = process.argv.includes('--real-ai') && !!process.env.GROQ_API_KEY;
// --real-treg: treg functions, People search and the job-change signal call real treg with TREG_TOKEN
// from your environment. PAID: each call is capped (X-Treg-Route-Max-Cost) and ledgered.
const REAL_TREG = process.argv.includes('--real-treg') && !!process.env.TREG_TOKEN;
if (process.argv.includes('--fake-opendata')) {
  const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  deps.fetch = async (url, init) => {
    if (url.includes('nominatim.openstreetmap.org') && url.includes('bounded=1')) {
      return json(['Gator Ridge Roofing', 'Sunshine Roof Repair'].map((name, i) => ({ osm_type: 'node', osm_id: 7000 + i, lat: String(29.652 + i * 0.004), lon: '-82.325', name,
        extratags: { phone: `+1 352 555 02${i}0` }, address: { house_number: String(10 + i), road: 'SW 2nd Ave', city: 'Gainesville', state: 'Florida' } })));
    }
    if (url.includes('nominatim.openstreetmap.org')) return json([{ lat: '29.6516', lon: '-82.3248', display_name: 'Gainesville, Alachua County, Florida, United States' }]);
    if (url.includes('overpass-api.de')) {
      const q = decodeURIComponent(String(init?.body || '').slice(5));
      const [, lat, lon] = q.match(/around:\d+,([-\d.]+),([-\d.]+)/) || [0, 29.65, -82.32];
      const names = ['Gator Ridge Roofing', 'Sunshine Roof Repair', 'Swamp City Roofers', 'Oak Hammock Roofing', 'Blue Heron Roofs', 'Paynes Prairie Roofing Co', 'Duckpond Roof Care', 'Millhopper Roofing'];
      return json({ elements: names.map((name, i) => ({ type: 'node', id: 9000 + i, lat: +lat + Math.sin(i) * 0.03, lon: +lon + Math.cos(i) * 0.03,
        tags: { name, ...(i % 3 ? { phone: `+1 352 555 01${10 + i}` } : {}), ...(i % 2 ? {} : { website: `https://${name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com` }),
          'addr:housenumber': String(100 + i * 7), 'addr:street': 'NW 13th St', 'addr:city': 'Gainesville', 'addr:state': 'FL' } })) });
    }
    if (url.includes('places.googleapis.com')) {
      const r = JSON.parse(init.body).locationRestriction?.rectangle;
      const lat = r ? (r.low.latitude + r.high.latitude) / 2 : 29.65; const lon = r ? (r.low.longitude + r.high.longitude) / 2 : -82.32;
      return json({ places: ['Gator Ridge Roofing', 'Swamp City Roofers', 'Oak Hammock Roofing', 'Duckpond Roof Care'].map((name, i) => ({
        id: `fake${i}`, displayName: { text: name }, formattedAddress: `${100 + i} NW 13th St, Gainesville, FL 32601, USA`,
        nationalPhoneNumber: `(352) 555-01${20 + i}`, websiteUri: `https://${name.toLowerCase().replace(/[^a-z]+/g, '')}.example.com`,
        googleMapsUri: `https://maps.google.com/?cid=${9000 + i}`, location: { latitude: lat + 0.004 * i, longitude: lon } })) });
    }
    if (url.includes('query.wikidata.org')) {
      const b = (id, name, site, emp, inc, hq) => ({ c: { value: `http://www.wikidata.org/entity/Q${id}` }, cLabel: { value: name }, site: { value: site },
        emp: { value: String(emp) }, inc: { value: `${inc}-01-01T00:00:00Z` }, hqLabel: { value: hq }, indLabel: { value: 'construction' } });
      return json({ results: { bindings: [b(9001, 'Sunshine Builders Group', 'https://sunshinebuilders.example.com', 1200, 1978, 'Tampa'),
        b(9002, 'Gulf Coast Constructors', 'https://gulfcoast.example.com', 340, 1994, 'Fort Myers'), b(9003, 'Panhandle Contracting', 'https://panhandle.example.com', 85, 2006, 'Pensacola')] } });
    }
    if (url.includes('company_tickers_exchange.json')) return json({ fields: ['cik', 'name', 'ticker', 'exchange'], data: [[354950, 'HOME DEPOT, INC.', 'HD', 'NYSE'], [60667, "LOWE'S COMPANIES INC", 'LOW', 'NYSE'], [1, 'Depot Example Corp', 'DPX', 'OTC']] });
    if (url.includes('data.sec.gov/submissions/')) return json({ sicDescription: 'Retail-Lumber & Other Building Materials Dealers', phone: '770-433-8211', website: 'https://www.homedepot.com',
      addresses: { business: { street1: '2455 Paces Ferry Road', city: 'Atlanta', stateOrCountry: 'GA', zipCode: '30339' } } });
    const board = /greenhouse\.io\/v1\/boards\/([a-z0-9-]+)|lever\.co\/v0\/postings\/([a-z0-9-]+)|ashbyhq\.com\/posting-api\/job-board\/([a-z0-9-]+)/.exec(url);
    if (board) {
      const slug = board[1] || board[2] || board[3];
      if (board[1] && slug !== 'nope') return json({ jobs: ['Account Executive', 'Sales Development Rep', 'Senior Engineer', 'Marketing Manager'].map((t, i) => ({ title: t,
        location: { name: ['Remote', 'New York', 'San Francisco', 'Austin'][i] }, departments: [{ name: i < 2 ? 'Sales' : i === 2 ? 'Engineering' : 'Marketing' }],
        first_published: `2026-09-${10 + i}T10:00:00Z`, absolute_url: `https://boards.greenhouse.io/${slug}/jobs/${100 + i}` })) });
      return new Response('not found', { status: 404 });
    }
    if (url.includes('treg.to/call/') && !REAL_TREG) {
      // A pretend treg: fictional example.com people and companies, charged in the header like treg.
      const route = url.split('/call/')[1];
      const b = JSON.parse(init?.body || '{}');
      const reply = (output, cost) => new Response(JSON.stringify({ output, raw: {}, _treg: { served_by: 'preview.fake' } }), { headers: { 'content-type': 'application/json', 'x-treg-cost-micro': String(cost), 'x-treg-served-by': 'preview.fake' } });
      const who = [['Ana Testrow', 'Owner', 'Example Roofing', 'example.com', 'Gainesville, FL'], ['Ben Testrow', 'General Manager', 'Example HVAC', 'example.org', 'Ocala, FL'],
        ['Cara Testrow', 'Founder', 'Example Plumbing', 'example.net', 'Tampa, FL'], ['Dan Testrow', 'Office Manager', 'Example Electric', 'example.com', 'Orlando, FL'],
        ['Eve Testrow', 'Owner', 'Example Pest', 'example.org', 'Jacksonville, FL']];
      if (route === 'treg.people.search') return reply({ people: who.map(([full_name, title, company, domain, location]) => ({ full_name, title, company, company_domain: domain, location })) }, 3000);
      if (route === 'treg.people.email.find') return reply({ email: `${String(b.full_name || b.first_name || 'info').split(' ')[0].toLowerCase()}@${b.domain}` }, 4834);
      if (route === 'treg.people.email.verify') return reply({ status: 'valid' }, 0);
      if (route === 'treg.companies.enrich') return reply({ name: `Example Co (${b.domain})`, industry: 'construction', employees: 12, founded: 2011, location: 'Gainesville, FL', description: 'A fictional company for the preview.' }, 1900);
      if (route === 'treg.companies.news') return reply({ articles: [{ title: `${b.domain} opens a second location (preview)`, url: 'https://news.example.com/a', published_at: '2026-09-20' }] }, 10000);
      if (route === 'treg.companies.jobs.search') return reply({ jobs: [{ title: 'Roofing Crew Lead' }, { title: 'Estimator' }] }, 9000);
      if (route === 'treg.google.serp.organic') return reply({ results: [{ title: 'Example Domain', link: 'https://example.com/', snippet: 'Preview result' }] }, 500);
      if (route === 'treg.web.extract') return reply({ pages: [{ url: b.url, title: 'Example Domain', text: 'Preview page text.' }] }, 0);
      return new Response('{"error":"not in the preview"}', { status: 404 });
    }
    if (url.includes('api.groq.com') && !REAL_AI) {
      // A pretend model for the Agents page: it reads the page it is asked about, then answers
      // with every requested field from what it read. No real model, no key, no cost.
      const body = JSON.parse(init.body);
      const user = body.messages.find((m) => m.role === 'user')?.content || '';
      const tool = [...body.messages].reverse().find((m) => m.role === 'tool');
      const usage = { prompt_tokens: 420, completion_tokens: 60 };
      const system = body.messages.find((m) => m.role === 'system')?.content || '';
      if (system.startsWith('You write one formula')) {
        const col = (system.match(/\{\{([a-z0-9_]+)\}\} = /) || [])[1] || 'website';
        return json({ choices: [{ message: { content: `UPPER(DOMAIN({{${col}}}))` } }], usage });
      }
      if (system.startsWith('You design lead-research tables')) {
        return json({ choices: [{ message: { content: JSON.stringify({ name: 'Roofers with email provider', columns: [{ name: 'Company', type: 'text' }, { name: 'Website', type: 'url' }],
          enrichments: [{ name: 'Site status', fn: 'website_check', inputs: { domain: 'Website' } }, { name: 'Email provider', fn: 'email_provider', inputs: { domain: 'Website' } }],
          notes: 'Rows come from Find leads or a CSV. (Preview: a pretend model wrote this plan.)' }) } }], usage });
      }
      if (!tool && body.tools?.length && body.tool_choice !== 'none') {
        const target = (user.match(/[a-z0-9-]+(\.[a-z0-9-]+)+/i) || ['example.com'])[0];
        const name = body.tools.some((t) => t.function.name === 'find_contact_info') ? 'find_contact_info' : body.tools[0].function.name;
        return json({ choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify({ url: target, domain: target, query: target }) } }] } }], usage });
      }
      const seen = tool?.content || '';
      const title = (seen.match(/Title: (.*)/) || [])[1] || seen.replace(/\s+/g, ' ').slice(0, 80);
      const sys = body.messages.find((m) => m.role === 'system')?.content || '';
      const shape = (sys.match(/\{("[a-z_]+": [^}]*)\}/) || [])[1];
      const fields = shape ? [...shape.matchAll(/"([a-z_]+)": ([a-z ]+)/g)].map((m) => [m[1], m[2]]) : [];
      const answer = fields.length ? JSON.stringify(Object.fromEntries(fields.map(([k, t]) => [k, t.startsWith('a number') ? 7 : t.startsWith('true') ? true : k === 'summary' ? `From the site: ${title}`.slice(0, 160) : `(preview) ${k}`])))
        : `From the site: ${title}`.slice(0, 200);
      return json({ choices: [{ message: { content: answer } }], usage });
    }
    return fetch(url, init);
  };
  env.GOOGLE_MAPS_API_KEY = 'fake-key-for-the-preview';   // only ever sent to the fake above
  env.GROQ_API_KEY = REAL_AI ? process.env.GROQ_API_KEY : 'fake-key-for-the-preview';   // --real-ai: your real key, from the environment
  env.TREG_TOKEN = REAL_TREG ? process.env.TREG_TOKEN : 'fake-key-for-the-preview';   // --real-treg: your real token (paid, capped)
  // List the fake keys by name, so the pages show them as set, like a real install with keys.
  for (const n of ['GROQ_API_KEY', 'TREG_TOKEN', 'GOOGLE_MAPS_API_KEY']) {
    sql.prepare('INSERT OR IGNORE INTO secrets_index (name, note, created_at) VALUES (?, ?, ?)').run(n, (n === 'TREG_TOKEN' && REAL_TREG) || (n === 'GROQ_API_KEY' && REAL_AI) ? 'preview (real)' : 'preview (fake)', new Date().toISOString());
  }
}

env.ASSETS = { async fetch(request) {
  const path = new URL(request.url).pathname;
  const rel = normalize(path === '/' ? 'index.html' : path.slice(1));
  const inside = !rel.startsWith('..') && extname(rel);
  try {
    if (!inside) throw new Error('spa');
    return new Response(await readFile(join(PUBLIC, rel)), { headers: { 'content-type': TYPES[extname(rel)] || 'application/octet-stream' } });
  } catch {
    return new Response(await readFile(join(PUBLIC, 'index.html')), { headers: { 'content-type': TYPES['.html'] } });
  }
} };

createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const r = await worker.fetch(request, env, { waitUntil: () => {} }, deps);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`free-clay preview on http://localhost:${port}  (password: ${env.APP_PASSWORD})`));

if (worker.scheduled) setInterval(() => worker.scheduled({ cron: 'preview' }, env, { waitUntil: () => {} }).catch((e) => console.error('drain:', e.message)), 5000);
