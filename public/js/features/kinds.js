/**
 * Side-panel editors for the Formula, AI and HTTP API columns, and the Google Places source.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadTable, refreshTableList, setting } from '../store.js';
import { KIND_UI, field } from '../ui/column-panel.js';
import { templateInput } from '../ui/template-input.js';
import { toast, popover } from '../ui/overlay.js';
import { fmtMicros, displayText } from '../types.js';
import { checkFormula, computeRow, FUNCTION_NAMES } from '../formula.js';
import { fill } from '../template.js';
import { PROVIDERS, priceOf, worstCaseMicros } from '../ai-models.js';
import { runOptions } from './enrich.js';
import { pricing } from './run.js';
import { tableHooks } from '../pages/table.js';

const secretNote = (name) => {
  const s = state.boot.secrets.find((x) => x.name === name);
  return h('div', { class: ['note', s?.set ? 'ok' : 'warn'] }, icon('key', 14),
    s?.set ? `Uses your ${name}.` : `Needs ${name}. Run: npx wrangler secret put ${name}, then add the name in Settings, Keys.`);
};

const select = (value, options, onChange, label) => h('select', { class: 'select', 'aria-label': label, onChange: (e) => onChange(e.target.value) },
  options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

/* ---------------------------------------------------------------- formula */

KIND_UI.formula = {
  label: 'Formula', icon: 'fx', blurb: 'Compute from other columns. Free.', pickType: true,
  defaults: () => ({ type: 'text', config: { formula: '' } }),
  check: (d) => checkFormula(d.config.formula),
  render(el, draft, ctx) {
    const preview = h('div', { class: 'preview' });
    const showPreview = () => {
      const err = draft.config.formula ? checkFormula(draft.config.formula) : 'Type a formula';
      if (err) return mount(preview, h('div', { class: ['faint', draft.config.formula && 'bad'] }, err));
      const cols = [...ctx.columns, { key: '__f', kind: 'formula', config: { formula: draft.config.formula } }];
      mount(preview, h('div', { class: 'label' }, 'First rows'), state.t.rows.slice(0, 3).map((r) => {
        const out = computeRow(r, cols);
        const e = out._errors?.__f;
        return h('div', { class: 'prev-row' }, e ? h('span', { class: 'bad' }, `#ERROR ${e}`) : displayText(draft.type, out.__f) || h('span', { class: 'faint' }, '(empty)'));
      }));
    };
    const ask = h('input', { class: 'input', placeholder: 'Describe it: the domain of the website, in capitals', 'aria-label': 'Describe the formula',
      onKeydown: (e) => { if (e.key === 'Enter') write(); } });
    const write = async () => {
      if (!ask.value.trim()) return ask.focus();
      try {
        const r = await api.post('/assist/formula', { prompt: ask.value, columns: ctx.columns.filter((c) => c.kind !== 'formula' || c.key !== draft.key).map((c) => ({ key: c.key, name: c.name, type: c.type })) });
        draft.config.formula = r.formula; ctx.refresh();
      } catch (e) { toast(e.message, { error: true }); }
    };
    mount(el,
      h('div', { class: 'field-row' }, ask, h('button', { class: 'btn', onClick: write, title: 'Writes the formula on Groq\u2019s free tier. Check it before saving.' }, icon('sparkle', 14), 'Write it')),
      field('Formula', templateInput({ value: draft.config.formula, columns: ctx.columns, multiline: true, label: 'Formula',
        placeholder: 'IF(ISBLANK({{email}}), "missing", DOMAIN({{email}}))', onChange: (v) => { draft.config.formula = v; showPreview(); } })),
      preview,
      h('details', { class: 'help' }, h('summary', null, 'Functions'), h('div', { class: 'faint mono' }, FUNCTION_NAMES.join(', ')),
        h('div', { class: 'faint' }, 'Operators: + - * / %, & joins text, = != < <= > >=, AND, OR, NOT. Strings in "quotes".')));
    showPreview();
  },
};

/* ---------------------------------------------------------------- AI */

/** Average prompt size over up to 50 rows, in tokens (~4 characters each), stored for the budget. */
function measurePrompt(cfg, columns) {
  const rows = state.t.rows.slice(0, 50);
  if (!rows.length) return undefined;
  const avg = rows.reduce((a, r) => a + fill(cfg.prompt || '', computeRow(r, columns)).length + (cfg.system || '').length, 0) / rows.length;
  return Math.ceil(avg / 4) + 60 + (cfg.fields?.length ? 40 : 0);
}

pricing.ai = (col) => (col.config.agent_id ? col.config.budget_micros ?? 100_000 : worstCaseMicros(col.config));

/* ---------------------------------------------------------------- Agent column (an AI column with agent_id) */

let agentList = null;
const loadAgents = () => (agentList ||= api.get('/agents').catch((e) => { agentList = null; throw e; }));

function renderAgentColumn(el, draft, ctx) {
  const cfg = draft.config;
  cfg.inputs = cfg.inputs || {};
  mount(el, h('div', { class: 'faint' }, 'Loading agents…'));
  loadAgents().then((list) => {
    const agent = list.find((a) => a.id === cfg.agent_id);
    const pick = select(String(cfg.agent_id), list.map((a) => [String(a.id), a.name]), (v) => { cfg.agent_id = Number(v); cfg.inputs = {}; ctx.refresh(); }, 'Agent');
    mount(el,
      field('Agent', pick, agent ? `${agent.provider} · ${agent.model} · up to ${agent.max_steps} steps` : 'That agent was deleted. Pick another.'),
      agent ? [h('div', { class: 'sect-h' }, 'Inputs'),
        agent.inputs.map((k) => field(k, templateInput({ value: cfg.inputs[k] || '', columns: ctx.columns, label: k, placeholder: `{{column}} for ${k}`, onChange: (v) => { cfg.inputs[k] = v; } }))),
        field('Budget per row ($)', h('input', { class: 'input', type: 'number', min: '0', step: '0.01', value: ((cfg.budget_micros ?? agent.budget_micros) / 1e6).toFixed(2),
          onChange: (e) => { cfg.budget_micros = Math.max(0, Math.round(Number(e.target.value) * 1e6)); ctx.redrawFoot(); } }), 'A row stops before it would spend more than this. The agent’s own budget also applies.'),
        h('a', { class: 'btn sm', href: `/agents/${agent.id}`, target: '_blank' }, icon('sparkle', 13), 'Open the agent')] : null,
      runOptions(cfg, ctx));
  }).catch((e) => mount(el, h('div', { class: 'bad' }, e.message)));
}
pricing.http = (col) => col.config.cost_micros || 0;

KIND_UI.ai = {
  label: 'AI', icon: 'sparkle', blurb: 'A prompt per row, on your key.',
  defaults: () => ({ type: 'text', config: { provider: 'groq', model: PROVIDERS.groq.default, effort: 'low', prompt: '', system: '', fields: [], outputs: [], max_tokens: 800, condition: '', auto: false } }),
  check: (d) => (d.config.agent_id ? null : !d.config.prompt.trim() ? 'Write a prompt' : !priceOf(d.config) ? 'Enter this model’s price, so the budget cap works' : null),
  render(el, draft, ctx) {
    const cfg = draft.config;
    if (cfg.agent_id) return renderAgentColumn(el, draft, ctx);
    const prov = PROVIDERS[cfg.provider];
    const redraw = () => { cfg.est_input_tokens = measurePrompt(cfg, state.t.columns); ctx.refresh(); };
    const modelCtl = prov.models.length
      ? select(cfg.model, [...prov.models.map((m) => [m, m]), ...(prov.models.includes(cfg.model) ? [] : [[cfg.model, cfg.model]])], (v) => { cfg.model = v; redraw(); }, 'Model')
      : h('input', { class: 'input', value: cfg.model, placeholder: 'model name', 'aria-label': 'Model', onChange: (e) => { cfg.model = e.target.value.trim(); redraw(); } });
    const p = priceOf(cfg);
    mount(el,
      h('div', { class: 'grid2' },
        field('Provider', select(cfg.provider, Object.entries(PROVIDERS).map(([k, v]) => [k, v.label]), (v) => { cfg.provider = v; cfg.model = PROVIDERS[v].default; redraw(); }, 'Provider')),
        field('Model', modelCtl)),
      secretNote(prov.secret),
      p ? h('div', { class: 'faint' }, p[0] || p[1] ? `$${p[0]} in / $${p[1]} out per 1M tokens${priceOf({ provider: cfg.provider }, cfg.model) ? ' (list price)' : ' (your price)'}` : 'Free tier: $0 per call')
        : h('div', { class: 'grid2' },
          field('Input $ per 1M tokens', h('input', { class: 'input', type: 'number', min: '0', step: '0.01', value: cfg.price_in ?? '', onChange: (e) => { cfg.price_in = e.target.value === '' ? undefined : Number(e.target.value); redraw(); } })),
          field('Output $ per 1M tokens', h('input', { class: 'input', type: 'number', min: '0', step: '0.01', value: cfg.price_out ?? '', onChange: (e) => { cfg.price_out = e.target.value === '' ? undefined : Number(e.target.value); redraw(); } }))),
      field('Prompt', templateInput({ value: cfg.prompt, columns: ctx.columns, multiline: true, label: 'Prompt',
        placeholder: 'Using {{site_text}}, what does {{company}} sell? One short phrase.', onChange: (v) => { cfg.prompt = v; cfg.est_input_tokens = measurePrompt(cfg, state.t.columns); ctx.redrawFoot(); } })),
      h('div', { class: 'sect-h' }, 'Answer'),
      fieldsEditor(cfg, draft, ctx),
      h('details', { class: 'help' }, h('summary', null, 'More settings'),
        h('div', { class: 'stack', style: { marginTop: '8px' } },
          field('System instructions (optional)', h('textarea', { class: 'textarea', value: cfg.system || '', style: { minHeight: '60px' }, onChange: (e) => { cfg.system = e.target.value; redraw(); } })),
          h('div', { class: 'grid2' },
            field('Max tokens', h('input', { class: 'input', type: 'number', min: '16', max: '16000', value: cfg.max_tokens || 1024, onChange: (e) => { cfg.max_tokens = Math.max(16, Math.min(16000, Math.round(Number(e.target.value)) || 1024)); redraw(); } }),
              'The cap on each answer. The budget assumes every row uses all of it.'),
            cfg.provider === 'anthropic' && !/haiku/.test(cfg.model) ? field('Effort', select(cfg.effort || 'low', [['low', 'Low (cheapest)'], ['medium', 'Medium'], ['high', 'High']], (v) => { cfg.effort = v; }, 'Effort'), 'How hard it thinks. Low suits sorting and extracting.') : h('div')))),
      runOptions(cfg, ctx));
    cfg.est_input_tokens = measurePrompt(cfg, state.t.columns);
  },
  async afterSave(col, draft) {
    if (col.config.agent_id) return loadTable(state.t.table.id);
    try { for (const f of draft.wantOutputs || []) await api.post(`/columns/${col.id}/outputs`, { field: f, type: (col.config.fields || []).find((x) => x.name === f)?.type }); }
    catch (e) { toast(e.message, { error: true }); }
    await loadTable(state.t.table.id);
  },
  footer: (draft) => {
    const w = draft.config.agent_id ? draft.config.budget_micros ?? 100_000 : worstCaseMicros(draft.config);
    const n = state.t.rows.length;
    return h('span', { class: 'faint' }, w ? `Up to ~${fmtMicros(w)} a row, ${fmtMicros(w * n)} for ${n} rows` : `Free for all ${n} rows`);
  },
};

/** Named answer fields. None = one plain-text answer. The first field fills this column. */
function fieldsEditor(cfg, draft, ctx) {
  const fields = cfg.fields;
  draft.wantOutputs = draft.wantOutputs || [];
  const mapped = new Set((cfg.outputs || []).map((o) => o.field));
  const types = [['text', 'Text'], ['number', 'Number'], ['checkbox', 'Yes / no'], ['url', 'URL'], ['email', 'Email']];
  return h('div', { class: 'stack' },
    fields.length ? null : h('div', { class: 'faint' }, 'One plain-text answer. Add fields to get several answers in their own columns.'),
    fields.map((f, i) => h('div', { class: 'field-row' },
      h('input', { class: 'input', value: f.name, 'aria-label': 'Field name', placeholder: 'field_name',
        onChange: (e) => { f.name = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '') || 'field'; if (i === 0) draft.type = f.type; ctx.refresh(); } }),
      select(f.type, types, (v) => { f.type = v; if (i === 0) draft.type = v; }, 'Field type'),
      i === 0 ? h('span', { class: 'faint', style: { whiteSpace: 'nowrap' } }, 'this column')
        : h('label', { class: 'check-row', title: 'Give this field its own column' },
          h('button', { type: 'button', class: 'check', role: 'checkbox', disabled: mapped.has(f.name), 'aria-checked': mapped.has(f.name) || draft.wantOutputs.includes(f.name) ? 'true' : 'false',
            onClick: () => { const w = draft.wantOutputs; w.includes(f.name) ? w.splice(w.indexOf(f.name), 1) : w.push(f.name); ctx.refresh(); } },
          mapped.has(f.name) || draft.wantOutputs.includes(f.name) ? icon('check', 12, 2.5) : null), h('span', { class: 'faint' }, 'column')),
      h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove field', onClick: () => { fields.splice(i, 1); ctx.refresh(); } }, icon('x', 13)))),
    h('div', null, h('button', { class: 'btn sm', onClick: () => {
      fields.push({ name: `field_${fields.length + 1}`, type: 'text' });
      if (fields.length === 1) draft.type = 'text';
      ctx.refresh();
    } }, icon('plus', 13), 'Add answer field')));
}

/* ---------------------------------------------------------------- HTTP API */

KIND_UI.http = {
  label: 'HTTP API', icon: 'code', blurb: 'Call any API per row.', pickType: true,
  defaults: () => ({ type: 'text', config: { method: 'GET', url: 'https://', headers: [], body: '', path: '', outputs: [], cost_micros: 0, condition: '', auto: false } }),
  check: (d) => (!/^https:\/\/[^\s/{}@]+/i.test(d.config.url) ? 'The URL must start with https:// and a fixed host' : null),
  render(el, draft, ctx) {
    const cfg = draft.config;
    draft.newOutputs = draft.newOutputs || [];
    const secretsHint = (state.boot.secrets || []).map((s) => `{{secret:${s.name}}}`).join('  ');
    mount(el,
      h('div', { class: 'grid2 http-line' },
        select(cfg.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => [m, m]), (v) => { cfg.method = v; ctx.refresh(); }, 'Method'),
        templateInput({ value: cfg.url, columns: ctx.columns, label: 'URL', placeholder: 'https://api.example.com/v1/lookup?domain={{domain}}', onChange: (v) => { cfg.url = v; } })),
      h('div', { class: 'faint' }, 'Keys: write {{secret:NAME}} for a key you listed in Settings, Keys. ', secretsHint ? h('span', { class: 'mono' }, secretsHint) : 'None listed yet.'),
      h('div', { class: 'sect-h' }, 'Headers'),
      cfg.headers.map((hd, i) => h('div', { class: 'field-row' },
        h('input', { class: 'input', value: hd.name, placeholder: 'Authorization', 'aria-label': 'Header name', onChange: (e) => { hd.name = e.target.value.trim(); } }),
        templateInput({ value: hd.value, columns: ctx.columns, label: 'Header value', placeholder: 'Bearer {{secret:MY_KEY}}', onChange: (v) => { hd.value = v; } }),
        h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove header', onClick: () => { cfg.headers.splice(i, 1); ctx.refresh(); } }, icon('x', 13)))),
      h('div', null, h('button', { class: 'btn sm', onClick: () => { cfg.headers.push({ name: '', value: '' }); ctx.refresh(); } }, icon('plus', 13), 'Add header')),
      cfg.method !== 'GET' ? field('Body', templateInput({ value: cfg.body, columns: ctx.columns, multiline: true, label: 'Body', placeholder: '{"company": "{{company}}"}', onChange: (v) => { cfg.body = v; } }),
        'Column values are escaped for JSON automatically.') : null,
      h('div', { class: 'sect-h' }, 'Response'),
      field('Value for this column (JSON path)', h('input', { class: 'input mono-ish', value: cfg.path, placeholder: 'data.email  (empty = whole response)', onChange: (e) => { cfg.path = e.target.value.trim(); } })),
      field('More columns from the response', h('div', { class: 'stack' },
        (cfg.outputs || []).map((o) => h('div', { class: 'faint mono' }, `${o.field} → ${state.t.columns.find((c) => c.key === o.column)?.name || o.column}`)),
        draft.newOutputs.map((o, i) => h('div', { class: 'field-row' },
          h('input', { class: 'input', value: o.field, placeholder: 'data.phone', 'aria-label': 'JSON path', onChange: (e) => { o.field = e.target.value.trim(); } }),
          h('input', { class: 'input', value: o.name, placeholder: 'Column name', 'aria-label': 'Column name', onChange: (e) => { o.name = e.target.value.trim(); } }),
          h('button', { class: 'btn ghost icon sm', 'aria-label': 'Remove', onClick: () => { draft.newOutputs.splice(i, 1); ctx.refresh(); } }, icon('x', 13)))),
        h('div', null, h('button', { class: 'btn sm', onClick: () => { draft.newOutputs.push({ field: '', name: '' }); ctx.refresh(); } }, icon('plus', 13), 'Add output')))),
      field('Your cost per call ($)', h('input', { class: 'input', type: 'number', min: '0', step: '0.0001', style: { width: '140px' }, value: ((cfg.cost_micros || 0) / 1e6).toString(),
        onChange: (e) => { cfg.cost_micros = Math.max(0, Math.round(Number(e.target.value) * 1e6) || 0); ctx.redrawFoot(); } }), 'What the API charges you, so budgets and the spend page stay honest.'),
      runOptions(cfg, ctx));
  },
  async afterSave(col, draft) {
    try { for (const o of (draft.newOutputs || []).filter((x) => x.field)) await api.post(`/columns/${col.id}/outputs`, { field: o.field, name: o.name || o.field }); }
    catch (e) { toast(e.message, { error: true }); }
    await loadTable(state.t.table.id);
  },
  footer: (draft) => h('span', { class: 'faint' }, draft.config.cost_micros ? `${fmtMicros(draft.config.cost_micros)} a call, ${fmtMicros(draft.config.cost_micros * state.t.rows.length)} for ${state.t.rows.length} rows` : 'No cost entered'),
};

/* ---------------------------------------------------------------- Google Places source */

function findPlaces(anchor) {
  const PER = (setting('cost_overrides', {}) || {}).places_lookup ?? 35_000;
  popover(anchor, (el, pop) => {
    const q = h('input', { class: 'input', placeholder: 'roofers in Gainesville FL', 'aria-label': 'Search Google Maps' });
    const pages = select('1', [['1', 'Up to 20 places'], ['2', 'Up to 40 places'], ['3', 'Up to 60 places']], () => est(), 'How many');
    const cost = h('div', { class: 'faint' });
    const est = () => { cost.textContent = `Up to ${fmtMicros(PER * Number(pages.value))}: one Google request per 20 places. 1,000 requests a month are free (Google's pricing, read 2026-09-15).`; };
    const go = async () => {
      if (!q.value.trim()) return q.focus();
      const btn = el.querySelector('.btn.primary'); btn.disabled = true;
      try {
        const r = await api.post(`/tables/${state.t.table.id}/source/places`, { query: q.value, pages: Number(pages.value), budget_micros: Math.max(setting('default_budget_micros', 1_000_000), PER * Number(pages.value)) });
        pop.close();
        toast(`Added ${r.added} places` + (r.skipped_duplicates ? `, ${r.skipped_duplicates} already in the table` : '') + ` (${fmtMicros(r.cost_micros)})`);
        await loadTable(state.t.table.id); refreshTableList();
      } catch (e) { toast(e.message, { error: true }); btn.disabled = false; }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    est();
    el.append(h('div', { class: 'pop-body' }, h('b', null, 'Find businesses on Google Maps'), secretNote('GOOGLE_MAPS_API_KEY'), q, pages, cost),
      h('div', { class: 'pop-foot' }, h('button', { class: 'btn', onClick: () => pop.close() }, 'Cancel'), h('button', { class: 'btn primary', onClick: go }, icon('search', 13), 'Find')));
    setTimeout(() => q.focus());
  }, { width: 340, align: 'end' });
}

tableHooks.addRows.push((anchor) => ({ label: 'Find businesses on Google Maps', icon: 'pin', onSelect: () => findPlaces(anchor) }));


