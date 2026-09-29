/**
 * Signals (LOAM-PLAN.md phase 9; Clay's Signals, a paid add-on there, teardown-v2 5.1): watch a
 * list of companies and record an event when something changes. Free public sources only:
 *
 *   jobs     new roles on the company's public Greenhouse, Lever or Ashby board (src/opendata/jobs.js)
 *   website  the text of a page changed (SHA-256 of the visible text)
 *   news     new Google News RSS items for a name or phrase
 *   sec      new SEC filings of chosen forms (Form D = raised money, 8-K = material news); needs the
 *            contact email SEC asks for (src/opendata/http.js)
 *
 * The first check of each target saves a baseline and records nothing, so switching a signal on
 * does not flood you with everything that already exists. The cron checks a few due targets a
 * minute inside the free plan's 50 requests per invocation. Each new event can add a row to a
 * table and start workflows whose trigger is this signal.
 */

import { fail, nowIso, parseJson } from './util.js';
import { jobSearch } from './opendata/jobs.js';
import { secCompanies } from './opendata/companies.js';
import { openFetch } from './opendata/http.js';
import { fetchPage, htmlToText, readCapped } from './functions/web.js';
import { getTableRow, loadColumns, insertRows, hooks } from './tables.js';
import { columnsFor } from './find.js';
import { fireSignal } from './workflows.js';

export const SIGNAL_TYPES = {
  jobs: { label: 'New job posted', target: 'Company (board name or domain, like figma or notion.so)', fetches: 3 },
  website: { label: 'Website changed', target: 'Page URL or domain', fetches: 2 },
  news: { label: 'In the news', target: 'Name or phrase (quoted for exact match)', fetches: 1 },
  sec: { label: 'New SEC filing', target: 'Ticker or CIK number', fetches: 2 },
};
export const MAX_TARGETS = 50;
export const FETCH_CAP = 36;
const SEEN_CAP = 400;

const EVENT_COLUMNS = [['signal', 'Signal', 'text'], ['target', 'Company', 'text'], ['title', 'What happened', 'text'], ['url', 'Link', 'url'], ['at', 'Seen', 'date']];

export function checkSignal(b, cur = {}) {
  const s = { ...cur };
  if (b.name !== undefined) s.name = String(b.name).trim().slice(0, 80);
  if (!s.name) fail(400, 'Name the signal');
  if (b.type !== undefined) { if (!SIGNAL_TYPES[b.type]) fail(400, 'Pick what to watch'); s.type = b.type; }
  if (!SIGNAL_TYPES[s.type]) fail(400, 'Pick what to watch');
  if (b.targets !== undefined) {
    const raw = Array.isArray(b.targets) ? b.targets : String(b.targets).split(/\n|,(?=\s*\S)/);
    s.targets = [...new Set(raw.map((t) => String(t).trim().slice(0, 200)).filter(Boolean))];
  }
  if (!s.targets?.length) fail(400, 'Add at least one company to watch');
  if (s.targets.length > MAX_TARGETS) fail(400, `Up to ${MAX_TARGETS} companies per signal`);
  if (b.keyword !== undefined) s.keyword = String(b.keyword || '').trim().toLowerCase().slice(0, 60);
  if (b.forms !== undefined) s.forms = (Array.isArray(b.forms) ? b.forms : String(b.forms).split(/[\s,]+/)).map((f) => String(f).trim().toUpperCase()).filter((f) => /^[A-Z0-9/-]{1,10}$/.test(f)).slice(0, 10);
  if (s.type === 'sec' && !s.forms?.length) s.forms = ['D', '8-K'];
  if (b.every_hours !== undefined) {
    if (!(Number.isInteger(b.every_hours) && b.every_hours >= 1 && b.every_hours <= 168)) fail(400, 'Check every 1 to 168 hours');
    s.every_hours = b.every_hours;
  }
  s.every_hours = s.every_hours || 24;
  if (b.table_id !== undefined) s.table_id = b.table_id === null ? null : Number.isInteger(b.table_id) ? b.table_id : fail(400, 'Pick a table');
  if (b.status !== undefined) { if (!['on', 'off'].includes(b.status)) fail(400, 'status is on or off'); s.status = b.status; }
  return s;
}

const sigOut = (r) => ({ id: r.id, name: r.name, status: r.status, created_at: r.created_at, updated_at: r.updated_at, ...parseJson(r.config, {}) });

export async function listSignals(db) {
  const { results } = await db.prepare(`SELECT s.*, (SELECT count(*) FROM signal_events e WHERE e.signal_id=s.id) AS events,
      (SELECT max(created_at) FROM signal_events e WHERE e.signal_id=s.id) AS last_event,
      (SELECT max(checked_at) FROM signal_state t WHERE t.signal_id=s.id) AS last_check FROM signals s ORDER BY s.updated_at DESC`).all();
  return results.map((r) => ({ ...sigOut(r), events: r.events, last_event: r.last_event, last_check: r.last_check }));
}

export async function getSignal(db, id) {
  const r = await db.prepare('SELECT * FROM signals WHERE id=?1').bind(id).first();
  if (!r) fail(404, 'No such signal');
  return sigOut(r);
}

export async function createSignal(db, body) {
  const s = checkSignal({ status: 'off', ...body });
  if (s.table_id) await getTableRow(db, s.table_id);
  if ((await db.prepare('SELECT count(*) AS n FROM signals').first()).n >= 50) fail(400, 'Up to 50 signals');
  const { name, status, ...config } = s;
  const at = nowIso();
  const [r] = await db.batch([db.prepare('INSERT INTO signals (name, status, config, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) RETURNING id').bind(name, status, JSON.stringify(config), at)]);
  return getSignal(db, r.results[0].id);
}

export async function patchSignal(db, id, body) {
  const cur = await getSignal(db, id);
  const s = checkSignal(body, cur);
  if (s.table_id) await getTableRow(db, s.table_id);
  const { name, status, id: _i, created_at: _c, updated_at: _u, ...config } = s;
  // Changing what is watched starts fresh baselines for the new targets only.
  await db.prepare('UPDATE signals SET name=?2, status=?3, config=?4, updated_at=?5 WHERE id=?1').bind(id, name, status, JSON.stringify(config), nowIso()).run();
  if (body.type && body.type !== cur.type) await db.prepare('DELETE FROM signal_state WHERE signal_id=?1').bind(id).run();
  return getSignal(db, id);
}

export async function deleteSignal(db, id) {
  await getSignal(db, id);
  await db.batch(['signal_events', 'signal_state'].map((t) => db.prepare(`DELETE FROM ${t} WHERE signal_id=?1`).bind(id)).concat(db.prepare('DELETE FROM signals WHERE id=?1').bind(id)));
  return { ok: true };
}

export async function listEvents(db, { signal_id, limit = 100 } = {}) {
  const where = signal_id ? 'WHERE e.signal_id=?1' : 'WHERE ?1 IS NULL';
  const { results } = await db.prepare(`SELECT e.*, s.name AS signal_name FROM signal_events e JOIN signals s ON s.id=e.signal_id ${where} ORDER BY e.id DESC LIMIT ${Math.min(500, limit)}`)
    .bind(signal_id || null).all();
  return results.map((r) => ({ ...r, detail: parseJson(r.detail, {}) }));
}

/* ---------------------------------------------------------------- the checks */

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Google News RSS, parsed with plain string work (no DOMParser in a Worker). */
export function parseRss(xml) {
  const items = [];
  const tag = (s, t) => { const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(s); return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : null; };
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const link = tag(m[1], 'link');
    if (!link || !/^https:\/\//.test(link)) continue;
    items.push({ title: (tag(m[1], 'title') || '').slice(0, 300), url: link.slice(0, 500), published: tag(m[1], 'pubDate'), source: (tag(m[1], 'source') || '').slice(0, 100) });
  }
  return items.slice(0, 50);
}

/** Sentences in the new text that were not in the old one: what changed, in words. */
export function addedSentences(before, after, n = 3) {
  const split = (t) => String(t || '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 20);
  const old = new Set(split(before));
  return split(after).filter((s) => !old.has(s)).slice(0, n);
}

/**
 * One target: returns {state, events}. prev is null on the first check (baseline: no events).
 */
const CHECKERS = {
  async jobs(db, deps, sig, target, prev) {
    const r = await jobSearch(db, deps, { companies: [target], keyword: sig.keyword || '' });
    const seen = new Set(prev?.seen || []);
    const events = prev ? r.results.filter((j) => !seen.has(j.url)).map((j) => ({ title: `${j.title}${j.location ? ` (${j.location})` : ''}`, url: j.url, detail: { department: j.department, posted: j.posted, board: j.ats } })) : [];
    return { state: { seen: [...new Set([...r.results.map((j) => j.url), ...seen])].slice(0, SEEN_CAP), board: Object.values(r.boards)[0] }, events };
  },
  async website(db, deps, sig, target, prev) {
    const page = await fetchPage(deps.fetch, target, { cap: 150_000 });
    if (!page.ok) throw new Error(page.status ? `The page answered HTTP ${page.status}` : `Could not reach it: ${page.error}`);
    const text = htmlToText(page.html, 20_000);
    const hash = await sha256(text);
    const changed = prev && prev.hash !== hash;
    const added = changed ? addedSentences(prev.text, text) : [];
    return { state: { hash, text: text.slice(0, 8000), url: page.url },
      events: changed ? [{ title: added[0] ? `Changed: “${added[0].slice(0, 140)}”` : 'The page text changed', url: page.url, detail: { added } }] : [] };
  },
  async news(db, deps, sig, target, prev) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(target)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await openFetch(db, deps, url, { init: { headers: { accept: 'application/rss+xml, application/xml' } } });
    if (!res.ok) throw new Error(`Google News answered ${res.status}`);
    const items = parseRss(await readCapped(res, 400_000));
    const seen = new Set(prev?.seen || []);
    const events = prev ? items.filter((i) => !seen.has(i.url)).map((i) => ({ title: i.title, url: i.url, detail: { source: i.source, published: i.published } })) : [];
    return { state: { seen: [...new Set([...items.map((i) => i.url), ...seen])].slice(0, SEEN_CAP) }, events };
  },
  async sec(db, deps, sig, target, prev) {
    let cik = /^\d{1,10}$/.test(target) ? Number(target) : null;
    if (!cik) {
      const hit = (await secCompanies(db, deps, { q: target })).results.find((c) => c.ticker.toLowerCase() === target.toLowerCase());
      if (!hit) throw new Error(`No SEC company with the ticker ${target}`);
      cik = hit.cik;
    }
    const res = await openFetch(db, deps, `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, { needsContact: true });
    if (!res.ok) throw new Error(`SEC answered ${res.status}`);
    const j = await res.json();
    const r = j.filings?.recent || {};
    const list = (r.accessionNumber || []).slice(0, 100).map((acc, i) => ({ acc, form: r.form?.[i], date: r.filingDate?.[i], doc: r.primaryDocument?.[i] }))
      .filter((f) => sig.forms.includes(String(f.form).toUpperCase()));
    const seen = new Set(prev?.seen || []);
    const link = (f) => `https://www.sec.gov/Archives/edgar/data/${cik}/${f.acc.replace(/-/g, '')}/${f.doc || ''}`;
    const events = prev ? list.filter((f) => !seen.has(f.acc)).map((f) => ({ title: `Form ${f.form} filed ${f.date}${f.form === 'D' ? ' (a private fundraise)' : ''}`, url: link(f), detail: { form: f.form, date: f.date, company: j.name } })) : [];
    return { state: { seen: [...new Set([...list.map((f) => f.acc), ...seen])].slice(0, SEEN_CAP), name: j.name }, events };
  },
};

/** Check one signal's targets now (the "Check now" button), up to the fetch cap. */
export async function checkSignalNow(env, deps, id) {
  const sig = await getSignal(env.DB, id);
  return runChecks(env, deps, [sig], { force: true });
}

/** The cron: every signal that is on, targets whose next check is due. */
export async function checkDueSignals(env, deps = {}) {
  const { results } = await env.DB.prepare(`SELECT * FROM signals WHERE status='on'`).all();
  return runChecks(env, deps, results.map(sigOut), { force: false });
}

async function runChecks(env, deps, sigs, { force }) {
  const db = env.DB;
  const now = deps.now || new Date();
  let fetches = 0;
  const base = deps.fetch || globalThis.fetch;
  const d = { ...deps, fetch: (...a) => { fetches++; return base(...a); } };
  const report = { checked: 0, events: 0, errors: [], skipped: 0 };
  for (const sig of sigs) {
    const { results: states } = await db.prepare('SELECT * FROM signal_state WHERE signal_id=?1').bind(sig.id).all();
    const byTarget = new Map(states.map((s) => [s.target, s]));
    const due = sig.targets.filter((t) => force || !byTarget.get(t) || Date.parse(byTarget.get(t).checked_at) + sig.every_hours * 3600_000 <= now.getTime());
    const newEvents = [];
    for (const target of due) {
      if (fetches + SIGNAL_TYPES[sig.type].fetches > FETCH_CAP) { report.skipped++; continue; }
      const prevRow = byTarget.get(target);
      const prev = prevRow ? parseJson(prevRow.state, null) : null;
      let res; let error = null;
      try { res = await CHECKERS[sig.type](db, d, sig, target, prev); }
      catch (e) { error = String(e?.message || e).slice(0, 300); report.errors.push({ signal: sig.id, target, error }); }
      report.checked++;
      await db.prepare(`INSERT INTO signal_state (signal_id, target, state, error, checked_at) VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(signal_id, target) DO UPDATE SET state=COALESCE(?3, signal_state.state), error=?4, checked_at=?5`)
        .bind(sig.id, target, res ? JSON.stringify(res.state) : null, error, now.toISOString()).run();
      for (const ev of res?.events || []) newEvents.push({ ...ev, target });
    }
    if (!newEvents.length) continue;
    report.events += newEvents.length;
    const at = now.toISOString();
    await db.prepare(`INSERT INTO signal_events (signal_id, target, title, url, detail, created_at)
        SELECT ?1, json_extract(value,'$.target'), json_extract(value,'$.title'), json_extract(value,'$.url'), json(json_extract(value,'$.detail')), ?2 FROM json_each(?3)`)
      .bind(sig.id, at, JSON.stringify(newEvents.map((e) => ({ ...e, detail: e.detail || {} })))).run();
    const items = newEvents.map((e) => ({ signal: sig.name, target: e.target, title: e.title, url: e.url, at, ...e.detail }));
    if (sig.table_id) {
      try {
        await getTableRow(db, sig.table_id);
        const { cols, keyFor } = await columnsFor(db, sig.table_id, EVENT_COLUMNS);
        await insertRows(db, sig.table_id, items.map((it) => Object.fromEntries(EVENT_COLUMNS.map(([f]) => [keyFor[f], it[f] ?? null]))), cols);
        await hooks.afterWrite(db, sig.table_id, { newRows: true });
      } catch (e) { report.errors.push({ signal: sig.id, error: `Could not add rows: ${e.message}` }); }
    }
    await fireSignal(db, sig.id, items);
  }
  return report;
}
