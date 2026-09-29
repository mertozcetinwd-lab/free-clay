/**
 * Agents (LOAM-PLAN.md phase 9; Clay's Claygents, teardown-v2 5.2): a list, a template gallery,
 * and a builder in three columns like Clay's: settings on the left, the prompt in the middle,
 * test runs on the right. Test runs are real calls on your key, with the cost shown per step.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, changed, refreshTableList } from '../store.js';
import { nav } from '../nav.js';
import { toast, confirmDialog, modal, menu } from '../ui/overlay.js';
import { fmtMicros } from '../types.js';
import { refs } from '../template.js';
import { AGENT_TEMPLATES } from '../agent-templates.js';

let list = null; let meta = null; let loading = false;
const ed = { id: null, draft: null, saved: null, runs: null, test: {}, running: false, last: null };

async function loadList() {
  loading = true;
  try { [list, meta] = await Promise.all([api.get('/agents'), meta || api.get('/agents/meta')]); }
  catch (e) { toast(e.message, { error: true }); list = list || []; }
  loading = false; changed();
}

async function loadAgent(id) {
  ed.id = id; ed.draft = null; ed.runs = null; ed.last = null; loading = true;
  try {
    const [a, runs, m] = await Promise.all([api.get(`/agents/${id}`), api.get(`/agents/${id}/runs`), meta || api.get('/agents/meta')]);
    meta = m; ed.saved = a; ed.draft = structuredClone(a); ed.runs = runs; ed.test = {};
  } catch (e) { toast(e.message, { error: true }); nav.go('/agents'); }
  loading = false; changed();
}

const crumbs = (regions, extra) => mount(regions.top, h('div', { class: 'crumbs' },
  h('a', { href: '/agents', onClick: (e) => { e.preventDefault(); nav.go('/agents'); } }, 'Agents'),
  extra ? [h('span', { class: 'sep' }, '/'), h('b', null, extra)] : null));

export function renderAgents(regions, id) {
  mount(regions.toolbar);
  if (id) return renderBuilder(regions, id);
  crumbs(regions);
  if (!list && !loading) loadList();
  const items = list || [];
  mount(regions.content, h('div', { class: 'home agents' },
    h('div', { class: 'find-head' },
      h('span', { class: 'files-ic' }, icon('sparkle', 18)), h('h1', null, 'Agents'),
      h('span', { class: 'faint' }, 'Research, score and draft, on your own AI key.'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn primary', onClick: newAgent }, icon('plus', 14), 'New agent')),
    items.length ? h('table', { class: 'files-table', style: { marginTop: '18px' } },
      h('thead', null, h('tr', null, ['Name', 'Model', 'Tools', 'Runs', 'Spent', 'Updated'].map((t, i) => h('th', { class: i >= 3 && i <= 4 ? 'num' : null }, t)))),
      h('tbody', null, items.map((a) => h('tr', { onClick: () => nav.go(`/agents/${a.id}`) },
        h('td', null, h('span', { class: 'fname' }, icon('sparkle', 15), h('span', { class: 'ellipsis' }, a.name))),
        h('td', { class: 'faint' }, `${meta?.providers[a.provider]?.label || a.provider} · ${a.model}`),
        h('td', { class: 'faint' }, [...a.tools.map((t) => meta?.tools[t]?.label || t), ...a.mcp_servers.map((s) => `MCP: ${s.name}`)].join(', ') || '—'),
        h('td', { class: 'num' }, a.runs.toLocaleString('en-US')),
        h('td', { class: 'num' }, fmtMicros(a.spent_micros)),
        h('td', { class: 'faint' }, new Date(a.updated_at).toLocaleDateString()))))) :
      h('div', { class: 'tcards agent-gallery', style: { marginTop: '18px' } }, loading ? h('div', { class: 'files-empty' }, 'Loading…') : AGENT_TEMPLATES.map(templateCard))));
}

function templateCard(t) {
  return h('button', { class: 'tcard', onClick: () => createFrom(t) },
    h('span', { class: 'files-ic' }, icon(t.icon, 16)), h('b', null, t.name), h('span', { class: 'faint' }, t.blurb));
}

function newAgent() {
  modal({ title: 'New agent', width: 760, className: 'agent-new',
    body: (b) => b.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Pick a starting point. Every template runs on Groq’s free tier and only reads public pages; change anything after.'),
      h('div', { class: 'tcards agent-gallery' }, AGENT_TEMPLATES.map(templateCard))) });
}

async function createFrom(t) {
  document.querySelector('.modal-scrim')?.remove();
  try {
    const a = await api.post('/agents', { ...t.agent, template: t.id, prompt: t.agent.prompt || 'Describe what the website {{domain}} is for, in one sentence.' });
    list = null; nav.go(`/agents/${a.id}`);
  } catch (e) { toast(e.message, { error: true }); }
}

/* ---------------------------------------------------------------- builder */

const dirty = () => ed.draft && JSON.stringify(ed.draft) !== JSON.stringify(ed.saved);

async function save() {
  try {
    const a = await api.patch(`/agents/${ed.id}`, ed.draft);
    ed.saved = a; ed.draft = structuredClone(a); list = null; toast('Saved.'); changed();
  } catch (e) { toast(e.message, { error: true }); }
}

async function runTest() {
  if (dirty()) await save();
  if (dirty()) return;
  ed.running = true; ed.last = null; changed();
  try {
    ed.last = await api.post(`/agents/${ed.id}/run`, { input: ed.test });
    ed.runs = await api.get(`/agents/${ed.id}/runs`);
    const b = await api.get('/bootstrap'); state.boot.month_micros = b.month_micros;
  } catch (e) { toast(e.message, { error: true }); }
  ed.running = false; changed();
}

function renderBuilder(regions, id) {
  if (ed.id !== id && !loading) loadAgent(id);
  const d = ed.draft;
  crumbs(regions, d?.name || 'Agent');
  if (!d) return mount(regions.content, h('div', { class: 'files-empty', style: { margin: '32px' } }, 'Loading…'));
  const prov = meta.providers[d.provider];
  const set = (k, v) => { d[k] = v; changed(); };
  const inputs = refs(d.prompt);
  const secretState = (name) => {
    const s = state.boot.secrets.find((x) => x.name === name);
    return s?.set ? 'set' : s ? 'named' : 'missing';
  };
  const keyNote = (name) => {
    if (!name) return null;
    const st = secretState(name);
    return h('div', { class: ['note', st === 'set' ? 'ok' : 'warn'] }, icon('key', 14), st === 'set' ? `Uses your ${name}.` : h('span', null, `Needs ${name}: `, h('code', null, `npx wrangler secret put ${name}`), st === 'named' ? '' : ', then add the name in Settings, Keys.'));
  };

  const left = h('div', { class: 'ag-col ag-left' },
    h('div', { class: 'ag-sect' }, h('div', { class: 'label' }, 'Model'),
      h('select', { class: 'select', 'aria-label': 'Provider', onChange: (e) => { d.provider = e.target.value; d.model = meta.providers[d.provider].default || ''; changed(); } },
        Object.entries(meta.providers).map(([k, p]) => h('option', { value: k, selected: k === d.provider }, p.label))),
      h('input', { class: 'input', value: d.model, placeholder: 'model name', 'aria-label': 'Model', onChange: (e) => set('model', e.target.value.trim()) }),
      d.provider === 'custom' ? [h('input', { class: 'input', value: d.base_url || '', placeholder: 'https://your-endpoint.example.com/v1', 'aria-label': 'Base URL', onChange: (e) => set('base_url', e.target.value.trim()) }),
        h('input', { class: 'input', value: d.key_name || '', placeholder: 'Key name (optional), like MY_MODEL_KEY', 'aria-label': 'Key name', onChange: (e) => set('key_name', e.target.value.trim() || null) })] : null,
      h('div', { class: 'row' }, h('input', { class: 'input', type: 'number', min: '0', step: '0.01', placeholder: '$ in / 1M', value: d.price_in ?? '', 'aria-label': 'Input price', style: { width: '50%' }, onChange: (e) => set('price_in', e.target.value === '' ? undefined : Number(e.target.value)) }),
        h('input', { class: 'input', type: 'number', min: '0', step: '0.01', placeholder: '$ out / 1M', value: d.price_out ?? '', 'aria-label': 'Output price', style: { width: '50%' }, onChange: (e) => set('price_out', e.target.value === '' ? undefined : Number(e.target.value)) })),
      h('div', { class: 'faint' }, prov.free ? 'Free tier: $0 per run.' : 'Price per 1M tokens. Known models fill this in; others need it for the budget.'),
      keyNote(d.provider === 'custom' ? d.key_name : prov.secret)),
    h('div', { class: 'ag-sect' }, h('div', { class: 'label' }, 'Tools'),
      Object.entries(meta.tools).map(([k, t]) => h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: d.tools.includes(k), onChange: (e) => set('tools', e.target.checked ? [...d.tools, k] : d.tools.filter((x) => x !== k)) }),
        h('span', { class: 'grow' }, t.label, t.secret ? h('span', { class: 'faint' }, ` · ${secretState(t.secret) === 'set' ? 'key set' : `needs ${t.secret}`}`) : h('span', { class: 'faint' }, ' · free')))),
    ),
    h('div', { class: 'ag-sect' }, h('div', { class: 'label' }, 'MCP servers'),
      h('div', { class: 'faint' }, 'Give the agent the tools of any MCP server (Streamable HTTP). Up to 3.'),
      d.mcp_servers.map((s, i) => h('div', { class: 'ag-mcp' },
        h('input', { class: 'input', value: s.name, placeholder: 'name', 'aria-label': 'Server name', onChange: (e) => { s.name = e.target.value.trim(); changed(); } }),
        h('input', { class: 'input', value: s.url, placeholder: 'https://…/mcp', 'aria-label': 'Server URL', onChange: (e) => { s.url = e.target.value.trim(); changed(); } }),
        h('input', { class: 'input', value: s.secret || '', placeholder: 'Key name (optional)', 'aria-label': 'Server key name', onChange: (e) => { s.secret = e.target.value.trim() || null; changed(); } }),
        h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove server', onClick: () => { d.mcp_servers.splice(i, 1); changed(); } }, icon('x', 13)))),
      d.mcp_servers.length < 3 ? h('button', { class: 'btn sm', onClick: () => { d.mcp_servers.push({ name: '', url: '', secret: null }); changed(); } }, icon('plus', 13), 'Add MCP server') : null),
    h('div', { class: 'ag-sect' }, h('div', { class: 'label' }, 'Output fields'),
      h('div', { class: 'faint' }, 'Named fields become columns when the agent runs in a table. None = one text answer.'),
      d.fields.map((f, i) => h('div', { class: 'row' },
        h('input', { class: 'input', value: f.name, 'aria-label': 'Field name', onChange: (e) => { f.name = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_'); changed(); } }),
        h('select', { class: 'select', 'aria-label': 'Field type', onChange: (e) => { f.type = e.target.value; changed(); } }, ['text', 'number', 'checkbox', 'url', 'email'].map((t) => h('option', { value: t, selected: f.type === t }, t))),
        h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove field', onClick: () => { d.fields.splice(i, 1); changed(); } }, icon('x', 13)))),
      h('button', { class: 'btn sm', onClick: () => { d.fields.push({ name: `field_${d.fields.length + 1}`, type: 'text' }); changed(); } }, icon('plus', 13), 'Add field')),
    h('div', { class: 'ag-sect' }, h('div', { class: 'label' }, 'Limits'),
      h('div', { class: 'kv' },
        h('span', null, 'Steps per run'), h('input', { class: 'input', type: 'number', min: '1', max: '12', value: d.max_steps, style: { width: '80px' }, onChange: (e) => set('max_steps', Math.round(Number(e.target.value))) }),
        h('span', null, 'Budget per run ($)'), h('input', { class: 'input', type: 'number', min: '0', step: '0.01', value: (d.budget_micros / 1e6).toFixed(2), style: { width: '80px' }, onChange: (e) => set('budget_micros', Math.round(Number(e.target.value) * 1e6)) }),
        h('span', null, 'Use business context'), h('button', { class: 'switch', role: 'switch', 'aria-checked': d.use_context ? 'true' : 'false', 'aria-label': 'Use business context', onClick: () => set('use_context', !d.use_context) }))));

  const mid = h('div', { class: 'ag-col ag-mid' },
    h('div', { class: 'row' }, h('input', { class: 'input ag-name', value: d.name, 'aria-label': 'Agent name', onChange: (e) => set('name', e.target.value) })),
    h('div', { class: 'label' }, 'Prompt'),
    h('div', { class: 'faint' }, 'What to do for one row. Use {{domain}}-style slots for inputs: each slot becomes an input.'),
    h('textarea', { class: 'textarea ag-prompt', 'aria-label': 'Prompt', onInput: (e) => { d.prompt = e.target.value; } , onChange: () => changed() }, d.prompt),
    h('div', { class: 'pills' }, inputs.length ? inputs.map((k) => h('span', { class: 'chip' }, `{{${k}}}`)) : h('span', { class: 'faint' }, 'No inputs yet.')),
    h('div', { class: 'label', style: { marginTop: '12px' } }, 'Instructions (optional)'),
    h('textarea', { class: 'textarea', rows: 4, 'aria-label': 'Instructions', placeholder: 'Who the agent is and how it should work. The business context from Settings is added when switched on.',
      onInput: (e) => { d.instructions = e.target.value; }, onChange: () => changed() }, d.instructions || ''));

  const last = ed.last;
  const right = h('div', { class: 'ag-col ag-right' },
    h('div', { class: 'label' }, 'Test'),
    inputs.map((k) => h('label', { class: 'rp-field' }, h('span', { class: 'rp-label' }, k),
      h('input', { class: 'input', value: ed.test[k] || '', placeholder: k === 'domain' ? 'example.com' : '', onInput: (e) => { ed.test[k] = e.target.value; } }))),
    h('button', { class: 'btn primary', disabled: ed.running, onClick: runTest }, icon(ed.running ? 'clock' : 'play', 14), ed.running ? 'Running…' : 'Run test'),
    h('div', { class: 'faint' }, prov.free ? 'Runs on the free tier.' : `Stops before it would spend more than ${fmtMicros(d.budget_micros)}.`),
    last ? runView(last) : null,
    ed.runs?.length ? [h('div', { class: 'label', style: { marginTop: '16px' } }, 'Recent runs'),
      h('div', { class: 'ag-runs' }, ed.runs.slice(0, 12).map((r) => h('button', { class: 'ag-run', onClick: () => { ed.last = r; changed(); } },
        h('span', { class: 'dot', 'data-c': r.status === 'done' ? 'green' : r.status === 'error' ? 'red' : 'amber' }),
        h('span', { class: 'grow ellipsis' }, Object.values(r.input).filter(Boolean).join(', ') || '(no input)'),
        h('span', { class: 'faint' }, r.source), h('span', { class: 'faint' }, fmtMicros(r.cost_micros)))))] : null);

  mount(regions.top, regions.top.firstChild, h('span', { class: 'grow' }),
    dirty() ? h('span', { class: 'faint' }, 'Unsaved changes') : null,
    h('button', { class: 'btn ghost icon', 'aria-label': 'More', onClick: (e) => menu(e.currentTarget, [
      { label: 'Use in a table', icon: 'table', onSelect: () => useInTable() },
      { label: 'Duplicate', icon: 'copy', onSelect: async () => { const a = await api.post('/agents', { ...d, name: `${d.name} (copy)` }); list = null; nav.go(`/agents/${a.id}`); } },
      { sep: true },
      { label: 'Delete agent', icon: 'trash', danger: true, onSelect: async () => {
        if (!(await confirmDialog({ title: `Delete “${d.name}”?`, text: 'Its runs go too. Table columns that use it will stop working.', confirmLabel: 'Delete', danger: true }))) return;
        await api.del(`/agents/${ed.id}`); list = null; ed.id = null; nav.go('/agents');
      } }], { align: 'end' }) }, icon('more', 16)),
    h('button', { class: 'btn', disabled: !dirty(), onClick: save }, 'Save'));
  mount(regions.content, h('div', { class: 'ag-builder' }, left, mid, right));
}

function runView(r) {
  const out = r.output && Object.keys(r.output).length ? r.output : null;
  return h('div', { class: 'ag-result' },
    h('div', { class: 'row' }, h('span', { class: 'dot', 'data-c': r.status === 'done' ? 'green' : r.status === 'error' ? 'red' : 'amber' }),
      h('b', null, { done: 'Done', error: 'Error', over_budget: 'Stopped: budget', max_steps: 'Stopped: step limit', limit: 'Stopped: request limit' }[r.status] || r.status),
      h('span', { class: 'grow' }), h('span', { class: 'faint' }, `${fmtMicros(r.cost_micros)}${r.ms ? ` · ${(r.ms / 1000).toFixed(1)} s` : ''}`)),
    r.error ? h('div', { class: 'bad' }, r.error) : null,
    out ? h('div', { class: 'ag-out' }, Object.entries(out).map(([k, v]) => h('div', { class: 'rp-field' }, h('span', { class: 'rp-label' }, k), h('div', { class: 'rp-value' }, v === null ? '—' : String(v))))) : null,
    h('details', { class: 'help' }, h('summary', null, `${r.steps.length} steps`),
      h('ol', { class: 'ag-steps' }, r.steps.map((s) => h('li', null, s.kind === 'model'
        ? h('span', null, h('b', null, 'Model'), ` ${s.in} in / ${s.out} out · ${fmtMicros(s.cost)}`, s.calls?.length ? ` · calls ${s.calls.join(', ')}` : '', s.text ? h('div', { class: 'faint' }, s.text) : null)
        : h('span', null, h('b', null, s.name), ` ${JSON.stringify(s.args).slice(0, 120)} · ${s.ms} ms${s.cost ? ` · ${fmtMicros(s.cost)}` : ''}`, h('div', { class: 'faint ag-toolres' }, s.result)))))));
}

/** Add this agent as a column in a table: one run per row, output fields as columns. */
function useInTable() {
  const tables = state.boot?.tables || [];
  if (!tables.length) return toast('Make a table first, then add the agent to it.');
  modal({ title: 'Use this agent in a table', width: 460,
    body: (b) => b.append(h('p', { class: 'muted', style: { marginTop: 0 } }, 'Adds an Agent column. It runs once per row when you press Run, maps each input to a column, and stops each row at the agent’s budget.'),
      h('select', { class: 'select', id: 'ag-table', style: { width: '100%' } }, tables.map((t) => h('option', { value: t.id }, t.name)))),
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: async () => {
        const tid = Number(document.getElementById('ag-table').value);
        try {
          const t = await api.get(`/tables/${tid}`);
          const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
          const inputs = Object.fromEntries(refs(ed.saved.prompt).map((k) => {
            const hit = t.columns.find((c) => norm(c.key) === norm(k) || norm(c.name) === norm(k)) || (k === 'domain' ? t.columns.find((c) => /website|domain|url/i.test(c.name)) : null);
            return [k, hit ? `{{${hit.key}}}` : ''];
          }));
          // Every output field after the first gets its own column; the first fills the agent column.
          const outputs = [];
          for (const f of ed.saved.fields.slice(1)) {
            const c = await api.post(`/tables/${tid}/columns`, { name: f.name.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()), type: f.type });
            outputs.push({ field: f.name, column: c.key });
          }
          await api.post(`/tables/${tid}/columns`, { name: ed.saved.name, kind: 'ai', type: ed.saved.fields[0]?.type || 'text',
            config: { agent_id: ed.id, inputs, outputs, budget_micros: ed.saved.budget_micros } });
          m.close(); await refreshTableList(); nav.go(`/t/${tid}`);
          toast('Agent column added. Check its inputs in the column settings, then press Run.');
        } catch (e) { toast(e.message, { error: true }); }
      } }, 'Add column')) });
}

export function leaveAgents() { list = null; }
