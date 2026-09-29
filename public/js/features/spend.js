/**
 * Money on screen: the spend chip and History items in every table's bottom bar, the Spend
 * page, your own per-call prices, and the table's webhook panel.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, changed } from '../store.js';
import { tableHooks } from '../pages/table.js';
import { bottomHooks } from '../pages/table-bottom.js';
import { SECTIONS } from '../pages/settings.js';
import { openPanel } from '../ui/panel.js';
import { toast, confirmDialog } from '../ui/overlay.js';
import { fmtMicros } from '../types.js';
import { functions } from './enrich.js';

/* ---------------------------------------------------------------- cost footer */

let costs = null; let costsFor = null; let loading = false;
export async function refreshCosts() {
  if (!state.t || loading) return;
  loading = true;
  try { costs = await api.get(`/tables/${state.t.table.id}/costs`); costsFor = state.t.table.id; changed(); }
  catch { /* the footer is a convenience; the table works without it */ }
  finally { loading = false; }
}

tableHooks.afterLoad.push(refreshCosts);
tableHooks.afterRun.push(refreshCosts);

const RUN_STATUS = { running: 'running', done: 'finished', stopped: 'stopped', over_budget: 'hit its budget' };
const fresh = () => state.t && costsFor === state.t.table.id && costs;

// Bottom bar: this table's spend this month, always in view.
bottomHooks.status.push(() => fresh() ? h('span', { class: 'bb-cost', title: `${costs.month_table_calls.toLocaleString('en-US')} calls this month` },
  icon('dollar', 12), h('b', null, fmtMicros(costs.month_table_micros)), ' this month') : null);

// History menu: the detail.
bottomHooks.history.push(() => {
  if (!fresh()) return [];
  const r = costs.last_run;
  return [
    { group: 'Spend' },
    { label: r ? `Last run ${fmtMicros(r.spent_micros)} of ${fmtMicros(r.budget_micros)}, ${RUN_STATUS[r.status] || r.status}` : 'No runs yet', icon: 'play', onSelect: () => {} },
    { label: `This table this month ${fmtMicros(costs.month_table_micros)} (${costs.month_table_calls.toLocaleString('en-US')} calls)`, icon: 'table', onSelect: () => {} },
    { label: `All tables this month ${fmtMicros(costs.month_all_micros)}`, icon: 'dollar', onSelect: () => { history.pushState(null, '', '/settings/spend'); dispatchEvent(new PopStateEvent('popstate')); } },
  ];
});

/* ---------------------------------------------------------------- webhook panel */

function openWebhook() {
  const tid = state.t.table.id;
  openPanel({
    title: 'Send rows in by webhook', width: 520,
    body: async (el) => {
      const draw = (w) => {
        const url = `${location.origin}${w.path || `/api/hook/${tid}`}`;
        mount(el,
          h('p', { class: 'muted', style: { margin: 0 } }, 'POST one JSON object, or a list of up to 500, and each becomes a row. Fields match columns by name, the same way CSV headers do.'),
          w.enabled ? [
            h('div', { class: 'label' }, 'URL'), h('pre', { class: 'code' }, url),
            h('div', { class: 'label' }, 'Signing secret'), h('pre', { class: 'code' }, w.secret),
            h('div', { class: 'faint' }, 'Every request needs the header X-Signature: sha256=<HMAC-SHA256 of the raw body with this secret, in hex>. Unsigned requests are refused.'),
            h('div', { class: 'label' }, 'Try it from a terminal'),
            h('pre', { class: 'code' }, `BODY='{"website":"example.com"}'\nSIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac '${w.secret}' | sed 's/^.* //')\ncurl -X POST '${url}' -H "X-Signature: sha256=$SIG" -H 'content-type: application/json' -d "$BODY"`),
            h('div', { class: 'row' },
              h('button', { class: 'btn', onClick: async () => {
                if (!(await confirmDialog({ title: 'Make a new secret?', text: 'Senders using the old one stop working until you update them.', confirmLabel: 'Rotate' }))) return;
                draw(await api.post(`/tables/${tid}/webhook`, {}));
              } }, icon('refresh', 14), 'Rotate secret'),
              h('button', { class: 'btn danger', onClick: async () => draw(await api.post(`/tables/${tid}/webhook`, { enabled: false })) }, 'Turn off')),
          ] : h('div', null, h('button', { class: 'btn primary', onClick: async () => draw(await api.post(`/tables/${tid}/webhook`, {})) }, 'Turn on the webhook')));
      };
      try { draw(await api.get(`/tables/${tid}/webhook`)); } catch (e) { toast(e.message, { error: true }); }
    },
  });
}

tableHooks.addRows.push(() => ({ label: 'Send rows in by webhook', icon: 'inbox', onSelect: openWebhook }));

/* ---------------------------------------------------------------- Spend page and prices */

SECTIONS.spend = {
  label: 'Spend', icon: 'dollar',
  render: async (el) => {
    el.append(h('h1', null, 'Spend'), h('p', { class: 'lead' }, 'Every provider call, free ones included, from the ledger. Paid calls are billed by the provider on your key; free-clay itself costs nothing to run.'));
    const box = h('div'); el.append(box);
    let s;
    try { s = await api.get('/spend'); } catch (e) { return mount(box, h('p', { class: 'bad' }, e.message)); }
    const total = s.by_provider.reduce((a, p) => a + (p.micros || 0), 0);
    const calls = s.by_provider.reduce((a, p) => a + p.calls, 0);
    // Columns after the first `text` are numbers and align right.
    const table = (head, rows, text = 1) => h('table', { class: 'mini' }, h('thead', null, h('tr', null, head.map((x, i) => h('th', { class: i >= text && 'num' }, x)))),
      h('tbody', null, rows.length ? rows.map((r) => h('tr', null, r.map((x, i) => h('td', { class: i >= text && 'num' }, x)))) : h('tr', null, h('td', { colspan: head.length, class: 'faint' }, 'Nothing yet'))));
    mount(box,
      h('div', { class: 'set-sect' }, h('div', { class: 'big' }, fmtMicros(total)), h('div', { class: 'faint' }, `${calls.toLocaleString('en-US')} calls in ${s.month} (UTC)`)),
      h('div', { class: 'set-sect' }, h('h2', null, 'By provider, this month'),
        table(['Function', 'Calls', 'Hits', 'Cost', 'Per hit'], s.by_provider.map((p) => [p.provider, p.calls, p.hits, fmtMicros(p.micros), p.hits ? fmtMicros(Math.round(p.micros / p.hits)) : '-']))),
      h('div', { class: 'set-sect' }, h('h2', null, 'By table, this month'),
        table(['Table', 'Calls', 'Cost'], s.by_table.map((t) => [t.name || `Table ${t.table_id}`, t.calls, fmtMicros(t.micros)]))),
      h('div', { class: 'set-sect' }, h('h2', null, 'By month'), table(['Month', 'Calls', 'Cost'], s.by_month.map((m) => [m.month, m.calls, fmtMicros(m.micros)]))),
      h('div', { class: 'set-sect' }, h('h2', null, 'Latest 100 calls'),
        table(['When (UTC)', 'Function', 'Outcome', 'Cost'], s.recent.map((r) => [r.ts.slice(0, 16).replace('T', ' '), `${r.provider}${r.table_name ? ` · ${r.table_name}` : ''}`, h('span', { title: r.note || '' }, r.outcome), fmtMicros(r.cost_micros)]), 3)));
  },
};

SECTIONS.prices = {
  label: 'Prices', icon: 'dollar',
  render: async (el) => {
    const list = await functions();
    const overrides = { ...(state.boot.settings.cost_overrides || {}) };
    const save = async () => {
      try { state.boot.settings = await api.patch('/settings', { cost_overrides: overrides }); toast('Prices saved'); changed(); }
      catch (e) { toast(e.message, { error: true }); }
    };
    el.append(h('h1', null, 'Prices'),
      h('p', { class: 'lead' }, 'What each paid function costs you per call. Estimates and run budgets use these. Change one when your plan changes; leave it blank to use the estimate shown.'),
      h('div', { class: 'set-sect' }, h('table', { class: 'mini' },
        h('thead', null, h('tr', null, h('th', null, 'Function'), h('th', null, 'Where the estimate comes from'), h('th', { class: 'num' }, 'Estimate'), h('th', { class: 'num' }, 'Your price ($)'))),
        h('tbody', null, list.filter((f) => f.secret || f.costMicros).map((f) => h('tr', null,
          h('td', null, f.name), h('td', { class: 'faint', style: { whiteSpace: 'normal' } }, f.costSource || ''),
          h('td', { class: 'num' }, fmtMicros(f.costMicros)),
          h('td', { class: 'num' }, h('input', { class: 'input', type: 'number', min: '0', step: '0.0001', style: { width: '110px' }, 'aria-label': `Your price for ${f.name}`,
            value: Number.isInteger(overrides[f.id]) ? String(overrides[f.id] / 1e6) : '',
            onChange: (e) => { if (e.target.value === '') delete overrides[f.id]; else overrides[f.id] = Math.max(0, Math.round(Number(e.target.value) * 1e6)); } }))))))),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onClick: save }, 'Save prices')),
      h('p', { class: 'faint' }, 'AI columns price themselves from the model (Settings are per column), and HTTP columns carry their own cost per call.'));
  },
};
