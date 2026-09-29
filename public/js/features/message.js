/**
 * Message column panel (Clay's "Message"): subject, body, snippets and a preview of the first rows.
 * The syntax and the renderer are shared with the Worker (public/js/message.js), so the preview is
 * what a run writes, except AI snippets, which show as «AI: name» until you run or try them.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadTable } from '../store.js';
import { KIND_UI, field } from '../ui/column-panel.js';
import { templateInput } from '../ui/template-input.js';
import { toast } from '../ui/overlay.js';
import { fmtMicros } from '../types.js';
import { computeRow } from '../formula.js';
import { refs } from '../template.js';
import { render, messageRefs } from '../message.js';
import { PROVIDERS, priceOf, worstCaseMicros } from '../ai-models.js';
import { runOptions } from './enrich.js';
import { pricing } from './run.js';
import { tryButton } from './try.js';

const snippetModel = (s) => ({ provider: s.provider, model: s.model, max_tokens: s.max_tokens || 200, price_in: s.price_in, price_out: s.price_out, prompt: s.prompt });
const usedSnippets = (cfg) => messageRefs(`${cfg.subject || ''}\n${cfg.body || ''}`).snippets
  .map((n) => (cfg.snippets || []).find((s) => s.name === n)).filter(Boolean);
const worstCase = (cfg) => usedSnippets(cfg).filter((s) => s.kind === 'ai').reduce((a, s) => a + worstCaseMicros(snippetModel(s)), 0);
pricing.message = (col) => worstCase(col.config);

const nextName = (cfg, base) => { let i = 1; while ((cfg.snippets || []).some((s) => s.name === `${base}${i === 1 ? '' : i}`)) i++; return `${base}${i === 1 ? '' : i}`; };

KIND_UI.message = {
  label: 'Message', icon: 'mail', blurb: 'An email per row: columns, spintax, snippets.',
  defaults: () => ({ type: 'text', config: { subject: '', body: '', snippets: [], outputs: [], condition: '', auto: false } }),
  check: (d) => {
    const cfg = d.config;
    if (!String(cfg.body || '').trim()) return 'Write the message body';
    for (const n of messageRefs(`${cfg.subject || ''}\n${cfg.body || ''}`).snippets) if (!(cfg.snippets || []).some((s) => s.name === n)) return `The message uses {{snippet:${n}}}, which is not in the snippet list`;
    for (const s of cfg.snippets || []) {
      if (s.kind === 'ai' && !refs(s.prompt || '').length) return `Snippet ${s.name}: put a column in its prompt`;
      if (s.kind === 'ai' && !priceOf(snippetModel(s))) return `Snippet ${s.name}: enter its model's price`;
      if (s.kind === 'if' && !String(s.condition || '').trim()) return `Snippet ${s.name}: write its condition`;
    }
    return null;
  },
  render(el, draft, ctx) {
    const cfg = draft.config;
    cfg.snippets = cfg.snippets || [];
    const preview = h('div', { class: 'preview' });
    const showPreview = () => {
      const rows = state.t.rows.slice(0, 3);
      if (!rows.length) return mount(preview, h('div', { class: 'faint' }, 'Add a row to see a preview.'));
      mount(preview, h('div', { class: 'label' }, draft.key ? 'Preview, first rows' : 'Preview, first rows (spintax choices settle when saved; Try on 5 rows shows them exactly)'), rows.map((r) => {
        const data = computeRow(r, state.t.columns);
        const values = {};
        for (const s of usedSnippets(cfg)) {
          if (s.kind === 'ai') { values[s.name] = `«AI: ${s.name}»`; continue; }
          const test = computeRow({ ...r, data }, [...state.t.columns, { key: '__c', kind: 'formula', config: { formula: s.condition || 'FALSE' } }]);
          values[s.name] = render(test.__c === true ? s.then || '' : s.else || '', data, {}, `${r.id}:${s.name}`);
        }
        const subject = render(cfg.subject || '', data, values, `${r.id}:${draft.key || ''}:subject`);
        const body = render(cfg.body || '', data, values, `${r.id}:${draft.key || ''}:body`);
        return h('div', { class: 'msg-prev' }, subject ? h('b', null, subject) : null, h('div', { class: 'msg-body' }, body || h('span', { class: 'faint' }, '(empty)')));
      }));
    };
    const snippetsEl = h('div', { class: 'stack' });
    const drawSnippets = () => mount(snippetsEl,
      cfg.snippets.map((s, i) => snippetCard(s, i)),
      h('div', { class: 'field-row' },
        h('button', { class: 'btn sm', type: 'button', onClick: () => { cfg.snippets.push({ name: nextName(cfg, 'opener'), kind: 'ai', provider: 'groq', model: PROVIDERS.groq.default, max_tokens: 200, prompt: '' }); drawSnippets(); } }, icon('sparkle', 13), 'AI snippet'),
        h('button', { class: 'btn sm', type: 'button', onClick: () => { cfg.snippets.push({ name: nextName(cfg, 'line'), kind: 'if', condition: '', then: '', else: '' }); drawSnippets(); } }, icon('fx', 13), 'If / then snippet')));
    const snippetCard = (s, i) => {
      const insert = () => { cfg.body = `${cfg.body || ''}${cfg.body ? '\n\n' : ''}{{snippet:${s.name}}}`; ctx.refresh(); };
      const head = h('div', { class: 'field-row' },
        h('input', { class: 'input', value: s.name, 'aria-label': 'Snippet name', style: { maxWidth: '160px' },
          onChange: (e) => { const old = s.name; s.name = e.target.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_'); cfg.body = String(cfg.body || '').split(`{{snippet:${old}}}`).join(`{{snippet:${s.name}}}`); ctx.refresh(); } }),
        h('span', { class: 'faint' }, s.kind === 'ai' ? 'AI' : 'If / then'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', type: 'button', onClick: insert, title: 'Adds {{snippet:name}} to the end of the body' }, 'Insert'),
        h('button', { class: 'btn ghost icon sm', type: 'button', 'aria-label': 'Remove snippet', onClick: () => { cfg.snippets.splice(i, 1); drawSnippets(); showPreview(); } }, icon('trash', 13)));
      if (s.kind === 'ai') {
        const prov = PROVIDERS[s.provider] || PROVIDERS.groq;
        return h('div', { class: 'snippet-card' }, head,
          h('div', { class: 'grid2' },
            field('Provider', h('select', { class: 'select', 'aria-label': 'Provider', onChange: (e) => { s.provider = e.target.value; s.model = PROVIDERS[s.provider].default; drawSnippets(); ctx.redrawFoot(); } },
              Object.entries(PROVIDERS).map(([k, v]) => h('option', { value: k, selected: k === s.provider }, v.label)))),
            field('Model', prov.models.length
              ? h('select', { class: 'select', 'aria-label': 'Model', onChange: (e) => { s.model = e.target.value; ctx.redrawFoot(); } }, prov.models.map((m) => h('option', { value: m, selected: m === s.model }, m)))
              : h('input', { class: 'input', value: s.model || '', placeholder: 'model name', 'aria-label': 'Model', onChange: (e) => { s.model = e.target.value.trim(); ctx.redrawFoot(); } }))),
          field('Prompt', templateInput({ value: s.prompt || '', columns: ctx.columns, multiline: true, label: 'Snippet prompt',
            placeholder: 'One friendly sentence about what {{company}} does, from {{about}}.', onChange: (v) => { s.prompt = v; ctx.redrawFoot(); } })));
      }
      return h('div', { class: 'snippet-card' }, head,
        field('If (a formula)', templateInput({ value: s.condition || '', columns: ctx.columns, label: 'Condition', placeholder: '{{employees}} > 50', onChange: (v) => { s.condition = v; showPreview(); } })),
        field('Then', templateInput({ value: s.then || '', columns: ctx.columns, label: 'Then text', placeholder: 'Worth a call with your ops lead?', onChange: (v) => { s.then = v; showPreview(); } })),
        field('Else', templateInput({ value: s.else || '', columns: ctx.columns, label: 'Else text', placeholder: 'Worth a quick call?', onChange: (v) => { s.else = v; showPreview(); } })));
    };
    const mapped = new Set((cfg.outputs || []).map((o) => o.field));
    drawSnippets();
    mount(el,
      field('Subject', templateInput({ value: cfg.subject || '', columns: ctx.columns, label: 'Subject', placeholder: 'Quick question, {{clean:first_name}}',
        onChange: (v) => { cfg.subject = v; showPreview(); ctx.redrawFoot(); } })),
      field('Body', templateInput({ value: cfg.body || '', columns: ctx.columns, multiline: true, label: 'Body',
        placeholder: '{Hi|Hello} {{clean:first_name}},\n\n{{snippet:opener}}', onChange: (v) => { cfg.body = v; showPreview(); ctx.redrawFoot(); } })),
      h('details', { class: 'help' }, h('summary', null, 'How to write it'),
        h('div', { class: 'stack faint', style: { marginTop: '6px' } },
          h('div', null, h('code', null, '{{column}}'), ' the row’s value. Type / to pick one.'),
          h('div', null, h('code', null, '{{clean:column}}'), ' tidied: “Acme Roofing, LLC” becomes “Acme Roofing”, a website becomes acme.com, “MAX” becomes “Max”.'),
          h('div', null, h('code', null, '{Hi|Hello|Hey}'), ' spintax: one option per row, the same one every time for that row.'),
          h('div', null, h('code', null, '{{snippet:name}}'), ' a snippet below: AI writes it per row, or a formula picks one of two texts.'),
          h('div', null, 'A row with an empty column that the subject, body or an AI snippet uses is skipped. Nothing sends: the message stays in the table.'))),
      h('div', { class: 'sect-h' }, 'Snippets'), snippetsEl,
      preview,
      !(mapped.has('subject') && mapped.has('body')) ? h('label', { class: 'checkline' },
        h('input', { type: 'checkbox', checked: !!draft.wantSplit, onChange: (e) => { draft.wantSplit = e.target.checked; } }),
        ' Also put the subject and the body in their own columns (for sending)') : null,
      h('label', { class: 'checkline' }, h('input', { type: 'checkbox', checked: !!cfg.allow_empty, onChange: (e) => { cfg.allow_empty = e.target.checked; } }),
        ' Write it even when a column it uses is empty'),
      runOptions(cfg, ctx));
    showPreview();
  },
  async afterSave(col, draft) {
    if (draft.wantSplit) {
      try {
        const have = new Set((col.config.outputs || []).map((o) => o.field));
        for (const f of ['subject', 'body']) if (!have.has(f)) await api.post(`/columns/${col.id}/outputs`, { field: f, name: `${col.name} ${f}` });
      } catch (e) { toast(e.message, { error: true }); }
    }
    await loadTable(state.t.table.id);
  },
  footer: (draft) => {
    const w = worstCase(draft.config); const n = state.t.rows.length;
    return h('span', { class: 'foot-row' }, h('span', { class: 'faint' }, w ? `Up to ~${fmtMicros(w)} a row, ${fmtMicros(w * n)} for ${n} rows` : `Free for all ${n} rows`), tryButton(draft));
  },
};
