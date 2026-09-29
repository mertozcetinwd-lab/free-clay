/**
 * Fill a Free Clay install with demo data, through its own API, so every page has something on
 * it (for screenshots, a video, or a first look). Fictional rows only: every person is "Testrow"
 * and every company domain is example.com / .org / .net (reserved for examples, RFC 2606).
 *
 *   node dev/preview.mjs --memory --fake-opendata          (in one terminal)
 *   node dev/demo.mjs http://localhost:8787 preview        (in another)
 *
 * Runs only free functions and the preview's fake providers. Against a real install it would
 * spend nothing either, except Groq's free tier for one agent test.
 */

const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/+$/, '');
const PASSWORD = process.argv[3] || 'preview';
let cookie = '';

async function call(method, path, body) {
  const r = await fetch(BASE + '/api' + path, { method, headers: { cookie, ...(body && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}) },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
}
const drain = async (path = '/run-batch') => { for (let i = 0; i < 40; i++) { const r = await call('POST', path); if (!r.remaining) break; } };
const say = (s) => console.log(s);

await call('POST', '/login', { password: PASSWORD });
await call('PATCH', '/settings', { profile_name: 'Alex', contact_email: 'demo@example.com',
  ai_context: 'We are a small web and AI agency in Florida. We help home-service businesses (roofers, HVAC, plumbers) answer every call and book more jobs.\nIdeal customer: 2 to 50 staff, has a website, gets calls from Google.' });

// Tables
const sample = await call('POST', '/tables/sample');
const health = await call('POST', '/assist/build', { plan: { name: 'Website health check', columns: [{ name: 'Company', type: 'text' }, { name: 'Website', type: 'url' }],
  enrichments: [{ name: 'Site status', fn: 'website_check', inputs: { domain: 'Website' } }, { name: 'Email provider', fn: 'email_provider', inputs: { domain: 'Website' } }] } });
const ht = await call('GET', `/tables/${health.id}`);
const k = Object.fromEntries(ht.columns.map((c) => [c.name, c.key]));
await call('POST', `/tables/${health.id}/rows`, { rows: [['Example Roofing', 'example.com'], ['Example HVAC', 'example.org'], ['Example Plumbing', 'example.net'], ['IANA', 'iana.org']]
  .map(([n, w]) => ({ [k.Company]: n, [k.Website]: w })) });
for (const c of ht.columns.filter((x) => x.kind !== 'data')) await call('POST', `/tables/${health.id}/run`, { column_id: c.id });
await drain();
await call('GET', `/tables/${health.id}/export.csv`);
say(`tables: sample ${sample.id}, website health ${health.id}`);

// Audiences
const people = [['Ana', 'Owner', 'Example Roofing', 'example.com', 'Gainesville'], ['Ben', 'General Manager', 'Example HVAC', 'example.org', 'Ocala'],
  ['Cara', 'Founder', 'Example Plumbing', 'example.net', 'Tampa'], ['Dan', 'Office Manager', 'Example Electric', 'example.com', 'Orlando'], ['Eve', 'Owner', 'Example Pest', 'example.org', 'Jacksonville']];
await call('POST', '/audiences/people/upsert', { source: 'Demo', records: people.map(([f, title, company, d, city]) => ({ first_name: f, last_name: 'Testrow', email: `${f.toLowerCase()}@${d}`, title, company, city, state: 'FL' })) });
await call('POST', '/audiences/companies/upsert', { source: 'Demo', records: people.map(([, , company, d, city], i) => ({ name: company, website: `https://${['roofing', 'hvac', 'plumbing', 'electric', 'pest'][i]}.${d}`, city, state: 'FL', industry: ['Roofing', 'HVAC', 'Plumbing', 'Electrical', 'Pest control'][i], employees: [12, 40, 8, 25, 15][i] })) });
await call('POST', '/segments', { kind: 'people', name: 'Owners', filters: [{ field: 'title', op: 'equals', value: 'owner' }] });
await call('POST', '/segments', { kind: 'companies', name: 'Under 20 staff', filters: [{ field: 'employees', op: 'lt', value: '20' }] });
say('audiences: 5 people, 5 companies, 2 segments');

// Agents
const research = await call('POST', '/agents', { name: 'Company research', provider: 'groq', model: 'qwen/qwen3.8-27b', tools: ['read_page'], max_steps: 4, template: 'company_summary',
  prompt: 'Read the website {{domain}} and describe the business: what it sells or does, who its customers are, and where it operates.',
  fields: [{ name: 'summary', type: 'text' }, { name: 'industry', type: 'text' }, { name: 'service_area', type: 'text' }] });
await call('POST', '/agents', { name: 'Prospect research', provider: 'groq', model: 'qwen/qwen3.8-27b', tools: ['read_page', 'google_search', 'company_enrich', 'company_news'], max_steps: 6, template: 'prospect_research',
  prompt: 'Research {{company}} ({{domain}}): what they sell, how many people work there, where they operate, and anything that changed recently.',
  fields: [{ name: 'summary', type: 'text' }, { name: 'employees', type: 'number' }, { name: 'recent_change', type: 'text' }] });
try { await call('POST', `/agents/${research.id}/run`, { input: { domain: 'iana.org' } }); } catch (e) { say(`agent test skipped: ${e.message}`); }
say('agents: 2');

// Workflow
const wf = await call('POST', '/workflows', { name: 'Qualify new rows', graph: { nodes: [
  { id: 'n1', type: 'trigger', config: { type: 'row_added', table_id: health.id }, x: 40, y: 160 },
  { id: 'n2', type: 'function', config: { fn: 'website_check', inputs: { domain: `{{${k.Website}}}` }, save_as: 'site' }, x: 330, y: 160 },
  { id: 'n3', type: 'condition', config: { formula: '{{site}} = "live"' }, x: 620, y: 160 },
  { id: 'n4', type: 'upsert', config: { kind: 'companies', values: { name: `{{${k.Company}}}`, website: `{{${k.Website}}}` } }, x: 910, y: 90 },
  { id: 'n5', type: 'set', config: { values: { skipped: 'site not live' } } , x: 910, y: 260 },
], edges: [{ from: 'n1', to: 'n2', port: 'out' }, { from: 'n2', to: 'n3', port: 'out' }, { from: 'n3', to: 'n4', port: 'true' }, { from: 'n3', to: 'n5', port: 'false' }] } });
await call('POST', `/workflows/${wf.id}/run`, { table_id: health.id });
await drain('/workflows/drain');
await call('PATCH', `/workflows/${wf.id}`, { status: 'on' });
say(`workflow ${wf.id}: ran once per row, switched on`);

// Signals (a baseline check each: nothing is reported until something changes)
const sig = await call('POST', '/signals', { name: 'Hiring at design tools', type: 'jobs', targets: ['figma', 'notion'], every_hours: 24 });
await call('POST', '/signals', { name: 'Example Roofing website', type: 'website', targets: ['example.com'], every_hours: 24 });
await call('POST', `/signals/${sig.id}/check`);
say('signals: 2');

// An API token, so the MCP and API pages show one
await call('POST', '/tokens', { name: 'Claude Code' });
say('done');
