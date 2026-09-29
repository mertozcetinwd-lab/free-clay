/**
 * Audiences (LOAM-PLAN.md phase 7, Clay's People and Companies databases, teardown-v2 section 4):
 * one database of people and one of companies across every table, de-duplicated, with where each
 * value came from.
 *
 * MERGING. Two records are the same one when their key matches (recordKey). A new value fills an
 * empty field; a field that already has a value keeps it unless the caller asks to overwrite.
 * That is the safe default for data from many tables: a later import of worse data cannot erase
 * a good email. Both merges are one SQL statement per ~900 KB (json_patch, old or new side wins),
 * so a 5,000-record import is a handful of D1 queries, not 5,000.
 *
 * FILTERS run in SQLite over json_extract, with field names checked against the field list and
 * every value bound, so a filter can never become SQL.
 */

import { fail, nowIso, parseJson } from './util.js';
import { FIELDS, fieldKeys, AUD_OPS, AUD_NO_VALUE, guessMap } from '../public/js/audience-fields.js';
import { coerce } from '../public/js/types.js';
import { normalizeDomain } from './functions/web.js';
import { EMAIL_RE } from './opendata/http.js';
import { parseCsv, MAX_IMPORT_ROWS } from './csv.js';
import { getTableRow, loadColumns, createTable, insertRows, hooks, MAX_ROWS } from './tables.js';
import { columnsFor } from './find.js';

export const MAX_RECORDS = 200_000;       // per kind: ~60 MB of D1's 500 MB at ~300 bytes a record
export const MAX_PAGE = 500;
export const MAX_SEGMENTS = 50;
const FREE_MAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'aol.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'msn.com', 'comcast.net', 'att.net'];

export function checkKind(kind) {
  if (!FIELDS[kind]) fail(404, 'Audiences are people or companies');
  return kind;
}

/** Keep known fields, typed, trimmed, non-empty. Fills what can be derived (domain, full name). */
export function cleanRecord(kind, raw) {
  const out = {};
  for (const [key, , type] of FIELDS[kind]) {
    let v = raw?.[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') v = Array.isArray(v) ? v.join(', ') : JSON.stringify(v);
    v = coerce(type, typeof v === 'string' ? v.trim().slice(0, 2000) : v);
    if (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) continue;
    out[key] = v;
  }
  if (out.email !== undefined) {
    const e = String(out.email).toLowerCase();
    if (EMAIL_RE.test(e)) out.email = e; else delete out.email;
  }
  if (kind === 'companies') {
    const d = normalizeDomain(out.domain || out.website || '');
    if (d) out.domain = d; else delete out.domain;
  } else {
    const d = normalizeDomain(out.domain || '');
    if (d) out.domain = d; else delete out.domain;
    if (!out.domain && out.email) {
      const ed = out.email.split('@')[1];
      if (ed && !FREE_MAIL.includes(ed)) out.domain = ed;
    }
    if (!out.full_name && (out.first_name || out.last_name)) out.full_name = [out.first_name, out.last_name].filter(Boolean).join(' ');
  }
  return out;
}

/** What makes two records one. null = not enough to tell, so the record is skipped. */
export function recordKey(kind, d) {
  const low = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (kind === 'people') {
    if (d.email) return 'e:' + d.email;
    const name = low(d.full_name);
    const org = low(d.domain || d.company);
    return name && org ? `n:${name}|${org}` : null;
  }
  if (d.domain) return 'd:' + d.domain;
  const name = low(d.name);
  return name ? `n:${name}|${low(d.city)}` : null;
}

/**
 * list: raw objects. source: a short label ("Table: Roofers", "CSV: leads.csv", "Workflow 3").
 * Returns {added, updated, skipped}. overwrite: new values replace old ones.
 */
export async function upsertRecords(db, kind, list, source, { overwrite = false } = {}) {
  checkKind(kind);
  if (!Array.isArray(list)) fail(400, 'records must be a list');
  const at = nowIso();
  const src = String(source || 'Added by hand').slice(0, 120);
  const byKey = new Map(); let skipped = 0;
  for (const raw of list) {
    const d = cleanRecord(kind, raw);
    const key = recordKey(kind, d);
    if (!key) { skipped++; continue; }
    // Two copies in one import: the first value of each field wins, like the merge below.
    byKey.set(key, byKey.has(key) ? { ...d, ...byKey.get(key) } : d);
  }
  const items = [...byKey].map(([key, data]) => ({ key, data, sources: Object.fromEntries(Object.keys(data).map((f) => [f, { source: src, at }])) }));
  if (!items.length) return { added: 0, updated: 0, skipped };
  const before = (await db.prepare('SELECT count(*) AS n FROM audience_records WHERE kind=?1').bind(kind).first()).n;
  if (before >= MAX_RECORDS) fail(400, `${kind === 'people' ? 'People' : 'Companies'} holds up to ${MAX_RECORDS.toLocaleString('en-US')} records`);
  const winner = overwrite ? 'json_patch(audience_records.%s, excluded.%s)' : 'json_patch(excluded.%s, audience_records.%s)';
  const merge = (f) => winner.replaceAll('%s', f);
  const stmts = []; let chunk = []; let size = 0;
  const flush = () => {
    if (!chunk.length) return;
    stmts.push(db.prepare(`INSERT INTO audience_records (kind, key, data, sources, created_at, updated_at)
        SELECT ?1, json_extract(value, '$.key'), json(json_extract(value, '$.data')), json(json_extract(value, '$.sources')), ?2, ?2
          FROM json_each(?3) WHERE true
        ON CONFLICT(kind, key) DO UPDATE SET data=${merge('data')}, sources=${merge('sources')}, updated_at=?2`).bind(kind, at, JSON.stringify(chunk)));
    chunk = []; size = 0;
  };
  for (const it of items) {
    const s = JSON.stringify(it).length;
    if (size + s > 900_000) flush();
    chunk.push(it); size += s;
  }
  flush();
  await db.batch(stmts);
  const after = (await db.prepare('SELECT count(*) AS n FROM audience_records WHERE kind=?1').bind(kind).first()).n;
  return { added: after - before, updated: items.length - (after - before), skipped };
}

/* ---------------------------------------------------------------- filters */

export function checkFilters(kind, filters) {
  if (filters === undefined || filters === null) return [];
  if (!Array.isArray(filters) || filters.length > 20) fail(400, 'Up to 20 filters');
  const keys = fieldKeys(kind);
  return filters.map((f) => {
    if (!keys.includes(f?.field)) fail(400, `Unknown field: ${String(f?.field).slice(0, 40)}`);
    if (!AUD_OPS[f.op]) fail(400, `Unknown filter: ${String(f.op).slice(0, 20)}`);
    if (AUD_NO_VALUE.includes(f.op)) return { field: f.field, op: f.op };
    const value = String(f.value ?? '').trim().slice(0, 200);
    if (!value) fail(400, 'A filter needs a value');
    if (['gt', 'lt'].includes(f.op) && !Number.isFinite(Number(value))) fail(400, 'Greater and less than need a number');
    return { field: f.field, op: f.op, value };
  });
}

/** SQL for one kind's filters. Returns {where, args}; args start at ?2 (?1 is the kind). */
export function filterSql(kind, { q, filters } = {}) {
  const where = ['kind=?1']; const args = [kind];
  const bind = (v) => { args.push(v); return `?${args.length}`; };
  if (q && String(q).trim()) where.push(`instr(lower(data), ${bind(String(q).trim().toLowerCase().slice(0, 100))}) > 0`);
  for (const f of checkFilters(kind, filters)) {
    const e = `json_extract(data, ${bind('$.' + f.field)})`;
    const txt = `lower(coalesce(CAST(${e} AS TEXT), ''))`;
    const v = f.value?.toLowerCase();
    if (f.op === 'contains') where.push(`instr(${txt}, ${bind(v)}) > 0`);
    else if (f.op === 'not_contains') where.push(`instr(${txt}, ${bind(v)}) = 0`);
    else if (f.op === 'equals') where.push(`${txt} = ${bind(v)}`);
    else if (f.op === 'not_equals') where.push(`${txt} <> ${bind(v)}`);
    else if (f.op === 'starts_with') where.push(`substr(${txt}, 1, ${v.length}) = ${bind(v)}`);
    else if (f.op === 'empty') where.push(`trim(${txt}) = ''`);
    else if (f.op === 'not_empty') where.push(`trim(${txt}) <> ''`);
    else if (f.op === 'gt') where.push(`CAST(${e} AS REAL) > ${bind(Number(f.value))}`);
    else if (f.op === 'lt') where.push(`CAST(${e} AS REAL) < ${bind(Number(f.value))}`);
  }
  return { where: where.join(' AND '), args };
}

const rowOut = (r) => ({ id: r.id, data: parseJson(r.data, {}), sources: parseJson(r.sources, {}), created_at: r.created_at, updated_at: r.updated_at });

/** opts: {q, filters, segment_id, sort, dir, limit, offset, ids} */
export async function listRecords(db, kind, opts = {}, { max = MAX_PAGE } = {}) {
  checkKind(kind);
  let filters = opts.filters;
  if (opts.segment_id) {
    const s = await getSegment(db, Number(opts.segment_id));
    if (s.kind !== kind) fail(400, 'That segment is for the other database');
    filters = [...s.filters, ...(filters || [])];
  }
  const { where, args } = filterSql(kind, { q: opts.q, filters });
  let w = where;
  if (Array.isArray(opts.ids)) {
    if (!opts.ids.every(Number.isInteger)) fail(400, 'ids must be whole numbers');
    args.push(JSON.stringify(opts.ids)); w += ` AND id IN (SELECT value FROM json_each(?${args.length}))`;
  }
  const limit = Math.min(max, Math.max(0, Number.isInteger(opts.limit) ? opts.limit : 100));
  const offset = Math.max(0, Number.isInteger(opts.offset) ? opts.offset : 0);
  const sortKey = opts.sort && fieldKeys(kind).includes(opts.sort) ? opts.sort : null;
  const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
  let order = `id ${dir}`;
  if (sortKey) { args.push('$.' + sortKey); order = `json_extract(data, ?${args.length}) IS NULL, json_extract(data, ?${args.length}) ${dir}, id`; }
  const [total, rows] = await Promise.all([
    db.prepare(`SELECT count(*) AS n FROM audience_records WHERE ${w}`).bind(...args.slice(0, sortKey ? -1 : undefined)).first(),
    limit ? db.prepare(`SELECT * FROM audience_records WHERE ${w} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`).bind(...args).all() : { results: [] },
  ]);
  return { total: total.n, records: rows.results.map(rowOut) };
}

export async function getRecord(db, kind, id) {
  checkKind(kind);
  const r = await db.prepare('SELECT * FROM audience_records WHERE kind=?1 AND id=?2').bind(kind, id).first();
  if (!r) fail(404, 'No such record');
  return rowOut(r);
}

/** body: {data: {field: value|null}}. null clears a field. The key follows email/domain edits. */
export async function patchRecord(db, kind, id, body) {
  const rec = await getRecord(db, kind, id);
  const patch = body?.data;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'data must be an object');
  const keys = fieldKeys(kind);
  for (const k of Object.keys(patch)) if (!keys.includes(k)) fail(400, `Unknown field: ${k.slice(0, 40)}`);
  const merged = { ...rec.data };
  for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') delete merged[k]; else merged[k] = v; }
  const data = cleanRecord(kind, merged);
  const key = recordKey(kind, data);
  if (!key) fail(400, kind === 'people' ? 'A person needs an email, or a name plus a company' : 'A company needs a domain or a name');
  const clash = await db.prepare('SELECT id FROM audience_records WHERE kind=?1 AND key=?2 AND id<>?3').bind(kind, key, id).first();
  if (clash) fail(409, 'Another record already has that email or domain');
  const at = nowIso();
  const sources = { ...rec.sources };
  for (const k of Object.keys(patch)) { if (k in data) sources[k] = { source: 'Edited by hand', at }; else delete sources[k]; }
  await db.prepare('UPDATE audience_records SET key=?3, data=?4, sources=?5, updated_at=?6 WHERE kind=?1 AND id=?2')
    .bind(kind, id, key, JSON.stringify(data), JSON.stringify(sources), at).run();
  return getRecord(db, kind, id);
}

export async function deleteRecords(db, kind, body) {
  checkKind(kind);
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 5000 || !ids.every(Number.isInteger)) fail(400, 'ids must be 1 to 5,000 record ids');
  await db.prepare('DELETE FROM audience_records WHERE kind=?1 AND id IN (SELECT value FROM json_each(?2))').bind(kind, JSON.stringify(ids)).run();
  return { deleted: ids.length };
}

/** Counts and how full each field is: the header of the People and Companies pages. */
export async function audienceStats(db) {
  const out = {};
  for (const kind of Object.keys(FIELDS)) {
    const parts = FIELDS[kind].map(([k], i) => `sum(trim(coalesce(CAST(json_extract(data, '$.${k}') AS TEXT), '')) <> '') AS f${i}`);
    const r = await db.prepare(`SELECT count(*) AS n, ${parts.join(', ')} FROM audience_records WHERE kind=?1`).bind(kind).first();
    out[kind] = { total: r.n, filled: Object.fromEntries(FIELDS[kind].map(([k], i) => [k, r[`f${i}`] || 0])) };
  }
  return out;
}

/* ---------------------------------------------------------------- segments */

async function getSegment(db, id) {
  const s = await db.prepare('SELECT * FROM segments WHERE id=?1').bind(id).first();
  if (!s) fail(404, 'No such segment');
  return { ...s, filters: parseJson(s.filters, []) };
}

export async function listSegments(db) {
  const { results } = await db.prepare('SELECT * FROM segments ORDER BY kind, name COLLATE NOCASE, id').all();
  const out = [];
  for (const s of results) {
    const filters = parseJson(s.filters, []);
    let count = null;
    try { count = (await listRecords(db, s.kind, { filters, limit: 0 })).total; } catch { /* a field was renamed since */ }
    out.push({ ...s, filters, count });
  }
  return out;
}

export async function createSegment(db, body) {
  const kind = checkKind(body?.kind);
  const name = String(body?.name || '').trim().slice(0, 80);
  if (!name) fail(400, 'Name the segment');
  const filters = checkFilters(kind, body.filters);
  const n = (await db.prepare('SELECT count(*) AS n FROM segments').first()).n;
  if (n >= MAX_SEGMENTS) fail(400, `Up to ${MAX_SEGMENTS} segments`);
  const at = nowIso();
  const [r] = await db.batch([db.prepare('INSERT INTO segments (kind, name, filters, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4) RETURNING id')
    .bind(kind, name, JSON.stringify(filters), at)]);
  return getSegment(db, r.results[0].id);
}

export async function patchSegment(db, id, body) {
  const s = await getSegment(db, id);
  const name = body?.name !== undefined ? String(body.name).trim().slice(0, 80) : s.name;
  if (!name) fail(400, 'Name the segment');
  const filters = body?.filters !== undefined ? checkFilters(s.kind, body.filters) : s.filters;
  await db.prepare('UPDATE segments SET name=?2, filters=?3, updated_at=?4 WHERE id=?1').bind(id, name, JSON.stringify(filters), nowIso()).run();
  return getSegment(db, id);
}

export async function deleteSegment(db, id) {
  await getSegment(db, id);
  await db.prepare('DELETE FROM segments WHERE id=?1').bind(id).run();
  return { ok: true };
}

/* ---------------------------------------------------------------- tables in and out */

/**
 * Send a table's rows into People or Companies. body: {table_id, map: {field: column key},
 * row_ids?, overwrite?}. With no map, columns are matched by name (guessMap).
 */
export async function fromTable(db, kind, body) {
  checkKind(kind);
  const t = await getTableRow(db, Number(body?.table_id));
  const cols = await loadColumns(db, t.id);
  const map = body.map && typeof body.map === 'object' ? body.map : guessMap(kind, cols);
  const keys = fieldKeys(kind);
  for (const [f, c] of Object.entries(map)) {
    if (!keys.includes(f)) fail(400, `Unknown field: ${f.slice(0, 40)}`);
    if (c && !cols.some((x) => x.key === c)) fail(400, `No column ${String(c).slice(0, 40)} in this table`);
  }
  if (!Object.values(map).some(Boolean)) fail(400, 'Match at least one column to a field');
  let sql = 'SELECT id, data FROM rows WHERE table_id=?1'; const args = [t.id];
  if (Array.isArray(body.row_ids)) {
    if (!body.row_ids.every(Number.isInteger)) fail(400, 'row_ids must be whole numbers');
    sql += ' AND id IN (SELECT value FROM json_each(?2))'; args.push(JSON.stringify(body.row_ids));
  }
  const { results } = await db.prepare(sql + ' ORDER BY id').bind(...args).all();
  const list = results.map((r) => {
    const data = hooks.computeRow({ id: r.id, data: parseJson(r.data, {}) }, cols);
    return Object.fromEntries(Object.entries(map).filter(([, c]) => c).map(([f, c]) => [f, data[c]]));
  });
  return { ...(await upsertRecords(db, kind, list, `Table: ${t.name}`, { overwrite: !!body.overwrite })), map };
}

/** People or Companies into a table (new or existing). body: {ids? | q?, filters?, segment_id?, table_id? | name?} */
export async function toTable(db, kind, body) {
  checkKind(kind);
  const { records, total } = await listRecords(db, kind, { ...body, limit: MAX_ROWS, offset: 0 }, { max: MAX_ROWS });
  if (!records.length) fail(400, 'No records match');
  let tableId = Number(body.table_id) || null;
  if (tableId) await getTableRow(db, tableId);
  else tableId = (await createTable(db, { name: String(body.name || (kind === 'people' ? 'People' : 'Companies')).slice(0, 80) })).id;
  const present = FIELDS[kind].filter(([k]) => records.some((r) => r.data[k] !== undefined));
  const { cols, keyFor } = await columnsFor(db, tableId, present);
  const rows = records.map((r) => Object.fromEntries(Object.entries(r.data).filter(([f]) => keyFor[f]).map(([f, v]) => [keyFor[f], v])));
  const added = await insertRows(db, tableId, rows, cols);
  if (added) await hooks.afterWrite(db, tableId, { newRows: true });
  return { table_id: tableId, added, total };
}

/** A CSV straight into People or Companies; headers matched to fields by name. */
export async function importAudienceCsv(db, kind, text, name = 'CSV') {
  checkKind(kind);
  const rows = parseCsv(text);
  if (rows.length < 2) fail(400, 'The file needs a header row and at least one row');
  if (rows.length - 1 > MAX_IMPORT_ROWS) fail(400, `Up to ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows per file`);
  const headers = rows[0].map((h, i) => ({ key: `c${i}`, name: h }));
  const map = guessMap(kind, headers);
  if (!Object.keys(map).length) fail(400, 'None of the headers match a field. Name them like Email, Name, Company, Domain, Phone.');
  const list = rows.slice(1).map((r) => Object.fromEntries(Object.entries(map).map(([f, c]) => [f, r[Number(c.slice(1))]])));
  return { ...(await upsertRecords(db, kind, list, `CSV: ${String(name).slice(0, 60)}`)), matched: Object.keys(map) };
}
