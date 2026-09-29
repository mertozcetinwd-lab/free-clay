/**
 * Tables, columns, rows, views and CSV in/out.
 *
 * CPU note. The free plan gives a Worker 10 ms of CPU per request (developers.cloudflare.com/
 * workers/platform/limits, read 2026-09-27), and JSON.parse on 5,000 rows can eat most of that.
 * So the big read (a whole table) is assembled as JSON by SQLite itself (json_group_array) and
 * passed through as one string: the Worker never parses a row it only has to send.
 */

import { fail, nowIso, parseJson, slug } from './util.js';
import { TYPES, KINDS, coerce, inferType } from '../public/js/types.js';
import { parseCsv, csvCell, mapHeaders, MAX_IMPORT_ROWS } from './csv.js';
import { moveTable } from './files.js';

export const MAX_ROWS = 20000;           // per table; above this a browser grid stops being pleasant
const KEY_RE = /^[a-z0-9_]{1,40}$/;

/* ---------------------------------------------------------------- tables */

export async function getTableRow(db, id) {
  const t = await db.prepare('SELECT * FROM tables WHERE id=?1 AND deleted_at IS NULL').bind(id).first();
  if (!t) fail(404, 'No such table');
  return t;
}

export async function loadColumns(db, tableId) {
  const { results } = await db.prepare('SELECT * FROM columns WHERE table_id=?1 ORDER BY position, id').bind(tableId).all();
  return results.map((c) => ({ ...c, config: parseJson(c.config, {}) }));
}

/** The whole table in one response body. Rows and meta arrive as SQLite-built JSON (see top). */
export async function tableJson(db, id) {
  const t = await getTableRow(db, id);
  // Opening a table is what "Recents" on the home page sorts by.
  await db.prepare('UPDATE tables SET last_opened_at=?2 WHERE id=?1').bind(id, nowIso()).run();
  const [cols, rows, meta, views, running] = await Promise.all([
    loadColumns(db, id),
    db.prepare(`SELECT json_group_array(json_object('id', id, 'data', json(data), 'updated_at', updated_at)) AS j
                  FROM (SELECT id, data, updated_at FROM rows WHERE table_id=?1 ORDER BY id LIMIT ${MAX_ROWS})`).bind(id).first(),
    db.prepare(`SELECT json_group_array(json_object('row_id', m.row_id, 'column_id', m.column_id, 'status', m.status,
                  'provider', m.provider, 'cost_micros', m.cost_micros, 'error', m.error))
                  AS j FROM cells_meta m JOIN rows r ON r.id=m.row_id WHERE r.table_id=?1`).bind(id).first(),
    db.prepare('SELECT * FROM views WHERE table_id=?1 ORDER BY position, id').bind(id).all(),
    db.prepare(`SELECT id, column_id, label, budget_micros, spent_micros, status, created_at FROM runs
                 WHERE table_id=?1 AND status='running' ORDER BY id`).bind(id).all(),
  ]);
  const head = JSON.stringify({
    table: { id: t.id, name: t.name, webhook: !!t.webhook_secret, description: t.description || '', dedupe_key: t.dedupe_key || null, folder_id: t.folder_id || null },
    columns: cols,
    views: views.results.map((v) => ({ ...v, config: parseJson(v.config, {}) })),
    runs: running.results,
  });
  return head.slice(0, -1) + `,"rows":${rows?.j || '[]'},"meta":${meta?.j || '[]'}}`;
}

export async function createTable(db, body) {
  const name = String(body?.name || '').trim().slice(0, 80) || 'Untitled table';
  const now = nowIso();
  const pos = await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tables').first();
  const [res] = await db.batch([db.prepare('INSERT INTO tables (name, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) RETURNING id')
    .bind(name, pos.p, now)]);
  const id = res.results[0].id;
  if (body?.csv) await importCsv(db, id, body.csv);
  else await createColumn(db, id, { name: 'Name', type: 'text' });
  return { id, name };
}

export async function patchTable(db, id, body) {
  await getTableRow(db, id);
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 80);
    if (!name) fail(400, 'A table needs a name');
    await db.prepare('UPDATE tables SET name=?2, updated_at=?3 WHERE id=?1').bind(id, name, nowIso()).run();
  }
  if (body.favorite !== undefined) {
    if (typeof body.favorite !== 'boolean') fail(400, 'favorite must be true or false');
    await db.prepare('UPDATE tables SET favorite=?2 WHERE id=?1').bind(id, body.favorite ? 1 : 0).run();
  }
  if (body.folder_id !== undefined) await moveTable(db, id, body.folder_id);
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') fail(400, 'description must be text');
    await db.prepare('UPDATE tables SET description=?2 WHERE id=?1').bind(id, body.description ? body.description.trim().slice(0, 500) : null).run();
  }
  if (body.dedupe_key !== undefined) {
    const key = body.dedupe_key;
    if (key !== null) await columnKeyIn(db, id, key);
    await db.prepare('UPDATE tables SET dedupe_key=?2 WHERE id=?1').bind(id, key).run();
    if (key !== null) return { ok: true, removed: await dedupeRows(db, id, key) };
  }
  return { ok: true };
}

async function columnKeyIn(db, tableId, key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) fail(400, 'Pick a column');
  const c = await db.prepare('SELECT id FROM columns WHERE table_id=?1 AND key=?2').bind(tableId, key).first();
  if (!c) fail(400, 'That column is not in this table');
}

/**
 * Remove rows whose value in `key` repeats an older row's, keeping the oldest (lowest id).
 * Values compare trimmed and case-blind; empty values never count as duplicates. GROUP BY keeps
 * it one pass over the table even at 20,000 rows, where comparing row pairs would not finish.
 */
export async function dedupeRows(db, tableId, key) {
  const path = `$."${key}"`;
  const filled = `trim(coalesce(json_extract(data, ?2), '')) <> ''`;
  const doomed = `SELECT id FROM rows WHERE table_id=?1 AND ${filled} AND id NOT IN
    (SELECT min(id) FROM rows WHERE table_id=?1 AND ${filled} GROUP BY lower(trim(json_extract(data, ?2))))`;
  const n = (await db.prepare(`SELECT count(*) AS n FROM (${doomed})`).bind(tableId, path).first()).n;
  if (!n) return 0;
  await db.batch([
    db.prepare(`UPDATE cell_jobs SET status='cancelled', claim=NULL WHERE table_id=?1 AND status IN ('queued','running') AND row_id IN (${doomed})`).bind(tableId, path),
    db.prepare(`DELETE FROM cells_meta WHERE row_id IN (${doomed})`).bind(tableId, path),
    db.prepare(`DELETE FROM rows WHERE id IN (${doomed})`).bind(tableId, path),
  ]);
  return n;
}

export async function dedupeTable(db, tableId, body) {
  await getTableRow(db, tableId);
  await columnKeyIn(db, tableId, body?.key);
  return { removed: await dedupeRows(db, tableId, body.key) };
}

export async function deleteTable(db, id) {
  await getTableRow(db, id);
  await db.batch([
    db.prepare('UPDATE tables SET deleted_at=?2 WHERE id=?1').bind(id, nowIso()),
    db.prepare(`UPDATE cell_jobs SET status='cancelled', claim=NULL WHERE table_id=?1 AND status IN ('queued','running')`).bind(id),
    db.prepare(`UPDATE runs SET status='stopped', finished_at=?2 WHERE table_id=?1 AND status='running'`).bind(id, nowIso()),
  ]);
  return { ok: true };
}

/* ---------------------------------------------------------------- columns */

/** Per-kind config checks live with each kind's code; they register here so this file stays generic. */
export const CONFIG_CHECKS = {};

function checkColumn(kind, type, config) {
  if (!KINDS[kind]) fail(400, `Unknown column kind: ${kind}`);
  if (!TYPES[type]) fail(400, `Unknown column type: ${type}`);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) fail(400, 'Column config must be an object');
  if (JSON.stringify(config).length > 50_000) fail(400, 'Column config is too large');
  if (CONFIG_CHECKS[kind]) CONFIG_CHECKS[kind](config);
}

export async function uniqueKey(db, tableId, name) {
  const base = slug(name);
  const { results } = await db.prepare('SELECT key FROM columns WHERE table_id=?1').bind(tableId).all();
  const taken = new Set(results.map((r) => r.key));
  let key = base; let n = 2;
  while (taken.has(key)) key = `${base.slice(0, 36)}_${n++}`;
  return key;
}

export async function createColumn(db, tableId, body) {
  await getTableRow(db, tableId);
  const name = String(body?.name || '').trim().slice(0, 80);
  if (!name) fail(400, 'A column needs a name');
  const kind = body.kind || 'data';
  const type = body.type || 'text';
  const config = body.config || {};
  checkColumn(kind, type, config);
  const key = await uniqueKey(db, tableId, name);
  const extra = columnExtras(body);
  // position (Insert left / right, Duplicate): renumber every column 0..n with a gap at the spot,
  // because positions from older tables can repeat; otherwise the column goes last.
  const stmts = [];
  let pos;
  if (body.position !== undefined && body.position !== null) {
    if (!Number.isInteger(body.position) || body.position < 0) fail(400, 'position must be 0 or more');
    const { results } = await db.prepare('SELECT id FROM columns WHERE table_id=?1 ORDER BY position, id').bind(tableId).all();
    pos = Math.min(body.position, results.length);
    results.forEach((r, i) => stmts.push(db.prepare('UPDATE columns SET position=?2 WHERE id=?1').bind(r.id, i < pos ? i : i + 1)));
  } else {
    pos = (await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM columns WHERE table_id=?1').bind(tableId).first()).p;
  }
  stmts.push(db.prepare(`INSERT INTO columns (table_id, key, name, kind, type, config, position, created_at, description, color, width)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING *`)
    .bind(tableId, key, name, kind, type, JSON.stringify(config), pos, nowIso(), extra.description ?? null, extra.color ?? null, body.width ?? null));
  const res = await db.batch(stmts);
  const c = res[res.length - 1].results[0];
  return { ...c, config: parseJson(c.config, {}) };
}

export const COLUMN_COLORS = ['blue', 'violet', 'green', 'amber', 'red', 'pink', 'teal', 'gray'];

/** Description, color and pin: set from the column header menu (Clay's 5.5). */
function columnExtras(body) {
  const out = {};
  if (body?.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') fail(400, 'description must be text');
    out.description = body.description ? body.description.trim().slice(0, 300) : null;
  }
  if (body?.color !== undefined) {
    if (body.color !== null && !COLUMN_COLORS.includes(body.color)) fail(400, `color must be one of ${COLUMN_COLORS.join(', ')}`);
    out.color = body.color;
  }
  if (body?.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') fail(400, 'pinned must be true or false');
    out.pinned = body.pinned ? 1 : 0;
  }
  return out;
}

/**
 * A copy of a column, placed right after it. The settings always come along; the values come
 * along for data columns only. A computed column's copy starts empty, ready to run.
 */
export async function duplicateColumn(db, id) {
  const c = await getColumn(db, id);
  const { results } = await db.prepare('SELECT id FROM columns WHERE table_id=?1 ORDER BY position, id').bind(c.table_id).all();
  const copy = await createColumn(db, c.table_id, {
    name: `${c.name} (copy)`.slice(0, 80), kind: c.kind, type: c.type, config: c.config,
    description: c.description, color: c.color, width: c.width, position: results.findIndex((r) => r.id === id) + 1,
  });
  if (c.kind === 'data') {
    // data -> path copies the value as JSON, so an object or list stays one.
    await db.prepare('UPDATE rows SET data=json_set(data, ?3, data -> ?2) WHERE table_id=?1 AND json_type(data, ?2) IS NOT NULL')
      .bind(c.table_id, `$."${c.key}"`, `$."${copy.key}"`).run();
  }
  return copy;
}

export async function getColumn(db, id) {
  const c = await db.prepare('SELECT * FROM columns WHERE id=?1').bind(id).first();
  if (!c) fail(404, 'No such column');
  return { ...c, config: parseJson(c.config, {}) };
}

export async function patchColumn(db, id, body) {
  const c = await getColumn(db, id);
  const name = body.name !== undefined ? String(body.name).trim().slice(0, 80) : c.name;
  if (!name) fail(400, 'A column needs a name');
  const type = body.type ?? c.type;
  const config = body.config ?? c.config;
  checkColumn(c.kind, type, config);
  const width = body.width === undefined ? c.width : body.width === null ? null : Math.max(60, Math.min(800, Math.round(Number(body.width)) || 200));
  const x = { description: c.description, color: c.color, pinned: c.pinned, ...columnExtras(body) };
  await db.prepare('UPDATE columns SET name=?2, type=?3, config=?4, width=?5, description=?6, color=?7, pinned=?8 WHERE id=?1')
    .bind(id, name, type, JSON.stringify(config), width, x.description ?? null, x.color ?? null, x.pinned ?? 0).run();
  return getColumn(db, id);
}

export async function deleteColumn(db, id) {
  const c = await getColumn(db, id);
  await db.batch([
    db.prepare(`UPDATE cell_jobs SET status='cancelled', claim=NULL WHERE column_id=?1 AND status IN ('queued','running')`).bind(id),
    db.prepare('DELETE FROM cells_meta WHERE column_id=?1').bind(id),
    db.prepare('UPDATE rows SET data=json_remove(data, ?2) WHERE table_id=?1').bind(c.table_id, `$."${c.key}"`),
    db.prepare('DELETE FROM columns WHERE id=?1').bind(id),
    db.prepare('UPDATE tables SET dedupe_key=NULL WHERE id=?1 AND dedupe_key=?2').bind(c.table_id, c.key),
  ]);
  return { ok: true };
}

export async function reorderColumns(db, tableId, ids) {
  if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x))) fail(400, 'ids must be a list of column ids');
  await db.batch(ids.map((cid, i) => db.prepare('UPDATE columns SET position=?3 WHERE id=?1 AND table_id=?2').bind(cid, tableId, i)));
  return { ok: true };
}

/* ---------------------------------------------------------------- rows */

/**
 * Coerce a {key: value} patch against the table's columns. Unknown keys and formula columns are
 * dropped (a formula is computed on read, there is nothing to store). null clears a cell.
 */
export function cleanValues(values, cols) {
  const byKey = new Map(cols.map((c) => [c.key, c]));
  const out = {};
  for (const [k, v] of Object.entries(values || {})) {
    const c = byKey.get(k);
    if (!c || c.kind === 'formula') continue;
    out[k] = coerce(c.type, v);
  }
  return out;
}

/**
 * One UPDATE that sets and clears keys inside rows.data. json_set / json_remove run inside SQLite,
 * so two writers touching different keys of the same row (a run and a person typing) never
 * overwrite each other's cells. Paths are bound parameters, never spliced into the SQL.
 */
export function setValuesStmt(db, rowId, values, now = nowIso()) {
  const sets = []; const dels = [];
  for (const [k, v] of Object.entries(values)) {
    if (!KEY_RE.test(k)) fail(400, `Bad column key: ${k}`);
    (v === null || v === undefined ? dels : sets).push([`$."${k}"`, v]);
  }
  const args = [rowId, now];
  let expr = 'data';
  if (sets.length) {
    expr = `json_set(${expr}, ${sets.map(([p, v]) => { args.push(p, JSON.stringify(v)); return `?${args.length - 1}, json(?${args.length})`; }).join(', ')})`;
  }
  if (dels.length) {
    expr = `json_remove(${expr}, ${dels.map(([p]) => { args.push(p); return `?${args.length}`; }).join(', ')})`;
  }
  if (args.length > 100) fail(400, 'Too many cells in one update');   // D1 binds at most 100 parameters
  return db.prepare(`UPDATE rows SET data=${expr}, updated_at=?2 WHERE id=?1`).bind(...args);
}

export async function insertRows(db, tableId, list, cols) {
  const count = await db.prepare('SELECT count(*) AS n FROM rows WHERE table_id=?1').bind(tableId).first();
  if (count.n + list.length > MAX_ROWS) fail(400, `A table holds up to ${MAX_ROWS.toLocaleString('en-US')} rows`);
  const now = nowIso();
  const clean = list.map((v) => Object.fromEntries(Object.entries(cleanValues(v, cols)).filter(([, x]) => x !== null)));
  // One statement per ~900 KB: json_each turns a bound JSON array into rows inside SQLite, so a
  // 5,000-row import is a handful of statements, not 5,000 (D1 counts queries per invocation).
  const stmts = []; let chunk = []; let size = 0;
  const flush = () => {
    if (!chunk.length) return;
    stmts.push(db.prepare(`INSERT INTO rows (table_id, data, created_at, updated_at)
                           SELECT ?1, value, ?2, ?2 FROM json_each(?3)`).bind(tableId, now, JSON.stringify(chunk)));
    chunk = []; size = 0;
  };
  for (const r of clean) {
    const s = JSON.stringify(r).length;
    if (size + s > 900_000) flush();
    chunk.push(r); size += s;
  }
  flush();
  if (stmts.length) await db.batch(stmts);
  // Auto-dedupe (Table settings): every way rows arrive comes through here, so it is enforced once.
  const t = await db.prepare('SELECT dedupe_key FROM tables WHERE id=?1').bind(tableId).first();
  const removed = t?.dedupe_key ? await dedupeRows(db, tableId, t.dedupe_key) : 0;
  return clean.length - removed;
}

export async function createRows(db, tableId, body) {
  await getTableRow(db, tableId);
  const list = Array.isArray(body?.rows) ? body.rows : [body?.data || {}];
  if (list.length > MAX_IMPORT_ROWS) fail(400, `Up to ${MAX_IMPORT_ROWS} rows per request`);
  const cols = await loadColumns(db, tableId);
  const before = (await db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM rows').first()).m;
  const n = await insertRows(db, tableId, list, cols);
  if (n) await hooks.afterWrite(db, tableId, { newRows: true });
  // By id, not "the last n": auto-dedupe may have removed some of the rows just sent.
  const { results } = await db.prepare('SELECT id, data, updated_at FROM rows WHERE table_id=?1 AND id > ?2 ORDER BY id').bind(tableId, before).all();
  return { added: n, rows: results.map((r) => ({ ...r, data: parseJson(r.data, {}) })) };
}

export async function getRow(db, id) {
  const r = await db.prepare('SELECT * FROM rows WHERE id=?1').bind(id).first();
  if (!r) fail(404, 'No such row');
  return { ...r, data: parseJson(r.data, {}) };
}

export async function patchRow(db, id, body) {
  const row = await getRow(db, id);
  const cols = await loadColumns(db, row.table_id);
  const values = cleanValues(body?.data, cols);
  if (Object.keys(values).length) {
    await setValuesStmt(db, id, values).run();
    await hooks.afterWrite(db, row.table_id, { rowIds: [id], changed: Object.keys(values) });
  }
  return getRow(db, id);
}

export const MAX_BULK_ROWS = 2000;

/**
 * Paste, fill down, clear a range and undo all land here: many rows, many cells, one statement.
 * D1 allows 50 queries per request on the free plan, so a row-by-row loop would stop at 50 rows.
 * Two JSON Merge Patches per row: the first nulls every written key (removing it), the second
 * sets the new values. Nulling first makes an object value replace, never merge into, the old one.
 */
export async function patchRows(db, tableId, body) {
  await getTableRow(db, tableId);
  const list = body?.rows;
  if (!Array.isArray(list) || !list.length) fail(400, 'rows must be a list of {id, data}');
  if (list.length > MAX_BULK_ROWS) fail(400, `Up to ${MAX_BULK_ROWS} rows per update`);
  const cols = await loadColumns(db, tableId);
  const clears = {}; const sets = {}; const touched = new Set();
  for (const r of list) {
    if (!Number.isInteger(r?.id)) fail(400, 'Each row needs a numeric id');
    const values = cleanValues(r.data, cols);
    const keys = Object.keys(values);
    if (!keys.length) continue;
    keys.forEach((k) => touched.add(k));
    clears[r.id] = Object.fromEntries(keys.map((k) => [k, null]));
    sets[r.id] = Object.fromEntries(keys.filter((k) => values[k] !== null && values[k] !== undefined).map((k) => [k, values[k]]));
  }
  const ids = Object.keys(clears);
  if (!ids.length) return { updated: 0, rows: [] };
  const clearJson = JSON.stringify(clears); const setJson = JSON.stringify(sets);
  if (clearJson.length + setJson.length > 2_000_000) fail(413, 'That paste is too large. Paste fewer cells at a time.');
  await db.prepare(`UPDATE rows SET updated_at=?4,
      data = json_patch(json_patch(data, json_extract(?2, '$."' || id || '"')), json_extract(?3, '$."' || id || '"'))
      WHERE table_id=?1 AND id IN (SELECT CAST(key AS INTEGER) FROM json_each(?2))`).bind(tableId, clearJson, setJson, nowIso()).run();
  const { results } = await db.prepare(`SELECT id, data, updated_at FROM rows WHERE table_id=?1 AND id IN (SELECT CAST(key AS INTEGER) FROM json_each(?2)) ORDER BY id`)
    .bind(tableId, clearJson).all();
  if (results.length) await hooks.afterWrite(db, tableId, { rowIds: results.map((r) => r.id), changed: [...touched] });
  return { updated: results.length, rows: results.map((r) => ({ ...r, data: parseJson(r.data, {}) })) };
}

export async function deleteRows(db, tableId, body) {
  const ids = body?.ids;
  if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x))) fail(400, 'ids must be a list of row ids');
  const list = JSON.stringify(ids);
  await db.batch([
    db.prepare(`UPDATE cell_jobs SET status='cancelled', claim=NULL WHERE table_id=?1 AND status IN ('queued','running')
                  AND row_id IN (SELECT value FROM json_each(?2))`).bind(tableId, list),
    db.prepare('DELETE FROM cells_meta WHERE row_id IN (SELECT id FROM rows WHERE table_id=?1 AND id IN (SELECT value FROM json_each(?2)))').bind(tableId, list),
    db.prepare('DELETE FROM rows WHERE table_id=?1 AND id IN (SELECT value FROM json_each(?2))').bind(tableId, list),
  ]);
  return { deleted: ids.length };
}

/* ---------------------------------------------------------------- CSV */

export async function importCsv(db, tableId, text) {
  await getTableRow(db, tableId);
  const grid = parseCsv(text);
  if (grid.length < 2) fail(400, 'That file has a header row but no data');
  const [headers, ...body] = grid;
  if (body.length > MAX_IMPORT_ROWS) fail(400, `Up to ${MAX_IMPORT_ROWS.toLocaleString('en-US')} rows per import. Split the file.`);
  let cols = await loadColumns(db, tableId);
  let mapped = mapHeaders(headers, cols);
  // A new table starts with one empty "Name" column. If the first import does not fill it, it
  // would sit there empty forever, so it goes and the file's own columns take its place.
  const rowsNow = (await db.prepare('SELECT count(*) AS n FROM rows WHERE table_id=?1').bind(tableId).first()).n;
  if (!rowsNow && cols.length === 1 && cols[0].key === 'name' && cols[0].kind === 'data' && !mapped.includes('name')) {
    await db.prepare('DELETE FROM columns WHERE id=?1').bind(cols[0].id).run();
    cols = [];
    mapped = mapHeaders(headers, cols);
  }
  const created = [];
  for (let i = 0; i < headers.length; i++) {
    if (mapped[i] || !String(headers[i]).trim()) continue;
    const col = await createColumn(db, tableId, { name: String(headers[i]).trim(), type: inferType(headers[i], body.map((r) => r[i])) });
    mapped[i] = col.key; created.push(col.name); cols.push(col);
  }
  const list = body.map((r) => Object.fromEntries(mapped.map((k, i) => [k, r[i]]).filter(([k]) => k)));
  const added = await insertRows(db, tableId, list, cols);
  if (added) await hooks.afterWrite(db, tableId, { newRows: true });
  return { added, created_columns: created, mapped: headers.map((h, i) => ({ header: h, column: mapped[i] })) };
}

/** Every column, formula values included (computeFormulas is registered by the formula module). */
export const hooks = {
  computeRow: (row) => row.data,
  /** Called after a person (not a run) writes rows: auto-run registers here (src/auto.js). */
  afterWrite: async () => {},
};

export async function exportCsv(db, tableId) {
  await getTableRow(db, tableId);
  const cols = await loadColumns(db, tableId);
  const { results } = await db.prepare('SELECT id, data FROM rows WHERE table_id=?1 ORDER BY id').bind(tableId).all();
  const lines = [cols.map((c) => csvCell(c.name)).join(',')];
  for (const r of results) {
    const data = hooks.computeRow({ id: r.id, data: parseJson(r.data, {}) }, cols);
    lines.push(cols.map((c) => csvCell(data[c.key])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/* ---------------------------------------------------------------- views */

function checkViewConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) fail(400, 'View config must be an object');
  if (JSON.stringify(cfg).length > 20_000) fail(400, 'View config is too large');
  return cfg;
}

export async function createView(db, tableId, body) {
  await getTableRow(db, tableId);
  const name = String(body?.name || '').trim().slice(0, 60);
  if (!name) fail(400, 'A view needs a name');
  const cfg = checkViewConfig(body.config || {});
  const [res] = await db.batch([db.prepare(`INSERT INTO views (table_id, name, config, position)
      VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(position), -1) + 1 FROM views WHERE table_id=?1)) RETURNING *`).bind(tableId, name, JSON.stringify(cfg))]);
  const v = res.results[0];
  return { ...v, config: parseJson(v.config, {}) };
}

export async function patchView(db, id, body) {
  const v = await db.prepare('SELECT * FROM views WHERE id=?1').bind(id).first();
  if (!v) fail(404, 'No such view');
  const name = body.name !== undefined ? String(body.name).trim().slice(0, 60) : v.name;
  if (!name) fail(400, 'A view needs a name');
  const cfg = body.config !== undefined ? checkViewConfig(body.config) : parseJson(v.config, {});
  await db.prepare('UPDATE views SET name=?2, config=?3 WHERE id=?1').bind(id, name, JSON.stringify(cfg)).run();
  return { ...v, name, config: cfg };
}

export async function deleteView(db, id) {
  await db.prepare('DELETE FROM views WHERE id=?1').bind(id).run();
  return { ok: true };
}
