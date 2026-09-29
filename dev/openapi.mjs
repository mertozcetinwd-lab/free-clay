/**
 * Writes public/openapi.json, the REST API description the API page links to. The paths are
 * listed here once, next to what each does, so the file never drifts into hand-edited JSON.
 *
 *   node dev/openapi.mjs
 */
import { writeFileSync } from 'node:fs';

const obj = (props = {}) => ({ type: 'object', properties: props });
const ok = (d = 'OK') => ({ 200: { description: d, content: { 'application/json': { schema: obj() } } } });
const id = (n) => ({ name: n, in: 'path', required: true, schema: { type: 'integer' } });
const body = (props) => ({ required: true, content: { 'application/json': { schema: obj(props) } } });
const op = (tag, summary, extra = {}) => ({ tags: [tag], summary, responses: ok(), ...extra });
const S = { type: 'string' }; const I = { type: 'integer' }; const A = { type: 'array', items: obj() };
const csv = (tag, summary, params) => ({ tags: [tag], summary, parameters: params, responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: S } } } } });
const kind = { name: 'kind', in: 'path', required: true, schema: { enum: ['people', 'companies'] } };

const paths = {
  '/bootstrap': { get: op('Tables', 'Settings, every table with row and column counts, key names, spend this month') },
  '/tables': { post: op('Tables', 'Make a table (optionally from CSV text)', { requestBody: body({ name: S, csv: S }) }) },
  '/tables/{id}': {
    get: op('Tables', 'A table: columns, rows, cell status', { parameters: [id('id')] }),
    patch: op('Tables', 'Rename, describe, move, favorite, set dedupe', { parameters: [id('id')], requestBody: body({ name: S }) }),
    delete: op('Tables', 'Move to Trash', { parameters: [id('id')] }),
  },
  '/tables/{id}/columns': { post: op('Tables', 'Add a column (data, enrich, waterfall, formula, ai, http)', { parameters: [id('id')], requestBody: body({ name: S, kind: S, type: S, config: obj() }) }) },
  '/tables/{id}/rows': { post: op('Tables', 'Add rows: {rows: [{column_key: value}]}', { parameters: [id('id')], requestBody: body({ rows: A }) }) },
  '/tables/{id}/import': { post: op('Tables', 'Import CSV text into the table (headers matched to columns)', { parameters: [id('id')], requestBody: { required: true, content: { 'text/csv': { schema: S } } } }) },
  '/tables/{id}/export.csv': { get: csv('Tables', 'The table as CSV (recorded in Exports)', [id('id')]) },
  '/tables/{id}/run': { post: op('Runs', 'Queue a computed column: scope empty, all, errored or selected; budget_micros caps the run', { parameters: [id('id')], requestBody: body({ column_id: I, scope: S, row_ids: { type: 'array', items: I }, budget_micros: I }) }) },
  '/run-batch': { post: op('Runs', 'Work one batch of the run queue now (the cron does this every minute)') },
  '/runs/{id}/stop': { post: op('Runs', 'Stop a run', { parameters: [id('id')] }) },
  '/functions': { get: op('Runs', 'Every enrichment function: inputs, outputs, cost, key needed') },
  '/spend': { get: op('Runs', 'Spend this month by provider and table') },
  '/audiences/{kind}': { get: op('Audiences', 'List People or Companies: q, filters (JSON), segment, sort, dir, limit, offset', { parameters: [kind, { name: 'q', in: 'query', schema: S }, { name: 'filters', in: 'query', schema: S }, { name: 'limit', in: 'query', schema: I }] }) },
  '/audiences/{kind}/upsert': { post: op('Audiences', 'Add or update records; the same email (people) or domain (companies) is the same record', { parameters: [kind], requestBody: body({ records: A, source: S, overwrite: { type: 'boolean' } }) }) },
  '/audiences/{kind}/from-table': { post: op('Audiences', 'Send the rows of a table in', { parameters: [kind], requestBody: body({ table_id: I, map: obj() }) }) },
  '/audiences/{kind}/to-table': { post: op('Audiences', 'Records out to a new or existing table', { parameters: [kind], requestBody: body({ ids: { type: 'array', items: I }, segment_id: I, table_id: I, name: S }) }) },
  '/segments': { get: op('Audiences', 'Saved filters with live counts'), post: op('Audiences', 'Save a segment', { requestBody: body({ kind: S, name: S, filters: A }) }) },
  '/find/companies/wikidata': { post: op('Find leads', 'Companies by industry and US state (Wikidata, free)', { requestBody: body({ industry: S, state: S }) }) },
  '/find/companies/sec': { post: op('Find leads', 'US public companies by name or ticker (SEC, free)', { requestBody: body({ q: S }) }) },
  '/find/jobs': { post: op('Find leads', 'Open roles from Greenhouse, Lever and Ashby boards (free)', { requestBody: body({ companies: { type: 'array', items: S }, keyword: S }) }) },
  '/find/lookalikes': { post: op('Find leads', 'Companies like a website (Exa, your key)', { requestBody: body({ url: S }) }) },
  '/agents': { get: op('Agents', 'Saved agents'), post: op('Agents', 'Make an agent', { requestBody: body({ name: S, prompt: S, provider: S, model: S, tools: { type: 'array', items: S }, fields: A }) }) },
  '/agents/{id}/run': { post: op('Agents', 'Run an agent once on inputs', { parameters: [id('id')], requestBody: body({ input: obj() }) }) },
  '/agents/{id}/runs': { get: op('Agents', 'Recent runs with every step', { parameters: [id('id')] }) },
  '/workflows': { get: op('Workflows', 'Workflows with run counts'), post: op('Workflows', 'Make a workflow', { requestBody: body({ name: S, graph: obj() }) }) },
  '/workflows/{id}': { patch: op('Workflows', 'Rename, change the graph, switch on or off', { parameters: [id('id')], requestBody: body({ name: S, graph: obj(), status: S }) }) },
  '/workflows/{id}/run': { post: op('Workflows', 'Start runs: {item}, {table_id, row_ids} or {segment_id}', { parameters: [id('id')], requestBody: body({ item: obj(), table_id: I }) }) },
  '/workflows/{id}/runs': { get: op('Workflows', 'Runs with their logs', { parameters: [id('id')] }) },
  '/workflows/drain': { post: op('Workflows', 'Work queued runs now (the cron does this every minute)') },
  '/signals': { get: op('Signals', 'Signals with event counts'), post: op('Signals', 'Watch companies: type jobs, website, news or sec', { requestBody: body({ name: S, type: S, targets: { type: 'array', items: S }, every_hours: I, table_id: I }) }) },
  '/signals/{id}/check': { post: op('Signals', 'Check a signal now', { parameters: [id('id')] }) },
  '/signals/events': { get: op('Signals', 'Recent events', { parameters: [{ name: 'signal', in: 'query', schema: I }, { name: 'limit', in: 'query', schema: I }] }) },
  '/exports': { get: op('Exports', 'CSV downloads of the last 30 days') },
  '/exports/{id}/download': { get: csv('Exports', 'Download an export again', [id('id')]) },
};

const doc = {
  openapi: '3.1.0',
  info: { title: 'Free Clay API', version: '1.0.0', description: 'The same routes the Free Clay app uses. Send an API token (made on the API and CLI page) as Authorization: Bearer fc_... . Money is in micro-dollars (1,000,000 = $1). MCP clients use /mcp instead.' },
  servers: [{ url: '/api/v1' }],
  security: [{ token: [] }],
  components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } } },
  paths,
};
writeFileSync(new URL('../public/openapi.json', import.meta.url), JSON.stringify(doc, null, 2) + '\n');
console.log(`public/openapi.json: ${Object.keys(paths).length} paths`);
