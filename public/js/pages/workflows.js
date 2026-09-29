/**
 * Workflows (LOAM-PLAN.md phase 9; Clay's Workflows beta, teardown-v2 5.3): a list, then a canvas
 * with a Graph | Runs switch like Clay's. The canvas is Drawflow (MIT, public/vendor/drawflow),
 * loaded on first use. Steps are dragged from the palette, joined with arrows and set up in the
 * panel on the right. The server keeps its own graph format (src/workflows.js); this page turns
 * it into Drawflow's and back on every save.
 *
 * Node HTML is a fixed skeleton; titles and summaries are set with textContent, never as HTML,
 * so a step named "<img onerror>" is only text.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, changed } from '../store.js';
import { nav } from '../nav.js';
import { toast, confirmDialog, modal, menu } from '../ui/overlay.js';
import { fmtMicros } from '../types.js';
import { refs } from '../template.js';
import { FIELDS } from '../audience-fields.js';

const NODE_UI = {
  trigger: { icon: 'zap', label: 'Trigger', color: 'amber' },
  function: { icon: 'fx', label: 'Run a function', color: 'blue' },
  agent: { icon: 'sparkle', label: 'Run an agent', color: 'violet' },
  condition: { icon: 'filter', label: 'Condition', color: 'teal' },
  delay: { icon: 'clock', label: 'Delay', color: 'gray' },
  add_row: { icon: 'table', label: 'Add a row to a table', color: 'green' },
  upsert: { icon: 'users', label: 'Save to People or Companies', color: 'green' },
  http: { icon: 'globe', label: 'Call an API', color: 'pink' },
  set: { icon: 'pencil', label: 'Set values', color: 'gray' },
};
const TRIGGER_LABEL = { manual: 'Run by hand', row_added: 'When a row is added', schedule: 'On a schedule', webhook: 'When a webhook is called', signal: 'When a signal fires' };

let list = null; let loading = false; let lib = null;
const ed = { id: null, wf: null, graph: null, dirty: false, tab: 'graph', runs: null, sel: null, editor: null, refs: null, openRun: null };

function loadDrawflow() {
  lib ||= new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: '/vendor/drawflow/drawflow.min.css' }));
    const s = h('script', { src: '/vendor/drawflow/drawflow.min.js', onLoad: () => resolve(window.Drawflow), onError: () => reject(new Error('Could not load the canvas')) });
    document.head.append(s);
  });
  return lib;
}

/** Things a step config may point at: tables, agents, segments, signals, functions. */
async function loadRefs() {
  const [agents, segments, signals, fns] = await Promise.all([api.get('/agents'), api.get('/segments'), api.get('/signals'), api.get('/functions')]);
  ed.refs = { agents, segments, signals, fns: fns.filter((f) => !f.id.startsWith('test_')) };
}

async function loadList() {
  loading = true;
  try { list = await api.get('/workflows'); } catch (e) { toast(e.message, { error: true }); list = list || []; }
  loading = false; changed();
}

async function loadWf(id) {
  ed.id = id; ed.wf = null; loading = true; ed.sel = null; ed.dirty = false; ed.tab = 'graph'; ed.runs = null; ed.openRun = null;
  try {
    const [wf] = await Promise.all([api.get(`/workflows/${id}`), ed.refs ? null : loadRefs()]);
    ed.wf = wf; ed.graph = structuredClone(wf.graph);
  } catch (e) { toast(e.message, { error: true }); nav.go('/workflows'); }
  loading = false; changed();
}

const crumbs = (regions, extra) => [h('a', { href: '/workflows', onClick: (e) => { e.preventDefault(); nav.go('/workflows'); } }, 'Workflows'), extra ? [h('span', { class: 'sep' }, '/'), extra] : null];

export function renderWorkflows(regions, id) {
  mount(regions.toolbar);
  if (id) return renderEditor(regions, id);
  destroyEditor();
  mount(regions.top, h('div', { class: 'crumbs' }, crumbs(regions)));
  if (!list && !loading) loadList();
  const items = list || [];
  const trig = (w) => TRIGGER_LABEL[w.graph.nodes.find((n) => n.type === 'trigger')?.config.type] || '—';
  mount(regions.content, h('div', { class: 'home' },
    h('div', { class: 'find-head' }, h('span', { class: 'files-ic' }, icon('layers', 18)), h('h1', null, 'Workflows'),
      h('span', { class: 'faint' }, 'Automations that run on their own: a trigger, then steps.'), h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onClick: newWorkflow }, icon('plus', 14), 'New workflow')),
    items.length ? h('table', { class: 'files-table', style: { marginTop: '18px' } },
      h('thead', null, h('tr', null, ['Name', 'Status', 'Trigger', 'Steps', 'Runs', 'Errors', 'Spent', 'Last run'].map((t, i) => h('th', { class: i >= 3 && i <= 6 ? 'num' : null }, t)))),
      h('tbody', null, items.map((w) => h('tr', { onClick: () => nav.go(`/workflows/${w.id}`) },
        h('td', null, h('span', { class: 'fname' }, icon('layers', 15), h('span', { class: 'ellipsis' }, w.name))),
        h('td', null, h('span', { class: 'pill' }, h('span', { class: 'dot', style: { '--c': w.status === 'on' ? 'var(--green)' : 'var(--gray)' } }), w.status === 'on' ? 'On' : 'Off')),
        h('td', { class: 'faint' }, trig(w)),
        h('td', { class: 'num' }, w.graph.nodes.length - 1),
        h('td', { class: 'num' }, w.runs.toLocaleString('en-US')),
        h('td', { class: 'num' }, w.errors ? h('span', { class: 'bad' }, w.errors) : '0'),
        h('td', { class: 'num' }, fmtMicros(w.spent_micros)),
        h('td', { class: 'faint' }, w.last_run_at ? new Date(w.last_run_at).toLocaleString() : 'Never'))))) :
      h('div', { class: 'files-empty', style: { marginTop: '18px' } }, loading ? 'Loading…' : 'No workflows yet. A workflow can, for example, check every new row’s website and save the good ones to Companies, or post each new signal to your CRM.')));
}

const STARTERS = [
  { name: 'Blank workflow', blurb: 'A manual trigger and nothing else.', icon: 'layers', graph: null },
  { name: 'Qualify new rows', blurb: 'When a row is added: check the website, and save live sites to Companies.', icon: 'table', needs: 'table',
    graph: (t) => ({ nodes: [
      { id: 'n1', type: 'trigger', config: { type: 'row_added', table_id: t }, x: 40, y: 160 },
      { id: 'n2', type: 'function', config: { fn: 'website_check', inputs: { domain: '{{website}}' }, save_as: 'site' }, x: 330, y: 160 },
      { id: 'n3', type: 'condition', config: { formula: '{{site}} = "live"' }, x: 620, y: 160 },
      { id: 'n4', type: 'upsert', config: { kind: 'companies', values: { name: '{{name}}', website: '{{website}}', phone: '{{phone}}' } }, x: 910, y: 90 },
    ], edges: [{ from: 'n1', to: 'n2', port: 'out' }, { from: 'n2', to: 'n3', port: 'out' }, { from: 'n3', to: 'n4', port: 'true' }] }) },
  { name: 'Inbound lead webhook', blurb: 'A form posts a lead; find its email provider and save it to People.', icon: 'link',
    graph: () => ({ nodes: [
      { id: 'n1', type: 'trigger', config: { type: 'webhook' }, x: 40, y: 160 },
      { id: 'n2', type: 'function', config: { fn: 'email_provider', inputs: { domain: '{{email}}' }, save_as: 'mail' }, x: 330, y: 160 },
      { id: 'n3', type: 'upsert', config: { kind: 'people', values: { full_name: '{{name}}', email: '{{email}}', company: '{{company}}', notes: 'Email on {{mail}}' } }, x: 620, y: 160 },
    ], edges: [{ from: 'n1', to: 'n2', port: 'out' }, { from: 'n2', to: 'n3', port: 'out' }] }) },
  { name: 'Weekly segment research', blurb: 'Every week, run an agent on each company in a segment.', icon: 'calendar',
    graph: () => ({ nodes: [
      { id: 'n1', type: 'trigger', config: { type: 'schedule', every_minutes: 10080, source: 'segment' }, x: 40, y: 160 },
      { id: 'n2', type: 'agent', config: { inputs: { domain: '{{domain}}' }, save_as: 'research' }, x: 330, y: 160 },
    ], edges: [{ from: 'n1', to: 'n2', port: 'out' }] }) },
];

function newWorkflow() {
  modal({ title: 'New workflow', width: 720, className: 'agent-new',
    body: (b) => b.append(h('div', { class: 'tcards agent-gallery' }, STARTERS.map((s) => h('button', { class: 'tcard', onClick: async () => {
      document.querySelector('.modal-scrim')?.remove();
      let graph;
      if (s.graph) {
        const t = s.needs === 'table' ? state.boot?.tables?.[0]?.id : null;
        if (s.needs === 'table' && !t) return toast('Make a table first; this workflow watches one.');
        graph = s.graph(t);
      }
      try { const w = await api.post('/workflows', { name: s.name === 'Blank workflow' ? 'Untitled workflow' : s.name, graph }); list = null; nav.go(`/workflows/${w.id}`); }
      catch (e) { toast(e.message, { error: true }); }
    } }, h('span', { class: 'files-ic' }, icon(s.icon, 16)), h('b', null, s.name), h('span', { class: 'faint' }, s.blurb))))) });
}

/* ---------------------------------------------------------------- graph <-> Drawflow */

const dfId = (id) => Number(id.slice(1));
const outputsOf = (type) => (type === 'condition' ? 2 : 1);

function toDrawflow(graph) {
  const data = {};
  for (const n of graph.nodes) {
    const outs = {};
    for (let i = 1; i <= outputsOf(n.type); i++) outs[`output_${i}`] = { connections: [] };
    data[dfId(n.id)] = { id: dfId(n.id), name: n.type, data: { config: n.config }, class: `wf-node wf-${n.type}`, html: NODE_HTML, typenode: false,
      inputs: n.type === 'trigger' ? {} : { input_1: { connections: [] } }, outputs: outs, pos_x: n.x, pos_y: n.y };
  }
  for (const e of graph.edges) {
    const from = data[dfId(e.from)]; const to = data[dfId(e.to)];
    if (!from || !to || !to.inputs.input_1) continue;
    const out = e.port === 'false' ? 'output_2' : 'output_1';
    from.outputs[out]?.connections.push({ node: String(to.id), output: 'input_1' });
    to.inputs.input_1.connections.push({ node: String(from.id), input: out });
  }
  return { drawflow: { Home: { data } } };
}

function fromDrawflow(exp, prev) {
  const data = exp.drawflow.Home.data;
  const nodes = []; const edges = [];
  for (const d of Object.values(data)) {
    nodes.push({ id: `n${d.id}`, type: d.name, config: d.data?.config || {}, x: Math.round(d.pos_x), y: Math.round(d.pos_y) });
    for (const [out, o] of Object.entries(d.outputs || {})) {
      for (const c of o.connections) edges.push({ from: `n${d.id}`, to: `n${c.node}`, port: d.name === 'condition' ? (out === 'output_2' ? 'false' : 'true') : 'out' });
    }
  }
  return { nodes, edges: edges.filter((e, i) => edges.findIndex((x) => x.from === e.from && x.to === e.to && x.port === e.port) === i) };
}

const NODE_HTML = '<div class="flow-n"><div class="flow-h"><span class="flow-ic"></span><b class="flow-t"></b></div><div class="flow-s"></div></div>';

function summary(n) {
  const c = n.config || {};
  const r = ed.refs || {};
  const t = state.boot?.tables || [];
  const tableName = (id) => t.find((x) => x.id === id)?.name || 'a table';
  switch (n.type) {
    case 'trigger':
      if (c.type === 'row_added') return `New rows in ${tableName(c.table_id)}`;
      if (c.type === 'schedule') return `Every ${every(c.every_minutes)}${c.source === 'table' ? `, each row of ${tableName(c.table_id)}` : c.source === 'segment' ? `, each record of ${r.segments?.find((s) => s.id === c.segment_id)?.name || 'a segment'}` : ''}`;
      if (c.type === 'signal') return `When “${r.signals?.find((s) => s.id === c.signal_id)?.name || 'a signal'}” fires`;
      return TRIGGER_LABEL[c.type] || 'Pick a trigger';
    case 'function': return c.fn ? `${r.fns?.find((f) => f.id === c.fn)?.name || c.fn}${c.save_as ? ` → {{${c.save_as}}}` : ''}` : 'Pick a function';
    case 'agent': return c.agent_id ? `${r.agents?.find((a) => a.id === c.agent_id)?.name || 'Agent'}${c.save_as ? ` → {{${c.save_as}}}` : ''}` : 'Pick an agent';
    case 'condition': return c.formula ? `If ${c.formula}` : 'Write a condition';
    case 'delay': return c.minutes ? `Wait ${every(c.minutes)}` : 'Set the wait';
    case 'add_row': return c.table_id ? `Into ${tableName(c.table_id)}` : 'Pick a table';
    case 'upsert': return c.kind ? `Into ${c.kind === 'people' ? 'People' : 'Companies'}` : 'Pick People or Companies';
    case 'http': return c.url ? `${c.method || 'GET'} ${c.url.replace(/^https:\/\//, '').slice(0, 40)}` : 'Set the URL';
    case 'set': return Object.keys(c.values || {}).join(', ') || 'Add values';
    default: return '';
  }
}

function every(min) {
  if (!min) return '';
  if (min % 10080 === 0) return `${min / 10080} week${min === 10080 ? '' : 's'}`;
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? '' : 's'}`;
  if (min % 60 === 0) return `${min / 60} hour${min === 60 ? '' : 's'}`;
  return `${min} minutes`;
}

function paintNode(id) {
  const node = ed.graph.nodes.find((n) => n.id === `n${id}`);
  const el = document.querySelector(`#node-${id} .flow-n`);
  if (!node || !el) return;
  el.querySelector('.flow-t').textContent = node.type === 'trigger' ? 'Trigger' : NODE_UI[node.type].label;
  el.querySelector('.flow-s').textContent = summary(node);
  mount(el.querySelector('.flow-ic'), icon(NODE_UI[node.type].icon, 14));
  el.dataset.c = NODE_UI[node.type].color;
}

function syncFromEditor() {
  if (!ed.editor) return;
  ed.graph = fromDrawflow(ed.editor.export(), ed.graph);
}

function destroyEditor() { ed.editor = null; }

/* ---------------------------------------------------------------- editor page */

function renderEditor(regions, id) {
  if (ed.id !== id && !loading) loadWf(id);
  const wf = ed.wf;
  mount(regions.top, h('div', { class: 'crumbs' }, crumbs(regions, wf ? h('input', { class: 'crumb-input', value: wf.name, 'aria-label': 'Workflow name', onChange: (e) => { wf.name = e.target.value.trim() || wf.name; ed.dirty = true; changed(); } }) : h('b', null, '…'))),
    wf ? [h('div', { class: 'seg-ctl', style: { marginLeft: '12px' } },
      h('button', { class: ed.tab === 'graph' && 'on', onClick: () => { syncFromEditor(); ed.tab = 'graph'; changed(); } }, 'Graph'),
      h('button', { class: ed.tab === 'runs' && 'on', onClick: () => { syncFromEditor(); ed.tab = 'runs'; loadRuns(); changed(); } }, 'Runs')),
    h('span', { class: 'grow' }),
    ed.dirty ? h('span', { class: 'faint' }, 'Unsaved') : null,
    h('button', { class: 'btn ghost icon', 'aria-label': 'More', onClick: (e) => menu(e.currentTarget, [
      { label: 'Delete workflow', icon: 'trash', danger: true, onSelect: async () => {
        if (!(await confirmDialog({ title: `Delete “${wf.name}”?`, text: 'Its runs and their logs go too.', confirmLabel: 'Delete', danger: true }))) return;
        await api.del(`/workflows/${wf.id}`); list = null; ed.id = null; nav.go('/workflows');
      } }], { align: 'end' }) }, icon('more', 16)),
    h('button', { class: 'btn', disabled: !ed.dirty, onClick: () => save() }, 'Save'),
    h('button', { class: 'btn', onClick: () => testRun() }, icon('play', 14), 'Run'),
    h('button', { class: ['btn', wf.status === 'on' ? 'primary' : ''], title: 'When on, the trigger starts runs by itself', onClick: toggle },
      h('span', { class: 'dot', style: { '--c': wf.status === 'on' ? '#fff' : 'var(--gray)' } }), wf.status === 'on' ? 'On' : 'Off')] : null);
  if (!wf) return mount(regions.content, h('div', { class: 'files-empty', style: { margin: '32px' } }, 'Loading…'));
  if (ed.tab === 'runs') { destroyEditor(); return mount(regions.content, runsView()); }

  // The canvas lives across re-renders: only the side panel is redrawn.
  let shell = regions.content.querySelector('.wf-shell');
  if (!shell || shell.dataset.id !== String(id) || !ed.editor) {
    shell = h('div', { class: 'wf-shell', dataset: { id: String(id) } },
      h('div', { class: 'wf-palette' }, h('div', { class: 'label' }, 'Steps'), Object.entries(NODE_UI).filter(([k]) => k !== 'trigger').map(([k, u]) =>
        h('button', { class: 'wf-pal-item', draggable: 'true', title: `Drag onto the canvas, or click to add`, dataset: { c: u.color },
          onDragstart: (e) => e.dataTransfer.setData('text/plain', k), onClick: () => addNode(k) }, icon(u.icon, 15), u.label)),
        h('div', { class: 'faint wf-help' }, 'Drag a step onto the canvas. Join steps by dragging from a dot on the right to the next step. Click a step to set it up. Select a step and press Delete to remove it.')),
      h('div', { class: 'wf-canvas', id: 'wf-canvas', onDragover: (e) => e.preventDefault(), onDrop: (e) => { e.preventDefault(); const k = e.dataTransfer.getData('text/plain'); if (NODE_UI[k]) addNode(k, e); } }),
      h('div', { class: 'wf-side' }));
    mount(regions.content, shell);
    mountCanvas(shell.querySelector('#wf-canvas'));
  }
  renderSide(shell.querySelector('.wf-side'));
}

async function mountCanvas(el) {
  let Drawflow;
  try { Drawflow = await loadDrawflow(); } catch (e) { return mount(el, h('div', { class: 'bad', style: { padding: '24px' } }, e.message)); }
  const editor = new Drawflow(el);
  editor.reroute = false;
  editor.start();
  editor.import(toDrawflow(ed.graph));
  ed.editor = editor;
  for (const n of ed.graph.nodes) paintNode(dfId(n.id));
  fit(editor, el);
  editor.on('nodeSelected', (id) => { ed.sel = `n${id}`; changed(); });
  editor.on('nodeUnselected', () => { ed.sel = null; changed(); });
  const touched = () => { syncFromEditor(); ed.dirty = true; changed(); };
  editor.on('connectionCreated', (c) => {
    // One arrow into a step from each output, and never back into the trigger.
    const target = ed.graph.nodes.find((n) => n.id === `n${c.input_id}`);
    if (target?.type === 'trigger') { editor.removeSingleConnection(c.output_id, c.input_id, c.output_class, c.input_class); return; }
    touched();
  });
  editor.on('connectionRemoved', touched);
  editor.on('nodeMoved', touched);
  editor.on('nodeRemoved', (id) => {
    const was = ed.graph.nodes.find((n) => n.id === `n${id}`);
    if (was?.type === 'trigger') {
      toast('A workflow needs its trigger. Change it in the panel instead.');
      editor.clear(); editor.import(toDrawflow(ed.graph)); for (const n of ed.graph.nodes) paintNode(dfId(n.id));
      return;
    }
    ed.sel = null; touched();
  });
}

/** Zoom and pan so every step is in view (never zooming in past 100% or out past 50%). */
function fit(editor, el) {
  const ns = ed.graph.nodes;
  if (!ns.length) return;
  const minX = Math.min(...ns.map((n) => n.x)); const maxX = Math.max(...ns.map((n) => n.x)) + 240;
  const minY = Math.min(...ns.map((n) => n.y)); const maxY = Math.max(...ns.map((n) => n.y)) + 90;
  const z = Math.max(0.5, Math.min(1, (el.clientWidth - 60) / (maxX - minX), (el.clientHeight - 60) / (maxY - minY)));
  editor.zoom = z; editor.zoom_last_value = z;
  // Drawflow scales around the canvas centre (no transform-origin is set), so the pan makes up for it.
  const w = editor.precanvas.clientWidth; const hh = editor.precanvas.clientHeight;
  editor.canvas_x = 30 - minX * z - (w / 2) * (1 - z);
  editor.canvas_y = Math.max(30, (el.clientHeight - (maxY - minY) * z) / 3) - minY * z - (hh / 2) * (1 - z);
  editor.precanvas.style.transform = `translate(${editor.canvas_x}px, ${editor.canvas_y}px) scale(${z})`;
}

function addNode(type, ev) {
  if (!ed.editor) return;
  const defaults = { function: { inputs: {} }, agent: { inputs: {} }, condition: { formula: '' }, delay: { minutes: 60 }, add_row: { values: {} }, upsert: { kind: 'companies', values: {} },
    http: { method: 'GET', url: '' }, set: { values: {} } }[type] || {};
  let x = 120 + Math.random() * 60; let y = 120 + Math.random() * 60;
  if (ev) {
    const r = ed.editor.precanvas.getBoundingClientRect();
    const z = ed.editor.zoom || 1;
    x = (ev.clientX - r.left) / z - 90; y = (ev.clientY - r.top) / z - 30;
  } else {
    const last = ed.graph.nodes[ed.graph.nodes.length - 1];
    if (last) { x = last.x + 290; y = last.y; }
  }
  const id = ed.editor.addNode(type, type === 'trigger' ? 0 : 1, outputsOf(type), x, y, `wf-node wf-${type}`, { config: structuredClone(defaults) }, NODE_HTML);
  syncFromEditor(); paintNode(id); ed.sel = `n${id}`; ed.dirty = true; changed();
}

async function save({ quiet = false } = {}) {
  syncFromEditor();
  try {
    const wf = await api.patch(`/workflows/${ed.id}`, { name: ed.wf.name, graph: ed.graph });
    ed.wf = wf; ed.dirty = false; list = null;
    if (!quiet) toast('Saved.');
    changed(); return true;
  } catch (e) { toast(e.message, { error: true }); return false; }
}

async function toggle() {
  if (ed.dirty && !(await save({ quiet: true }))) return;
  try {
    ed.wf = await api.patch(`/workflows/${ed.id}`, { status: ed.wf.status === 'on' ? 'off' : 'on' });
    list = null;
    toast(ed.wf.status === 'on' ? 'On. The trigger now starts runs by itself; the queue drains every minute.' : 'Off. Nothing starts on its own now.');
    changed();
  } catch (e) { toast(e.message, { error: true }); }
}

async function drainAll() {
  for (let i = 0; i < 30; i++) {
    const r = await api.post('/workflows/drain');
    if (!r.remaining || (!r.claimed && r.remaining)) break;
  }
}

function testRun() {
  const trig = ed.graph.nodes.find((n) => n.type === 'trigger')?.config || {};
  const keys = [...new Set(ed.graph.nodes.flatMap((n) => Object.values(n.config.inputs || {}).concat(Object.values(n.config.values || {}), [n.config.formula || '', n.config.url || '', n.config.body || '']).flatMap((t) => refs(t))))];
  const saves = new Set(ed.graph.nodes.map((n) => n.config.save_as).filter(Boolean));
  const sample = Object.fromEntries(keys.filter((k) => !saves.has(k) && ![...saves].some((s) => k.startsWith(`${s}_`))).map((k) => [k, k === 'domain' || k === 'website' ? 'example.com' : k === 'email' ? 'ana@example.com' : k === 'company' || k === 'name' ? 'Example Roofing' : '']));
  const tables = state.boot?.tables || [];
  let mode = trig.type === 'row_added' || (trig.type === 'schedule' && trig.source === 'table') ? 'table' : 'item';
  modal({ title: 'Run this workflow now', width: 520,
    body: (b) => {
      const area = h('textarea', { class: 'textarea mono-ish', id: 'wf-item', rows: 8 }, JSON.stringify(sample, null, 2));
      const tsel = h('select', { class: 'select', id: 'wf-table', style: { width: '100%' } }, tables.map((t) => h('option', { value: t.id, selected: t.id === trig.table_id }, `${t.name} (${t.row_count} rows)`)));
      const draw = () => mount(b,
        h('p', { class: 'muted', style: { marginTop: 0 } }, 'A run by hand works while the workflow is off. Paid steps stop at your budget per run (Settings).'),
        h('div', { class: 'seg-ctl' }, h('button', { class: mode === 'item' && 'on', onClick: () => { mode = 'item'; draw(); } }, 'One test item'),
          h('button', { class: mode === 'table' && 'on', onClick: () => { mode = 'table'; draw(); } }, 'Each row of a table')),
        mode === 'item' ? [h('div', { class: 'label', style: { marginTop: '10px' } }, 'Item (JSON)'), area] : [h('div', { class: 'label', style: { marginTop: '10px' } }, 'Table (first 200 rows)'), tsel]);
      draw();
    },
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: async (e) => {
        if (ed.dirty && !(await save({ quiet: true }))) return;
        let body;
        if (mode === 'item') { try { body = { item: JSON.parse(document.getElementById('wf-item').value || '{}') }; } catch { return toast('The item is not valid JSON.', { error: true }); } }
        else body = { table_id: Number(document.getElementById('wf-table').value) };
        e.currentTarget.disabled = true;
        try {
          const q = await api.post(`/workflows/${ed.id}/run`, body);
          m.close(); toast(`${q.queued} run${q.queued === 1 ? '' : 's'} started.`);
          ed.tab = 'runs'; destroyEditor(); changed();
          await drainAll(); await loadRuns();
        } catch (ex) { e.currentTarget.disabled = false; toast(ex.message, { error: true }); }
      } }, icon('play', 14), 'Run')) });
}

/* ---------------------------------------------------------------- the step panel */

function renderSide(el) {
  const node = ed.graph.nodes.find((n) => n.id === ed.sel);
  if (!node) {
    const trig = ed.graph.nodes.find((n) => n.type === 'trigger');
    return mount(el, h('div', { class: 'wf-side-in' }, h('div', { class: 'label' }, 'Workflow'),
      h('p', { class: 'faint' }, 'Click a step to set it up. Each step can read the item with {{slots}}: the trigger’s fields, plus what earlier steps saved.'),
      h('button', { class: 'btn sm', onClick: () => { ed.sel = trig.id; changed(); } }, icon('zap', 13), 'Set up the trigger'),
      keysHint()));
  }
  const c = node.config;
  const upd = () => { ed.dirty = true; ed.editor?.updateNodeDataFromId(dfId(node.id), { config: c }); paintNode(dfId(node.id)); changed(); };
  const input = (value, onChange, placeholder, label) => h('input', { class: 'input', value: value ?? '', placeholder, 'aria-label': label || placeholder, onChange: (e) => { onChange(e.target.value); upd(); } });
  const sel = (value, options, onChange, label) => h('select', { class: 'select', 'aria-label': label, onChange: (e) => { onChange(e.target.value); upd(); } },
    h('option', { value: '' }, '—'), options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
  const row = (label, control, hint) => h('div', { class: 'form-row' }, h('label', { class: 'label' }, label), control, hint ? h('div', { class: 'hint-text' }, hint) : null);
  const tables = state.boot?.tables || [];
  const r = ed.refs;
  const templates = (obj, keys, hint) => keys.map((k) => row(k, input(obj[k], (v) => { if (v) obj[k] = v; else delete obj[k]; }, '{{column}} or text', k), hint));
  const saveAs = () => row('Save the result as', input(c.save_as, (v) => { c.save_as = v.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_') || undefined; }, 'e.g. site', 'Save as'), 'Later steps read it as {{name}}, and each field as {{name_field}}.');
  let body;
  switch (node.type) {
    case 'trigger': {
      body = [row('Starts when', sel(c.type, Object.entries(TRIGGER_LABEL), (v) => { for (const k of Object.keys(c)) delete c[k]; c.type = v; if (v === 'schedule') { c.every_minutes = 1440; c.source = 'none'; } }, 'Trigger'))];
      if (c.type === 'row_added') body.push(row('Table', sel(c.table_id, tables.map((t) => [t.id, t.name]), (v) => { c.table_id = Number(v) || undefined; }, 'Table'), 'Rows added after you switch the workflow on. Each row is one run.'));
      if (c.type === 'schedule') {
        body.push(row('Every', sel(c.every_minutes, [[15, '15 minutes'], [60, 'hour'], [360, '6 hours'], [1440, 'day'], [10080, 'week'], [43200, '30 days']], (v) => { c.every_minutes = Number(v); }, 'Every')));
        body.push(row('Run on', sel(c.source || 'none', [['none', 'Nothing (one run)'], ['table', 'Each row of a table'], ['segment', 'Each record of a segment']], (v) => { c.source = v; }, 'Source')));
        if (c.source === 'table') body.push(row('Table', sel(c.table_id, tables.map((t) => [t.id, t.name]), (v) => { c.table_id = Number(v) || undefined; }, 'Table')));
        if (c.source === 'segment') body.push(row('Segment', sel(c.segment_id, r.segments.map((s) => [s.id, `${s.name} (${s.kind})`]), (v) => { c.segment_id = Number(v) || undefined; }, 'Segment')));
      }
      if (c.type === 'signal') body.push(row('Signal', sel(c.signal_id, r.signals.map((s) => [s.id, s.name]), (v) => { c.signal_id = Number(v) || undefined; }, 'Signal'), 'Each new event is one run: {{title}}, {{url}}, {{target}}.'));
      if (c.type === 'webhook') body.push(webhookBox());
      if (c.type === 'manual') body.push(h('p', { class: 'faint' }, 'Starts only when you press Run, or from the API and MCP.'));
      break;
    }
    case 'function': {
      const fn = r.fns.find((f) => f.id === c.fn);
      body = [row('Function', sel(c.fn, r.fns.map((f) => [f.id, `${f.name}${f.costMicros ? ` · ${fmtMicros(f.costMicros)}` : ' · free'}`]), (v) => { c.fn = v || undefined; c.inputs = {}; }, 'Function')),
        fn ? templates(c.inputs = c.inputs || {}, fn.inputs.map((i) => i.key), null) : null, fn ? saveAs() : null];
      break;
    }
    case 'agent': {
      const ag = r.agents.find((a) => a.id === c.agent_id);
      body = [row('Agent', sel(c.agent_id, r.agents.map((a) => [a.id, a.name]), (v) => { c.agent_id = Number(v) || undefined; c.inputs = {}; }, 'Agent'), r.agents.length ? null : 'Make an agent on the Agents page first.'),
        ag ? templates(c.inputs = c.inputs || {}, ag.inputs, null) : null, ag ? saveAs() : null];
      break;
    }
    case 'condition':
      body = [row('Continue on “true” when', input(c.formula, (v) => { c.formula = v; }, '{{site}} = "live"', 'Condition'), 'A formula, like in a formula column: =, !=, <, >, AND, OR, ISBLANK(). The top dot is true, the bottom dot false.')];
      break;
    case 'delay':
      body = [row('Wait (minutes)', input(c.minutes, (v) => { c.minutes = Math.round(Number(v)) || 1; }, '60', 'Minutes'), 'Up to 7 days (10,080). The run waits, then carries on.')];
      break;
    case 'add_row': {
      const t = tables.find((x) => x.id === c.table_id);
      body = [row('Table', sel(c.table_id, tables.map((x) => [x.id, x.name]), (v) => { c.table_id = Number(v) || undefined; c.values = {}; loadCols(Number(v)); }, 'Table'))];
      if (t) {
        const cols = colsCache.get(t.id);
        if (!cols) loadCols(t.id);
        body.push(cols ? cols.filter((x) => x.kind === 'data').map((x) => row(x.name, input(c.values?.[x.key], (v) => { c.values = c.values || {}; if (v) c.values[x.key] = v; else delete c.values[x.key]; }, '{{field}} or text', x.name))) : h('div', { class: 'faint' }, 'Loading columns…'));
      }
      break;
    }
    case 'upsert':
      body = [row('Save to', sel(c.kind, [['people', 'People'], ['companies', 'Companies']], (v) => { c.kind = v; c.values = {}; }, 'Kind')),
        c.kind ? FIELDS[c.kind].map(([k, label]) => row(label, input(c.values?.[k], (v) => { c.values = c.values || {}; if (v) c.values[k] = v; else delete c.values[k]; }, '{{field}}', label))) : null,
        h('div', { class: 'faint' }, c.kind === 'people' ? 'Same email = same person. Blanks get filled; existing values stay.' : 'Same domain = same company. Blanks get filled; existing values stay.')];
      break;
    case 'http':
      body = [row('Method', sel(c.method || 'GET', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => [m, m]), (v) => { c.method = v || 'GET'; }, 'Method')),
        row('URL', input(c.url, (v) => { c.url = v.trim(); }, 'https://api.example.com/leads?domain={{domain}}', 'URL'), 'https only. Keys go in as {{secret:NAME}}.'),
        c.method && c.method !== 'GET' ? row('Body', h('textarea', { class: 'textarea mono-ish', rows: 4, onChange: (e) => { c.body = e.target.value; upd(); } }, c.body || '{"email": "{{email}}"}')) : null,
        row('Read from the answer', input(c.path, (v) => { c.path = v.trim() || undefined; }, 'data.id', 'Path'), 'A JSON path. Empty = the whole answer.'),
        saveAs()];
      break;
    case 'set': {
      const vals = c.values = c.values || {};
      body = [Object.entries(vals).map(([k, v]) => h('div', { class: 'field-row' },
        h('input', { class: 'input', value: k, 'aria-label': 'Name', style: { maxWidth: '120px' }, onChange: (e) => { const nk = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_'); delete vals[k]; if (nk) vals[nk] = v; upd(); } }),
        h('input', { class: 'input', value: v, 'aria-label': 'Value', onChange: (e) => { vals[k] = e.target.value; upd(); } }),
        h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove', onClick: () => { delete vals[k]; upd(); } }, icon('x', 13)))),
        h('button', { class: 'btn sm', onClick: () => { vals[`value_${Object.keys(vals).length + 1}`] = ''; upd(); } }, icon('plus', 13), 'Add value')];
      break;
    }
    default: body = null;
  }
  mount(el, h('div', { class: 'wf-side-in' },
    h('div', { class: 'row' }, h('span', { class: 'wf-side-ic', dataset: { c: NODE_UI[node.type].color } }, icon(NODE_UI[node.type].icon, 15)), h('b', { class: 'grow' }, NODE_UI[node.type].label),
      node.type !== 'trigger' ? h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove step', title: 'Remove step', onClick: () => { ed.editor.removeNodeId(`node-${dfId(node.id)}`); } }, icon('trash', 13)) : null,
      h('button', { class: 'btn ghost icon sm', 'aria-label': 'Close', onClick: () => { ed.sel = null; changed(); } }, icon('x', 13))),
    body, keysHint()));
}

const colsCache = new Map();
async function loadCols(id) {
  if (!id || colsCache.has(id)) return;
  try { colsCache.set(id, (await api.get(`/tables/${id}`)).columns); changed(); } catch (e) { toast(e.message, { error: true }); }
}

function keysHint() {
  const trig = ed.graph.nodes.find((n) => n.type === 'trigger')?.config || {};
  const keys = [];
  if (trig.type === 'row_added' || (trig.type === 'schedule' && trig.source === 'table')) {
    const cols = colsCache.get(trig.table_id);
    if (!cols && trig.table_id) loadCols(trig.table_id);
    keys.push(...(cols || []).map((c) => c.key), 'row_id');
  }
  if (trig.type === 'schedule' && trig.source === 'segment') {
    const s = ed.refs.segments.find((x) => x.id === trig.segment_id);
    if (s) keys.push(...FIELDS[s.kind].map((f) => f[0]), 'record_id');
  }
  if (trig.type === 'signal') keys.push('title', 'url', 'target', 'signal');
  for (const n of ed.graph.nodes) if (n.config.save_as) keys.push(n.config.save_as);
  for (const n of ed.graph.nodes) if (n.type === 'set') keys.push(...Object.keys(n.config.values || {}));
  if (!keys.length) return null;
  return h('div', { class: 'wf-keys' }, h('div', { class: 'label' }, 'Slots you can use'), h('div', { class: 'pills', style: { flexWrap: 'wrap' } }, [...new Set(keys)].map((k) => h('span', { class: 'chip' }, `{{${k}}}`))));
}

function webhookBox() {
  const box = h('div', { class: 'stack' });
  const show = async (rotate) => {
    if (ed.dirty && !(await save({ quiet: true }))) return;
    try {
      const { url } = await api.post(`/workflows/${ed.id}/webhook`, { rotate });
      mount(box, h('div', { class: 'label' }, 'POST JSON to this URL'), h('pre', { class: 'code', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, url),
        h('div', { class: 'row' }, h('button', { class: 'btn sm', onClick: () => navigator.clipboard.writeText(url).then(() => toast('Copied.')) }, icon('copy', 13), 'Copy'),
          h('button', { class: 'btn ghost sm', onClick: () => show(true) }, 'Make a new URL')),
        h('div', { class: 'faint' }, 'Anyone with the URL can start runs, so treat it like a password. Each top-level field becomes a {{slot}}. The workflow must be on.'));
    } catch (e) { toast(e.message, { error: true }); }
  };
  mount(box, h('button', { class: 'btn sm', onClick: () => show(false) }, icon('link', 13), 'Show the webhook URL'));
  return box;
}

/* ---------------------------------------------------------------- runs */

async function loadRuns() {
  try { ed.runs = await api.get(`/workflows/${ed.id}/runs`); } catch (e) { toast(e.message, { error: true }); }
  changed();
}

function runsView() {
  if (!ed.runs) { loadRuns(); return h('div', { class: 'files-empty', style: { margin: '32px' } }, 'Loading…'); }
  const runs = ed.runs;
  const open = runs.find((r) => r.id === ed.openRun);
  const label = { done: 'Done', error: 'Error', waiting: 'Waiting', queued: 'Queued', running: 'Running', over_budget: 'Stopped: budget' };
  const color = { done: 'green', error: 'red', over_budget: 'amber' };
  const byId = new Map(ed.graph.nodes.map((n) => [n.id, n]));
  return h('div', { class: 'home' },
    h('div', { class: 'files-head' }, h('span', { class: 'files-ic' }, icon('list', 18)), h('h2', null, 'Runs'), h('span', { class: 'grow' }),
      h('button', { class: 'btn sm', onClick: async () => { await drainAll(); loadRuns(); } }, icon('refresh', 13), 'Refresh')),
    runs.length ? h('div', { class: 'wf-runs' },
      h('table', { class: 'files-table' }, h('thead', null, h('tr', null, ['Run', 'Status', 'Started by', 'Steps', 'Cost', 'When'].map((t, i) => h('th', { class: i === 3 || i === 4 ? 'num' : null }, t)))),
        h('tbody', null, runs.map((r) => h('tr', { class: r.id === ed.openRun && 'selected', onClick: () => { ed.openRun = r.id; changed(); } },
          h('td', null, `#${r.id}`),
          h('td', null, h('span', { class: 'pill' }, h('span', { class: 'dot', style: { '--c': `var(--${color[r.status] || 'gray'})` } }), label[r.status] || r.status)),
          h('td', { class: 'faint' }, r.trigger || ''),
          h('td', { class: 'num' }, r.log.length),
          h('td', { class: 'num' }, fmtMicros(r.cost_micros)),
          h('td', { class: 'faint' }, new Date(r.created_at).toLocaleString()))))),
      open ? h('div', { class: 'wf-run-detail' },
        h('b', null, `Run #${open.id}`),
        open.error ? h('div', { class: 'bad' }, open.error) : null,
        open.resume_at && open.status === 'waiting' ? h('div', { class: 'faint' }, `Carries on after ${new Date(open.resume_at).toLocaleString()}`) : null,
        h('ol', { class: 'ag-steps' }, open.log.map((l) => h('li', null, h('b', null, NODE_UI[byId.get(l.node)?.type || l.type]?.label || l.type), l.ok ? '' : h('span', { class: 'bad' }, ' failed'),
          ` · ${l.ms} ms${l.cost ? ` · ${fmtMicros(l.cost)}` : ''}`, l.note ? h('div', { class: 'faint' }, l.note) : null))),
        h('details', { class: 'help', open: true }, h('summary', null, 'Item'), h('pre', { class: 'code', style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(open.item, null, 2)))) : null)
      : h('div', { class: 'files-empty' }, 'No runs yet. Press Run to try it on a test item or a table’s rows.'));
}

export function leaveWorkflows() { list = null; destroyEditor(); }
