/**
 * Find leads (LOAM-PLAN.md phase 6), laid out like Clay's Local businesses search
 * (site-teardowns/clay/teardown.md 3.4): filters on the left, a map on the right, a free preview
 * underneath, then import into a table. The map is Leaflet (BSD-2, public/vendor/leaflet) on
 * OpenStreetMap tiles, credited as the tile policy asks.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, changed, refreshTableList } from '../store.js';
import { nav } from '../nav.js';
import { toast, menu, popover, confirmDialog } from '../ui/overlay.js';
import { checkArea, runOverpass, OverpassError, AreaError } from '../overpass.js';
import { checkOpenArea, searchOpenPlaces, parseTile, TILE_ROOT } from '../open-places.js';
import { companiesTab, jobsTab, lookalikesTab } from './find-data.js';

const TABS = [['local', 'Local businesses', 'pin'], ['companies', 'Companies', 'building'], ['jobs', 'Jobs', 'file-text'], ['lookalikes', 'Lookalikes', 'sparkle']];
const view = { tab: 'local', source: null, pages: 1, place: '', placeName: '', center: null, radius: 5000, category: 'roofer', tag: '', results: null, busy: false, error: null, picked: new Set() };
let categories = null;

/* ---------------------------------------------------------------- the map (kept across redraws) */

let L = null; let map = null; let mapEl = null; let circle = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  return new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/leaflet/leaflet.css' }));
    const s = h('script', { src: '/vendor/leaflet/leaflet.js' });
    s.onload = () => resolve(window.L); s.onerror = () => reject(new Error('The map library did not load'));
    document.head.append(s);
  });
}

/** One map for the life of the page; each redraw moves the same element into the new layout. */
function mapNode() {
  if (!mapEl) {
    mapEl = h('div', { class: 'find-map', role: 'application', 'aria-label': 'Map. Click to set the center of the search.' });
    loadLeaflet().then((lib) => {
      L = lib;
      map = L.map(mapEl, { zoomControl: true, attributionControl: true }).setView([29.6516, -82.3248], 11);   // Gainesville until you search
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
      map.on('click', (e) => { view.center = { lat: e.latlng.lat, lon: e.latlng.lng }; view.results = null; drawCircle(); changed(); });
      drawCircle();
    }).catch((e) => toast(e.message, { error: true }));
  }
  requestAnimationFrame(() => map?.invalidateSize());
  return mapEl;
}

function drawCircle() {
  if (!map) return;
  if (!view.center) { circle?.remove(); circle = null; return; }
  const at = [view.center.lat, view.center.lon];
  if (!circle) circle = L.circle(at, { radius: view.radius, color: '#0382f7', weight: 2, fillOpacity: 0.08 }).addTo(map);
  else { circle.setLatLng(at); circle.setRadius(view.radius); }
}

function showResults() {
  if (!map || !L) return;
  if (map._loamPins) map._loamPins.remove();
  map._loamPins = L.layerGroup((view.results || []).filter((b) => b.lat !== null).map((b) =>
    L.circleMarker([b.lat, b.lon], { radius: 5, color: '#0382f7', weight: 1, fillOpacity: 0.8 }).bindTooltip(b.name))).addTo(map);
}

/* ---------------------------------------------------------------- page */

export function renderFind(regions) {
  mount(regions.top, h('div', { class: 'crumbs' }, h('a', { href: '/', onClick: (e) => { e.preventDefault(); nav.go('/'); } }, 'Home'), h('span', { class: 'sep' }, '/'), h('b', null, 'Find leads')));
  mount(regions.toolbar);
  if (!categories) api.get('/find/categories').then((c) => { categories = c; changed(); }).catch((e) => toast(e.message, { error: true }));
  mount(regions.content, h('div', { class: 'find' },
    h('div', { class: 'find-head' }, h('h1', null, 'Find leads'),
      h('div', { class: 'seg-tabs', role: 'tablist' }, TABS.map(([k, label, ic]) => h('button', { class: ['seg', view.tab === k && 'on'], role: 'tab', 'aria-selected': view.tab === k ? 'true' : 'false',
        onClick: () => { view.tab = k; changed(); } }, icon(ic, 14), label)))),
    view.tab === 'local' ? localTab() : view.tab === 'companies' ? companiesTab() : view.tab === 'jobs' ? jobsTab() : lookalikesTab()));
}

function localTab() {
  const place = h('input', { class: 'input', id: 'find-place', value: view.place, placeholder: 'Gainesville, FL', 'aria-label': 'Place',
    onInput: (e) => { view.place = e.target.value; }, onKeydown: (e) => { if (e.key === 'Enter') goTo(); } });
  const cat = h('select', { class: 'select', 'aria-label': 'Category', onChange: (e) => { view.category = e.target.value; view.results = null; changed(); } },
    (categories || []).map((c) => h('option', { value: c.id, selected: c.id === view.category }, c.label)),
    h('option', { value: '', selected: !view.category }, source() === 'open' ? 'Other (type a category)' : 'Other (type an OSM tag)'));
  const radius = h('input', { type: 'range', min: '500', max: '25000', step: '500', value: String(view.radius), 'aria-label': 'Radius',
    onInput: (e) => { view.radius = Number(e.target.value); drawCircle(); e.target.nextSibling.textContent = km(view.radius); },
    onChange: () => { view.results = null; changed(); } });
  return h('div', { class: 'find-local' },
    h('div', { class: 'find-grid' },
      h('div', { class: 'find-filters' },
        sourceSwitch(),
        h('label', { class: 'label', for: 'find-place' }, 'Where'),
        h('div', { class: 'row' }, place, h('button', { class: 'btn', onClick: goTo, title: 'Move the map here' }, icon('search', 14))),
        view.placeName ? h('div', { class: 'faint find-found' }, view.placeName) : h('div', { class: 'faint find-found' }, 'Or click the map to set the center.'),
        h('label', { class: 'label' }, 'What'), cat,
        !view.category ? h('input', { class: 'input', value: view.tag, placeholder: source() === 'open' ? 'pest_control_service' : 'craft=roofer', 'aria-label': source() === 'open' ? 'Category' : 'OSM tag', onInput: (e) => { view.tag = e.target.value.trim(); } }) : null,
        h('label', { class: 'label' }, 'Radius'), h('div', { class: 'row find-radius' }, radius, h('span', { class: 'faint' }, km(view.radius))),
        h('button', { class: 'btn primary find-go', disabled: view.busy || !view.center || (source() === 'google' && !googleKeySet()), onClick: search }, icon(view.busy ? 'clock' : 'search', 14), view.busy ? 'Searching…' : 'Search this area'),
        !view.center ? h('p', { class: 'faint find-note' }, 'Search a place or click the map first; the button needs a center.') : null,
        sourceNote()),
      mapNode()),
    view.busy ? h('div', { class: 'tools-note find-status', role: 'status' }, icon('clock', 14), h('span', null, { google: 'Searching Google Maps…', open: 'Searching open data…' }[source()] || 'Searching OpenStreetMap… this can take up to 30 seconds.'))
      : view.error ? h('div', { class: 'note warn find-status', role: 'alert' }, icon('alert', 14), h('span', null, view.error, ' If it keeps failing, Google Maps on your key (Tools, Sources) is the paid fallback.'))
        : view.results ? resultsSection() : null);
}

const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 ? 1 : 0)} km` : `${m} m`);

async function goTo() {
  if (!view.place.trim()) return;
  try {
    const g = await api.post('/find/geocode', { q: view.place });
    view.center = { lat: g.lat, lon: g.lon }; view.placeName = g.name; view.results = null;
    map?.setView([g.lat, g.lon], 12); drawCircle(); changed();
  } catch (e) { toast(e.message, { error: true }); }
}

/* ---------------------------------------------------------------- source: open data, Google Maps or OpenStreetMap */

// Google Text Search Enterprise (returns phone and website): $35 per 1,000, 1,000 free a month,
// checked 2026-09-28 (references/loam-sources.md). The server re-checks against your price override.
const GOOGLE_PER_SEARCH = 0.035;
const googleKeySet = () => !!(state.boot?.secrets || []).find((x) => x.name === 'GOOGLE_MAPS_API_KEY')?.set;
// Open data is the default: free, instant, and it found 28 roofers within 10 km of Gainesville
// where OpenStreetMap's place search found 0 (2026-09-28).
const source = () => view.source || 'open';

function sourceSwitch() {
  const tab = (k, label, title) => h('button', { class: ['seg', source() === k && 'on'], title, onClick: () => { view.source = k; view.results = null; view.error = null; changed(); } }, label);
  return h('div', { class: 'seg-tabs find-source', role: 'tablist', 'aria-label': 'Source' }, tab('open', 'Open data', 'Overture Maps, free'), tab('google', 'Google', 'Google Maps, on your key'), tab('osm', 'OSM', 'OpenStreetMap, free'));
}

function sourceNote() {
  if (source() === 'open' && !indexTried) { indexTried = true; openIndex().catch(() => {}); }   // for the total in this note
  if (source() === 'open') return h('p', { class: 'faint find-note' }, `Free, no key. ${openTotal()} US businesses from Overture Maps, searched in your browser. Nothing leaves your site.`);
  if (source() === 'osm') return h('p', { class: 'faint find-note' }, 'Free, no key. Only businesses someone mapped on OpenStreetMap, and its free servers are often busy. Google Maps finds far more.');
  if (!googleKeySet()) {
    return h('div', { class: 'note warn find-note' }, icon('key', 14), h('span', null, 'Google Maps needs your key. In the free-clay folder run ',
      h('code', null, 'npx wrangler secret put GOOGLE_MAPS_API_KEY'), ', then add the name in Settings, Keys, and reload.'));
  }
  const pages = h('select', { class: 'select', 'aria-label': 'How many results', onChange: (e) => { view.pages = Number(e.target.value); changed(); } },
    [1, 2, 3].map((n) => h('option', { value: n, selected: view.pages === n }, `${n * 20} results · up to $${(n * GOOGLE_PER_SEARCH).toFixed(3)}`)));
  return h('div', { class: 'stack find-note' }, pages,
    h('p', { class: 'faint', style: { margin: 0 } }, 'Your Google key: 1,000 searches free each month, then $0.035 each (Google, checked 2026-09-28). Clay uses the same source and charges credits for it.'));
}

function searchBody() {
  return { ...(source() === 'open' ? { source: 'open' } : {}), lat: view.center.lat, lon: view.center.lon, radius_m: view.radius, ...(view.category ? { category: view.category } : { tag: view.tag }) };
}

/**
 * The browser asks OpenStreetMap's Overpass servers itself (public/js/overpass.js says why), then
 * hands the answer to the Worker, which checks and saves it so Import writes exactly these rows.
 */
async function search() {
  const body = searchBody();
  if (source() === 'google') {
    const cost = (view.pages * GOOGLE_PER_SEARCH).toFixed(3);
    if (!(await confirmDialog({ title: 'Search Google Maps?', text: `This makes up to ${view.pages} paid request${view.pages > 1 ? 's' : ''} on your Google key: up to $${cost}, or $0 while your 1,000 free searches this month last. It is recorded in Spend.`, confirmLabel: `Search (up to $${cost})` }))) return;
    view.busy = true; view.error = null; view.results = null; view.via = null; view.note = null; changed();
    try { const r = await api.post('/find/local/google', { ...body, pages: view.pages }); setResults(r.results); view.via = 'google'; refreshTableList(); }
    catch (e) { view.error = e.message; }
    view.busy = false; changed();
    return;
  }
  view.busy = true; view.error = null; view.results = null; view.via = null; view.note = null; changed();
  if (source() === 'open') {
    try {
      const { results } = await searchOpenPlaces(checkOpenArea(body), await openIndex(), getTile);
      // Only the fields the Worker keeps; it re-checks them and saves them for Import.
      const places = results.map(({ name, phone, website, listing, email, address, city, lat, lon }) => ({ name, phone, website, listing, email, address, city, lat, lon }));
      const r = await api.post('/find/local/open', { ...body, places });
      setResults(r.results); view.via = 'open';
    } catch (e) { view.error = e.message; }
    view.busy = false; changed();
    return;
  }
  try {
    const elements = await runOverpass(checkArea(body));
    const r = await api.post('/find/local', { ...body, elements });
    setResults(r.results);
  } catch (e) {
    if (!(e instanceof OverpassError)) { view.error = e.message; }
    else {
      // Second route: the Worker asks OpenStreetMap's place search (src/opendata/osm.js, nominatimBusinesses).
      try {
        const r = await api.post('/find/local/nominatim', body);
        setResults(r.results); view.via = 'nominatim'; view.note = e.log.join(', ');
      } catch (e2) { view.error = `${e.message} The backup place search failed too: ${e2.message}`; }
    }
  }
  view.busy = false; changed();
}

/**
 * The tile list. A missing file comes back as the app's index.html (the Worker serves the app for
 * unknown paths), so anything that is not JSON means the data has not been built and deployed.
 */
let indexP = null; let indexRows = null; let indexTried = false;
const openTotal = () => (indexRows ? `${(indexRows / 1e6).toFixed(1)} million` : 'Millions of');
function openIndex() {
  indexP ||= fetch(`${TILE_ROOT}/index.json`).then((r) => r.json()).then((ix) => { if (indexRows !== ix.rows) { indexRows = ix.rows; changed(); } return ix; }).catch(() => {
    indexP = null;
    throw new AreaError('The open business data is not on this site yet. In the free-clay folder run: node dev/get-places.mjs  then  npx wrangler deploy');
  });
  return indexP;
}

async function getTile(name) {
  const r = await fetch(`${TILE_ROOT}/t/${name}.json`);
  if (!r.ok) throw new AreaError(`Could not load map tile ${name} (${r.status}). Try again.`);
  return parseTile(await r.text());
}

function setResults(list) {
  view.results = list; view.picked = new Set(list.map((b) => b.osm_url));
  showResults();
}

function resultsSection() {
  const list = view.results;
  const withSite = list.filter((b) => b.website).length; const withPhone = list.filter((b) => b.phone).length;
  const allOn = list.length && list.every((b) => view.picked.has(b.osm_url));
  const toggle = (u) => { view.picked.has(u) ? view.picked.delete(u) : view.picked.add(u); changed(); };
  return h('section', { class: 'find-results' },
    h('div', { class: 'files-head' },
      h('h2', null, `${list.length.toLocaleString('en-US')} found`),
      h('span', { class: 'faint' }, `${withSite} with a website, ${withPhone} with a phone`),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', disabled: !view.picked.size, onClick: (e) => importMenu(e.currentTarget) }, icon('download', 14), `Import ${view.picked.size.toLocaleString('en-US')}`, icon('chevron-down', 13))),
    view.via === 'open' ? h('p', { class: 'faint find-credit' }, 'Data: Overture Maps Foundation, Overture Places (CDLA Permissive 2.0), release 2026-09-23. Check a business before you contact it: listings can be out of date.') : null,
    view.via === 'nominatim' ? h('div', { class: 'tools-note' }, icon('alert', 14), h('span', null,
      'Found with OpenStreetMap place search, because the full search servers did not answer (', view.note, '). It returns at most 50 and can miss businesses; try Search again later for the full list.')) : null,
    list.length ? h('div', { class: 'find-table-wrap' }, h('table', { class: 'files-table find-table' },
      h('thead', null, h('tr', null,
        h('th', { class: 'c-pick' }, h('button', { class: 'check', role: 'checkbox', 'aria-checked': allOn ? 'true' : 'false', 'aria-label': 'Pick all',
          onClick: () => { view.picked = allOn ? new Set() : new Set(list.map((b) => b.osm_url)); changed(); } }, allOn ? icon('check', 12, 2.5) : null)),
        h('th', null, 'Name'), h('th', null, 'Phone'), h('th', null, 'Website'), h('th', null, 'Address'))),
      h('tbody', null, list.map((b) => h('tr', { class: 'no-open' },
        h('td', { class: 'c-pick' }, h('button', { class: 'check', role: 'checkbox', 'aria-checked': view.picked.has(b.osm_url) ? 'true' : 'false', 'aria-label': `Pick ${b.name}`, onClick: () => toggle(b.osm_url) },
          view.picked.has(b.osm_url) ? icon('check', 12, 2.5) : null)),
        h('td', null, h('a', { href: b.osm_url, target: '_blank', rel: 'noopener noreferrer' }, b.name)),
        h('td', null, b.phone || h('span', { class: 'faint' }, '—')),
        h('td', { class: 'ellipsis' }, b.website || h('span', { class: 'faint' }, '—')),
        h('td', { class: 'ellipsis' }, b.address || h('span', { class: 'faint' }, '—'))))))) :
      h('div', { class: 'files-empty' }, 'Nothing mapped here for that category. Try a bigger radius, another category, or Google Maps on your key.'));
}

function importMenu(anchor) {
  const tables = state.boot?.tables || [];
  const label = view.category ? (categories || []).find((c) => c.id === view.category)?.label : view.tag;
  const name = `${label}${view.placeName ? ` near ${view.placeName.split(',')[0]}` : ''}`.slice(0, 80);
  menu(anchor, [
    { label: 'Into a new table', icon: 'plus', onSelect: () => setTimeout(() => newTablePopover(anchor, name)) },
    ...(tables.length ? [{ sep: true }, { group: 'Into an existing table' }] : []),
    ...tables.slice(0, 12).map((t) => ({ label: t.name, icon: 'table', onSelect: () => doImport({ table_id: t.id }) })),
    { sep: true }, { group: 'Into Audiences' },
    { label: 'Companies', icon: 'building', sub: 'matched by domain', onSelect: () => toCompanies('/find/local/to-companies', { search: searchBody(), only: [...view.picked] }) },
  ], { width: 280, align: 'end' });
}

export async function toCompanies(route, body) {
  try {
    const r = await api.post(route, body);
    toast(`Companies: ${r.added.toLocaleString('en-US')} added, ${r.updated.toLocaleString('en-US')} updated.`, { action: 'Open', onAction: () => nav.go('/companies') });
  } catch (e) { toast(e.message, { error: true }); }
}

function newTablePopover(anchor, name) {
  popover(anchor, (el, pop) => {
    const input = h('input', { class: 'input', value: name, 'aria-label': 'Table name' });
    const go = () => { const n = input.value.trim(); if (!n) return; pop.close(); doImport({ new_name: n }); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    el.append(h('div', { class: 'pop-body' }, input, h('button', { class: 'btn primary', onClick: go }, 'Import')));
    setTimeout(() => { input.focus(); input.select(); });
  }, { width: 300, align: 'end' });
}

async function doImport(target) {
  try {
    const r = await api.post('/find/local/import', { search: searchBody(), only: [...view.picked], ...target });
    await refreshTableList();
    toast(`Imported ${r.added.toLocaleString('en-US')} ${r.added === 1 ? 'business' : 'businesses'}${r.skipped_duplicates ? `, ${r.skipped_duplicates} already in the table` : ''}.`);
    nav.go(`/t/${r.table_id}`);
  } catch (e) { toast(e.message, { error: true }); }
}
