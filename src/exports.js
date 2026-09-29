/**
 * Exports (LOAM-PLAN.md phase 11; Clay's Exports page, teardown-v2 section 7): every CSV download
 * is listed for 30 days and can be downloaded again exactly as it was. The file itself is kept
 * when it is under 1.5 MB (a D1 row must stay under 2 MB); a bigger one is listed and re-made
 * from the table's current rows on request, and the page says so.
 */

import { fail, nowIso } from './util.js';
import { exportCsv, getTableRow } from './tables.js';

export const EXPORT_DAYS = 30;
const KEEP_BYTES = 1_500_000;

/** Make a table's CSV and record it. Returns {csv, name}. */
export async function exportAndRecord(db, tableId) {
  const t = await getTableRow(db, tableId);
  const csv = await exportCsv(db, tableId);
  const rows = Math.max(0, csv.split('\r\n').length - 2);
  const bytes = new TextEncoder().encode(csv).length;
  const name = `${t.name.replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'table'}-${nowIso().slice(0, 10)}.csv`;
  await db.prepare('INSERT INTO exports (table_id, name, rows, bytes, csv, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(tableId, name, rows, bytes, bytes <= KEEP_BYTES ? csv : null, nowIso()).run();
  return { csv, name };
}

export async function listExports(db) {
  const { results } = await db.prepare(`SELECT e.id, e.table_id, e.name, e.rows, e.bytes, e.csv IS NOT NULL AS kept, e.created_at,
      t.name AS table_name, t.deleted_at IS NOT NULL AS table_deleted FROM exports e LEFT JOIN tables t ON t.id=e.table_id ORDER BY e.id DESC LIMIT 200`).all();
  return { days: EXPORT_DAYS, exports: results.map((r) => ({ ...r, kept: !!r.kept, table_deleted: !!r.table_deleted })) };
}

/** The kept file, or the table's CSV as it is now when the file was too big to keep. */
export async function downloadExport(db, id) {
  const e = await db.prepare('SELECT * FROM exports WHERE id=?1').bind(id).first();
  if (!e) fail(404, 'No such export');
  if (e.csv !== null) return { csv: e.csv, name: e.name };
  if (!e.table_id) fail(410, 'That file was too big to keep and its table is gone');
  return { csv: await exportCsv(db, e.table_id), name: e.name.replace(/\.csv$/, '-now.csv') };
}

export async function deleteExport(db, id) {
  await db.prepare('DELETE FROM exports WHERE id=?1').bind(id).run();
  return { ok: true };
}

export async function purgeExports(db, now = Date.now()) {
  await db.prepare('DELETE FROM exports WHERE created_at < ?1').bind(new Date(now - EXPORT_DAYS * 86400_000).toISOString()).run();
}
