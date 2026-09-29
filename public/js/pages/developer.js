/**
 * MCP and API/CLI pages (LOAM-PLAN.md phase 10; Clay's MCP and API pages, teardown-v2 5.4 and
 * 5.5): access tokens, copy-paste setup for Claude Code, Claude Desktop, Cursor and ChatGPT, the
 * tool list, curl examples and the free-clay command. Tokens are shown once, then only their prefix.
 */

import { h, mount } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { changed } from '../store.js';
import { toast, confirmDialog, modal } from '../ui/overlay.js';

let tokens = null; let tools = null; let loading = false; let fresh = null;

async function load() {
  loading = true;
  try { [tokens, tools] = await Promise.all([api.get('/tokens'), tools || api.get('/mcp-tools')]); }
  catch (e) { toast(e.message, { error: true }); tokens = tokens || []; tools = tools || []; }
  loading = false; changed();
}

const origin = () => location.origin;
const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied.'), () => toast('Copy did not work. Select the text instead.', { error: true }));
const code = (text, label) => h('div', { class: 'dev-code' }, label ? h('div', { class: 'label' }, label) : null,
  h('pre', { class: 'code' }, text), h('button', { class: 'btn ghost sm dev-copy', onClick: () => copy(text) }, icon('copy', 13), 'Copy'));
const tok = () => fresh?.token || 'fc_YOUR_TOKEN';

function tokenSection(purpose) {
  return h('section', { class: 'set-sect' },
    h('h2', null, 'Access tokens'),
    h('p', null, `A token lets ${purpose} use your Free Clay without the password. Make one per place you use it, so you can revoke it alone.`),
    fresh ? h('div', { class: 'note warn' }, icon('key', 14), h('div', { class: 'stack', style: { gap: '6px', minWidth: 0 } },
      h('b', null, `“${fresh.name}” token. Copy it now: it is not shown again.`), h('pre', { class: 'code', style: { margin: 0, wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, fresh.token),
      h('div', null, h('button', { class: 'btn sm', onClick: () => copy(fresh.token) }, icon('copy', 13), 'Copy token')))) : null,
    (tokens || []).length ? h('div', { class: 'klist' }, tokens.map((t) => h('div', { class: 'krow' },
      h('span', { class: 'dot', 'data-c': 'green' }), h('b', null, t.name), h('code', null, `${t.prefix}…`),
      h('span', { class: 'faint grow' }, t.last_used_at ? `used ${new Date(t.last_used_at).toLocaleString()}` : 'never used'),
      h('button', { class: 'btn ghost sm danger', onClick: async () => {
        if (!(await confirmDialog({ title: `Revoke “${t.name}”?`, text: 'Anything using it stops working at once.', confirmLabel: 'Revoke', danger: true }))) return;
        await api.del(`/tokens/${t.id}`); if (fresh?.id === t.id) fresh = null; load();
      } }, 'Revoke')))) : h('p', { class: 'faint' }, loading ? 'Loading…' : 'No tokens yet.'),
    h('button', { class: 'btn', style: { marginTop: '10px' }, onClick: newToken }, icon('plus', 14), 'New token'));
}

function newToken() {
  modal({ title: 'New access token', width: 420,
    body: (b) => b.append(h('input', { class: 'input', id: 'tok-name', placeholder: 'Claude Code', style: { width: '100%' } })),
    footer: (f, m) => f.append(h('span', { class: 'grow' }), h('button', { class: 'btn', onClick: m.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: async () => {
        try { fresh = await api.post('/tokens', { name: document.getElementById('tok-name').value }); m.close(); load(); }
        catch (e) { toast(e.message, { error: true }); }
      } }, 'Make token')) });
}

export function renderMcp(regions) {
  mount(regions.top, h('div', { class: 'crumbs' }, h('b', null, 'MCP')));
  if (!tokens && !loading) load();
  const url = `${origin()}/mcp`;
  mount(regions.content, h('div', { class: 'set-wrap dev' },
    h('div', { class: 'find-head' }, h('span', { class: 'files-ic' }, icon('link', 18)), h('h1', null, 'MCP')),
    h('p', { class: 'lead' }, 'Use Free Clay from Claude, ChatGPT or Cursor: they can read and build tables, search your People and Companies, find leads in open data, and run your agents and workflows. The server follows the 2026-07-28 MCP spec and still answers older clients.'),
    tokenSection('an AI app'),
    h('section', { class: 'set-sect' }, h('h2', null, 'Connect'),
      h('p', null, 'Server URL: ', h('code', null, url), '. It needs the token as a Bearer header.'),
      code(`claude mcp add --transport http free-clay ${url} --header "Authorization: Bearer ${tok()}"`, 'Claude Code'),
      code(JSON.stringify({ mcpServers: { 'free-clay': { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${tok()}`] } } }, null, 2), 'Claude Desktop (claude_desktop_config.json, through mcp-remote)'),
      code(JSON.stringify({ mcpServers: { 'free-clay': { url, headers: { Authorization: `Bearer ${tok()}` } } } }, null, 2), 'Cursor (.cursor/mcp.json)'),
      h('p', { class: 'faint' }, 'ChatGPT: Settings, Connectors, add a custom connector with the server URL, then the same Authorization header if your plan allows custom headers.')),
    h('section', { class: 'set-sect' }, h('h2', null, `Tools (${(tools || []).length})`),
      h('div', { class: 'dev-tools' }, (tools || []).map((t) => h('div', { class: 'dev-tool' },
        h('div', { class: 'row' }, h('code', null, t.name), t.annotations?.readOnlyHint ? h('span', { class: 'pill' }, 'read only') : null, t.annotations?.openWorldHint ? h('span', { class: 'pill' }, 'uses the web') : null),
        h('div', { class: 'faint' }, t.description))))),
    h('section', { class: 'set-sect' }, h('h2', null, 'Test it'),
      code(`curl -s ${url} -H "Authorization: Bearer ${tok()}" -H "Content-Type: application/json" -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`))));
}

export function renderApi(regions) {
  mount(regions.top, h('div', { class: 'crumbs' }, h('b', null, 'API and CLI')));
  if (!tokens && !loading) load();
  const base = `${origin()}/api/v1`;
  mount(regions.content, h('div', { class: 'set-wrap dev' },
    h('div', { class: 'find-head' }, h('span', { class: 'files-ic' }, icon('code', 18)), h('h1', null, 'API and CLI')),
    h('p', { class: 'lead' }, 'Everything the app does, from code or a terminal. Clay keeps its HTTP API for paid plans; here it is yours.'),
    tokenSection('a script or the free-clay command'),
    h('section', { class: 'set-sect' }, h('h2', null, 'REST API'),
      h('p', null, 'Base URL ', h('code', null, base), '. Send the token as ', h('code', null, 'Authorization: Bearer'), '. The full list is in ', h('a', { href: '/openapi.json', target: '_blank' }, 'openapi.json'), '.'),
      code(`curl -s ${base}/bootstrap -H "Authorization: Bearer ${tok()}"`, 'Your tables'),
      code(`curl -s -X POST ${base}/tables/1/rows -H "Authorization: Bearer ${tok()}" -H "Content-Type: application/json" \\\n  -d '{"rows":[{"name":"Example Roofing","website":"example.com"}]}'`, 'Add rows'),
      code(`curl -s -X POST ${base}/tables/1/run -H "Authorization: Bearer ${tok()}" -H "Content-Type: application/json" -d '{"column_id":2,"scope":"empty"}'`, 'Run a column'),
      code(`curl -s "${base}/audiences/companies?q=roofing&limit=20" -H "Authorization: Bearer ${tok()}"`, 'Search Companies'),
      code(`curl -s -X POST ${base}/agents/1/run -H "Authorization: Bearer ${tok()}" -H "Content-Type: application/json" -d '{"input":{"domain":"example.com"}}'`, 'Run an agent')),
    h('section', { class: 'set-sect' }, h('h2', null, 'The free-clay command'),
      h('p', null, 'One file, no installs beyond Node 18+. It is in the repo at ', h('code', null, 'bin/free-clay.mjs'), '.'),
      code(`export FREE_CLAY_URL=${origin()}\nexport FREE_CLAY_TOKEN=${tok()}\nnode bin/free-clay.mjs tables\nnode bin/free-clay.mjs import leads.csv --name "Roofers"\nnode bin/free-clay.mjs run 1 "Email provider"\nnode bin/free-clay.mjs export 1 > roofers.csv\nnode bin/free-clay.mjs companies roofing\nnode bin/free-clay.mjs agent 1 domain=example.com`, 'Examples'),
      h('p', { class: 'faint' }, 'On Windows PowerShell use $env:FREE_CLAY_URL = "…" instead of export.'))));
}

export function leaveDeveloper() { tokens = null; fresh = null; }
