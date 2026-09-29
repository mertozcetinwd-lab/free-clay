/**
 * Find leads, Companies and Jobs tabs (LOAM-PLAN.md phase 6c). Same shape as Local businesses:
 * filters, a free preview with pick boxes, then import into a new or existing table. The Worker
 * runs every request (src/opendata/companies.js, jobs.js) and keeps the preview for Import.
 */

import { h } from '../dom.js';
import { icon } from '../icons.js';
import { fmtMicros } from '../types.js';
import { api } from '../api.js';
import { state, changed, refreshTableList } from '../store.js';
import { nav } from '../nav.js';
import { toast, menu, popover } from '../ui/overlay.js';

const STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI',
  'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA',
  'WV', 'WI', 'WY'];
const MAX_SEC_DETAILS = 10;   // src/opendata/companies.js

const co = { source: 'wikidata', industry: '', state: 'FL', q: '', search: null, results: null, picked: new Set(), busy: false, error: null };
const lk = { url: '', search: null, results: null, picked: new Set(), busy: false, error: null, cost: null };
const jb = { companies: '', keyword: '', search: null, results: null, boards: null, picked: new Set(), busy: false, error: null };

/* ---------------------------------------------------------------- shared */

function pickTable(list, keyField, view, columns, first) {
  const allOn = list.length && list.every((r) => view.picked.has(r[keyField]));
  const toggle = (k) => { view.picked.has(k) ? view.picked.delete(k) : view.picked.add(k); changed(); };
  return h('div', { class: 'find-table-wrap' }, h('table', { class: 'files-table find-table' },
    h('thead', null, h('tr', null,
      h('th', { class: 'c-pick' }, h('button', { class: 'check', role: 'checkbox', 'aria-checked': allOn ? 'true' : 'false', 'aria-label': 'Pick all',
        onClick: () => { view.picked = allOn ? new Set() : new Set(list.map((r) => r[keyField])); changed(); } }, allOn ? icon('check', 12, 2.5) : null)),
      columns.map(([label]) => h('th', null, label)))),
    h('tbody', null, list.map((r) => h('tr', { class: 'no-open' },
      h('td', { class: 'c-pick' }, h('button', { class: 'check', role: 'checkbox', 'aria-checked': view.picked.has(r[keyField]) ? 'true' : 'false', 'aria-label': `Pick ${r[first]}`,
        onClick: () => toggle(r[keyField]) }, view.picked.has(r[keyField]) ? icon('check', 12, 2.5) : null)),
      columns.map(([, get], i) => {
        const v = get(r);
        if (i === 0) return h('td', null, h('a', { href: r[keyField], target: '_blank', rel: 'noopener noreferrer' }, v));
        return h('td', { class: 'ellipsis' }, v ?? h('span', { class: 'faint' }, '—'));
      }))))));
}

function importButton(view, route, defaultName) {
  return h('button', { class: 'btn primary', disabled: !view.picked.size, onClick: (e) => importMenu(e.currentTarget, view, route, defaultName()) },
    icon('download', 14), `Import ${view.picked.size.toLocaleString('en-US')}`, icon('chevron-down', 13));
}

function importMenu(anchor, view, route, name) {
  const tables = state.boot?.tables || [];
  const go = async (target) => {
    try {
      const r = await api.post(route, { search: view.search, only: [...view.picked], ...target });
      await refreshTableList();
      toast(`Imported ${r.added.toLocaleString('en-US')} row${r.added === 1 ? '' : 's'}${r.skipped_duplicates ? `, ${r.skipped_duplicates} already in the table` : ''}.`);
      nav.go(`/t/${r.table_id}`);
    } catch (e) { toast(e.message, { error: true }); }
  };
  menu(anchor, [
    { label: 'Into a new table', icon: 'plus', onSelect: () => setTimeout(() => popover(anchor, (el, pop) => {
      const input = h('input', { class: 'input', value: name.slice(0, 80), 'aria-label': 'Table name' });
      const ok = () => { const n = input.value.trim(); if (!n) return; pop.close(); go({ new_name: n }); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      el.append(h('div', { class: 'pop-body' }, input, h('button', { class: 'btn primary', onClick: ok }, 'Import')));
      setTimeout(() => { input.focus(); input.select(); });
    }, { width: 300, align: 'end' })) },
    ...(tables.length ? [{ sep: true }, { group: 'Into an existing table' }] : []),
    ...tables.slice(0, 12).map((t) => ({ label: t.name, icon: 'table', onSelect: () => go({ table_id: t.id }) })),
    ...(route === '/find/companies/import' ? [{ sep: true }, { group: 'Into Audiences' },
      { label: 'Companies', icon: 'building', sub: 'matched by domain', onSelect: () => import('./find.js').then((m) => m.toCompanies('/find/companies/to-companies', { search: view.search, only: [...view.picked] })) }] : []),
  ], { width: 280, align: 'end' });
}

const status = (view, text) => (view.busy ? h('div', { class: 'tools-note find-status', role: 'status' }, icon('clock', 14), h('span', null, text))
  : view.error ? h('div', { class: 'note warn find-status', role: 'alert' }, icon('alert', 14), h('span', null, view.error)) : null);

/* ---------------------------------------------------------------- companies */

export function companiesTab() {
  const tab = (k, label) => h('button', { class: ['seg', co.source === k && 'on'], onClick: () => { co.source = k; co.results = null; co.error = null; changed(); } }, label);
  const go = () => searchCompanies();
  const enter = (e) => { if (e.key === 'Enter') go(); };
  const filters = co.source === 'wikidata'
    ? [h('label', { class: 'label', for: 'co-industry' }, 'Industry'),
      h('input', { class: 'input', id: 'co-industry', value: co.industry, placeholder: 'construction, software, insurance…', onInput: (e) => { co.industry = e.target.value; }, onKeydown: enter }),
      h('label', { class: 'label', for: 'co-state' }, 'Headquarters'),
      h('select', { class: 'select', id: 'co-state', onChange: (e) => { co.state = e.target.value; } },
        h('option', { value: '', selected: !co.state }, 'All states'), STATES.map((s) => h('option', { value: s, selected: co.state === s }, s))),
      h('p', { class: 'faint find-note' }, 'Free. Wikidata lists companies notable enough for an encyclopedia entry, with website, size and founding year. For local trades use Local businesses.')]
    : [h('label', { class: 'label', for: 'co-q' }, 'Company name or ticker'),
      h('input', { class: 'input', id: 'co-q', value: co.q, placeholder: 'Home Depot, HD…', onInput: (e) => { co.q = e.target.value; }, onKeydown: enter }),
      h('p', { class: 'faint find-note' }, 'Free. Every US company with a stock ticker, from the SEC. Pick up to 10 and add their industry, address, phone and website.')];
  return h('div', { class: 'find-local' },
    h('div', { class: 'find-grid find-grid-data' },
      h('div', { class: 'find-filters' },
        h('div', { class: 'seg-tabs find-source', role: 'tablist', 'aria-label': 'Source' }, tab('wikidata', 'Wikidata'), tab('sec', 'SEC (public)')),
        ...filters,
        h('button', { class: 'btn primary find-go', disabled: co.busy, onClick: go }, icon(co.busy ? 'clock' : 'search', 14), co.busy ? 'Searching…' : 'Search')),
      h('div', { class: 'find-side' },
        status(co, co.source === 'wikidata' ? 'Asking Wikidata… broad industries can take up to a minute.' : 'Searching SEC filers…') ||
        (co.results ? companyResults() : h('div', { class: 'files-empty' }, 'Search to preview companies here. Previews are free; nothing is saved until you import.')))));
}

async function searchCompanies() {
  co.busy = true; co.error = null; co.results = null; changed();
  try {
    const r = co.source === 'wikidata'
      ? await api.post('/find/companies/wikidata', { industry: co.industry, state: co.state })
      : await api.post('/find/companies/sec', { q: co.q });
    co.search = r.search; co.results = r.results; co.picked = new Set(r.results.map((c) => c.source_url));
  } catch (e) { co.error = e.message; }
  co.busy = false; changed();
}

async function secDetails() {
  const ciks = co.results.filter((c) => co.picked.has(c.source_url) && !c.industry).map((c) => c.cik).slice(0, MAX_SEC_DETAILS);
  if (!ciks.length) { toast('The picked companies already have details.'); return; }
  co.busy = true; changed();
  try { const r = await api.post('/find/companies/sec-details', { search: co.search, ciks }); co.results = r.results; }
  catch (e) { toast(e.message, { error: true }); }
  co.busy = false; changed();
}

function companyResults() {
  const list = co.results;
  const cols = co.source === 'wikidata'
    ? [['Company', (c) => c.name], ['Website', (c) => c.domain], ['Industry', (c) => c.industry], ['Employees', (c) => c.employees?.toLocaleString('en-US')],
      ['Founded', (c) => c.founded], ['Headquarters', (c) => c.hq]]
    : [['Company', (c) => c.name], ['Ticker', (c) => c.ticker], ['Exchange', (c) => c.exchange], ['Industry', (c) => c.industry], ['Website', (c) => c.domain],
      ['Headquarters', (c) => c.hq], ['Phone', (c) => c.phone]];
  const label = co.source === 'wikidata' ? `${co.industry} companies${co.state ? ` in ${co.state}` : ''}` : `${co.q} (SEC)`;
  return h('section', { class: 'find-results' },
    h('div', { class: 'files-head' },
      h('h2', null, `${list.length.toLocaleString('en-US')} found`),
      h('span', { class: 'grow' }),
      co.source === 'sec' && list.length ? h('button', { class: 'btn', disabled: !co.picked.size, onClick: secDetails, title: 'Reads each picked company\'s SEC record' }, icon('sparkle', 14), `Add details (up to ${MAX_SEC_DETAILS})`) : null,
      list.length ? importButton(co, '/find/companies/import', () => label) : null),
    h('p', { class: 'faint find-credit' }, co.source === 'wikidata' ? 'Data: Wikidata (CC0). Check a company before you contact it.' : 'Data: SEC EDGAR (public domain).'),
    list.length ? pickTable(list, 'source_url', co, cols, 'name')
      : h('div', { class: 'files-empty' }, co.source === 'wikidata' ? 'No companies found. Try a broader industry word or All states.' : 'No SEC filer matches that name or ticker.'));
}

/* ---------------------------------------------------------------- lookalikes */

export function lookalikesTab() {
  const exa = state.boot?.secrets?.find((s) => s.name === 'EXA_API_KEY');
  const go = async () => {
    lk.busy = true; lk.error = null; lk.results = null; changed();
    try {
      const r = await api.post('/find/lookalikes', { url: lk.url });
      lk.search = r.search; lk.results = r.results; lk.cost = r.cost_micros; lk.picked = new Set(r.results.map((c) => c.source_url));
      if (r.cost_micros) { const b = await api.get('/bootstrap'); state.boot.month_micros = b.month_micros; }
    } catch (e) { lk.error = e.message; }
    lk.busy = false; changed();
  };
  const cols = [['Company page', (c) => c.name], ['Domain', (c) => c.domain], ['Match', (c) => c.score]];
  return h('div', { class: 'find-local' },
    h('div', { class: 'find-grid find-grid-data' },
      h('div', { class: 'find-filters' },
        h('label', { class: 'label', for: 'lk-url' }, 'A customer you like'),
        h('input', { class: 'input', id: 'lk-url', value: lk.url, placeholder: 'example.com', onInput: (e) => { lk.url = e.target.value; }, onKeydown: (e) => { if (e.key === 'Enter') go(); } }),
        h('button', { class: 'btn primary find-go', disabled: lk.busy || !exa?.set, onClick: go }, icon(lk.busy ? 'clock' : 'sparkle', 14), lk.busy ? 'Searching…' : 'Find lookalikes'),
        h('p', { class: 'faint find-note' }, 'Uses Exa on your key: about $0.007 per search (Exa’s measured price), up to 25 companies. The same site again within 7 days is free (cached).'),
        exa?.set ? null : h('div', { class: 'note warn' }, icon('key', 14), h('span', null, 'Needs EXA_API_KEY: ', h('code', null, 'npx wrangler secret put EXA_API_KEY'), exa ? ', then reload.' : ', then add the name in Settings, Keys.'))),
      h('div', { class: 'find-side' },
        status(lk, 'Asking Exa…') || (lk.results ? h('section', { class: 'find-results' },
          h('div', { class: 'files-head' }, h('h2', null, `${lk.results.length} lookalike${lk.results.length === 1 ? '' : 's'} of ${lk.search.domain}`), h('span', { class: 'grow' }),
            lk.results.length ? importButton(lk, '/find/companies/import', () => `Lookalikes of ${lk.search.domain}`) : null),
          h('p', { class: 'faint find-credit' }, `${lk.cost ? `Cost ${fmtMicros(lk.cost)}. ` : 'From the cache, free. '}Results are web pages: check each one is a company before you contact it.`),
          lk.results.length ? pickTable(lk.results, 'source_url', lk, cols, 'name') : h('div', { class: 'files-empty' }, 'Exa found nothing close. Try the company’s main site.'))
          : h('div', { class: 'files-empty' }, 'Paste a customer’s website to see companies like them.')))));
}

/* ---------------------------------------------------------------- jobs */

export function jobsTab() {
  const go = () => searchJobs();
  return h('div', { class: 'find-local' },
    h('div', { class: 'find-grid find-grid-data' },
      h('div', { class: 'find-filters' },
        h('label', { class: 'label', for: 'jb-companies' }, 'Companies (up to 10)'),
        h('textarea', { class: 'input', id: 'jb-companies', rows: 4, placeholder: 'discord.com\nnotion.so\nfigma', value: jb.companies, onInput: (e) => { jb.companies = e.target.value; } }),
        h('label', { class: 'label', for: 'jb-keyword' }, 'Role keyword (optional)'),
        h('input', { class: 'input', id: 'jb-keyword', value: jb.keyword, placeholder: 'sales, engineer, marketing…', onInput: (e) => { jb.keyword = e.target.value; }, onKeydown: (e) => { if (e.key === 'Enter') go(); } }),
        h('button', { class: 'btn primary find-go', disabled: jb.busy, onClick: go }, icon(jb.busy ? 'clock' : 'search', 14), jb.busy ? 'Searching…' : 'Find open roles'),
        h('p', { class: 'faint find-note' }, 'Free, no key. Reads each company\'s public job board on Greenhouse, Lever or Ashby. A company hiring for a role is a reason to reach out now.')),
      h('div', { class: 'find-side' },
        status(jb, 'Checking job boards…') || (jb.results ? jobResults() : h('div', { class: 'files-empty' }, 'Type company websites or names to preview their open roles here.')))));
}

async function searchJobs() {
  jb.busy = true; jb.error = null; jb.results = null; changed();
  try {
    const r = await api.post('/find/jobs', { companies: jb.companies, keyword: jb.keyword });
    jb.search = r.search; jb.results = r.results; jb.boards = r.boards; jb.picked = new Set(r.results.map((j) => j.url));
  } catch (e) { jb.error = e.message; }
  jb.busy = false; changed();
}

function jobResults() {
  const list = jb.results;
  const cols = [['Role', (j) => j.title], ['Company', (j) => j.company], ['Location', (j) => j.location], ['Department', (j) => j.department], ['Posted', (j) => j.posted]];
  return h('section', { class: 'find-results' },
    h('div', { class: 'files-head' },
      h('h2', null, `${list.length.toLocaleString('en-US')} open role${list.length === 1 ? '' : 's'}`),
      h('span', { class: 'grow' }),
      list.length ? importButton(jb, '/find/jobs/import', () => `Open roles${jb.search?.keyword ? `: ${jb.search.keyword}` : ''}`) : null),
    h('p', { class: 'faint find-credit' }, Object.entries(jb.boards || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')),
    list.length ? pickTable(list, 'url', jb, cols, 'title')
      : h('div', { class: 'files-empty' }, 'No open roles found. The company may use another job board, or none matched the keyword.'));
}
