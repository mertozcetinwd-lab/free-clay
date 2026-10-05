import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { nav } from '../nav.js';
import { toast } from '../ui/overlay.js';

const item = (title, body, path, label, symbol) => h('div', { class: 'prospect-action' },
  h('span', { class: 'prospect-action-icon' }, icon(symbol, 20)), h('h2', null, title), h('p', null, body),
  h('a', { class: 'btn', href: path, onClick: (e) => { e.preventDefault(); nav.go(path); } }, label, icon('arrow-right', 14)));

async function exportAudience(kind, status) {
  status.textContent = `Preparing ${kind}…`;
  try {
    const data = await api.get(`/audiences/${kind}?limit=500&offset=0`);
    if (!data.records.length) { status.textContent = `No ${kind} records to transfer.`; return; }
    const records = data.records.map((record) => {
      const source = Object.values(record.sources || {}).find((x) => x?.source);
      return { data: record.data, sources: record.sources || {}, source: source?.source || 'Free Clay audience', observed_at: source?.at || record.updated_at };
    });
    const payload = { format: 'free-apollo-transfer-v1', kind, exported_at: new Date().toISOString(), records };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `free-clay-${kind}-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `${records.length} ${kind} exported. ${data.total > 500 ? `${data.total - 500} more remain outside this file. Use a table CSV export for larger sets.` : 'Import this file from Free Apollo, Transfer.'}`;
  } catch (e) { status.textContent = `Export failed: ${e.message}`; toast(e.message, { error: true }); }
}

let sequences = null, sequenceError = '', editing = null, loadingSequences = false;
async function loadSequences() {
  if (loadingSequences) return;
  loadingSequences = true;
  try { sequences = await api.get('/prospect/sequences'); sequenceError = ''; }
  catch (e) { sequenceError = e.message; }
  loadingSequences = false;
  nav.go('/prospect');
}

function stepEditor(step = { type: 'email_draft', delay_days: 0, subject: '', body: '', variant: 'A' }) {
  const type = h('select', { class: 'input', 'aria-label': 'Step type' },
    h('option', { value: 'email_draft', selected: step.type === 'email_draft' }, 'Email draft'),
    h('option', { value: 'manual_task', selected: step.type === 'manual_task' }, 'Manual task'));
  const delay = h('input', { class: 'input', type: 'number', min: 0, max: 365, value: step.delay_days, 'aria-label': 'Days after previous step' });
  const subject = h('input', { class: 'input', value: step.subject || '', placeholder: 'Draft subject or task title', 'aria-label': 'Draft subject or task title' });
  const body = h('textarea', { class: 'input', rows: 3, placeholder: 'Use {{placeholder}} for claims that need evidence.', 'aria-label': 'Step text' }, step.body || '');
  const variant = h('input', { class: 'input', value: step.variant || 'A', maxlength: 30, 'aria-label': 'Variant' });
  const el = h('div', { class: 'prospect-step' }, h('div', { class: 'row' }, type, h('label', null, 'Wait ', delay, ' days'),
    h('button', { class: 'btn ghost', onClick: () => el.remove() }, 'Remove')), subject, body,
    h('label', null, 'Variant ', variant));
  el.read = () => ({ type: type.value, delay_days: Number(delay.value), subject: subject.value, body: body.value, variant: variant.value });
  return el;
}

async function saveSequence(editor) {
  const payload = { name: editor.querySelector('[name="name"]').value,
    steps: [...editor.querySelectorAll('.prospect-step')].map((el) => el.read()) };
  try {
    if (editing?.id) await api.put(`/prospect/sequences/${editing.id}`, payload);
    else await api.post('/prospect/sequences', payload);
    editing = null; await loadSequences(); toast('Draft saved. Nothing was sent.');
  } catch (e) { toast(e.message, { error: true }); }
}

function sequenceSection() {
  if (sequences === null && !sequenceError && !loadingSequences) queueMicrotask(loadSequences);
  const editor = editing && h('div', { class: 'prospect-sequence-editor' },
    h('label', null, 'Sequence name', h('input', { class: 'input', name: 'name', maxlength: 100, value: editing.name || '' })),
    h('div', { class: 'prospect-steps' }, (editing.steps || []).map(stepEditor)),
    h('div', { class: 'row' }, h('button', { class: 'btn', onClick: () => editor.querySelector('.prospect-steps').append(stepEditor()) }, 'Add step'),
      h('button', { class: 'btn primary', onClick: () => saveSequence(editor) }, 'Save draft'),
      h('button', { class: 'btn ghost', onClick: () => { editing = null; nav.go('/prospect'); } }, 'Cancel')));
  return h('section', { class: 'prospect-handoff' }, h('div', { class: 'row' }, h('div', null, h('h2', null, 'Draft sequences'),
    h('p', null, 'Plan email drafts and manual steps with waits and A/B variants. This workspace has no send action.')),
    h('button', { class: 'btn primary', onClick: () => { editing = { name: '', steps: [] }; nav.go('/prospect'); } }, 'New sequence')),
    sequenceError ? h('p', { role: 'alert' }, `Could not load drafts: ${sequenceError}`,
      h('button', { class: 'btn', onClick: loadSequences }, 'Retry')) : null,
    editor,
    !editing && sequences ? (sequences.length ? h('div', { class: 'prospect-sequence-list' }, sequences.map((seq) =>
      h('div', { class: 'prospect-sequence-row' }, h('strong', null, seq.name), h('span', null, `${seq.steps.length} steps · Draft only`),
        h('button', { class: 'btn', onClick: () => { editing = seq; nav.go('/prospect'); } }, 'Edit'))))
      : h('p', { class: 'faint' }, 'No draft sequences yet.')) : null);
}

export function renderProspect({ top, toolbar, content }) {
  mount(top, h('div', { class: 'crumbs' }, h('a', { href: '/', onClick: (e) => { e.preventDefault(); nav.go('/'); } }, 'Home'),
    h('span', { class: 'sep' }, '/'), h('b', null, 'Prospecting')));
  mount(toolbar);
  const status = h('p', { class: 'prospect-status', role: 'status' }, 'Nothing has been exported.');
  mount(content, h('div', { class: 'prospect-entry' },
    h('header', null, h('h1', null, 'Prospecting workspace'),
      h('p', null, 'Find companies from open sources, organize people, then hand records to Free Apollo or Free CRM. Paid searches still show their own cap before running.')),
    h('div', { class: 'prospect-actions' },
      item('Find', 'Search local businesses, public companies, job signals or a capped people provider.', '/find', 'Find leads', 'search'),
      item('Qualify', 'Filter your saved people and companies. Each field keeps its source and retrieval date.', '/people', 'Open people', 'users'),
      item('Enrich', 'Run a selected table column only after reviewing its source and cost.', '/', 'Open tables', 'table')),
    sequenceSection(),
    h('section', { class: 'prospect-handoff' }, h('div', null, h('h2', null, 'Handoff to Free Apollo'),
      h('p', null, 'Download audience records with source labels. The file stays on your computer until you import it. Matching emails and domains will not create duplicate records.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onClick: () => exportAudience('people', status) }, icon('download', 15), 'Export people'),
        h('button', { class: 'btn', onClick: () => exportAudience('companies', status) }, icon('download', 15), 'Export companies')),
      status,
      h('p', { class: 'faint' }, 'One file holds up to 500 saved records. No contact lookup, reveal, send or paid provider call happens during export.')),
    h('section', { class: 'prospect-handoff' }, h('h2', null, 'Free CRM'),
      h('p', null, 'For the separate Free CRM app, export a table as CSV after mapping its columns. Import that CSV from People or Companies in Free CRM.'))));
}
