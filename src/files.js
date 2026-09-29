/**
 * Folders and the trash (LOAM-PLAN.md phase 3).
 *
 * Deleting a table only stamps tables.deleted_at (tables.js, deleteTable), so it can come back.
 * After TRASH_DAYS the cron purges it for real; "Delete forever" does the same at once. The ledger
 * is never purged: what a table cost stays in the spend report after the table is gone.
 */

import { fail, nowIso } from './util.js';

export const TRASH_DAYS = 30;
const PURGE_PER_TICK = 2;   // each purge is one 7-statement batch; keeps the cron well inside 50 queries

/* ---------------------------------------------------------------- folders */

function folderName(body) {
  const name = String(body?.name ?? '').trim().slice(0, 80);
  if (!name) fail(400, 'A folder needs a name');
  return name;
}

export async function createFolder(db, body) {
  const name = folderName(body);
  const r = await db.prepare('INSERT INTO folders (name, created_at) VALUES (?1, ?2) RETURNING id').bind(name, nowIso()).first();
  return { id: r.id, name };
}

async function getFolder(db, id) {
  const f = await db.prepare('SELECT * FROM folders WHERE id=?1').bind(id).first();
  if (!f) fail(404, 'No such folder');
  return f;
}

export async function patchFolder(db, id, body) {
  await getFolder(db, id);
  await db.prepare('UPDATE folders SET name=?2 WHERE id=?1').bind(id, folderName(body)).run();
  return { ok: true };
}

/** Removing a folder never deletes a table: its tables move back to the top level. */
export async function deleteFolder(db, id) {
  await getFolder(db, id);
  await db.batch([
    db.prepare('UPDATE tables SET folder_id=NULL WHERE folder_id=?1').bind(id),
    db.prepare('DELETE FROM folders WHERE id=?1').bind(id),
  ]);
  return { ok: true };
}

/** Called from patchTable for {folder_id}. null = top level. */
export async function moveTable(db, tableId, folderId) {
  if (folderId !== null && !Number.isInteger(folderId)) fail(400, 'folder_id must be a folder id or null');
  if (folderId !== null) await getFolder(db, folderId);
  await db.prepare('UPDATE tables SET folder_id=?2 WHERE id=?1').bind(tableId, folderId).run();
}

/* ---------------------------------------------------------------- trash */

export async function listTrash(db) {
  const { results } = await db.prepare(`SELECT t.id, t.name, t.deleted_at,
      (SELECT count(*) FROM rows r WHERE r.table_id=t.id) AS row_count
      FROM tables t WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC`).all();
  return { days: TRASH_DAYS, tables: results };
}

async function trashed(db, id) {
  const t = await db.prepare('SELECT id, folder_id FROM tables WHERE id=?1 AND deleted_at IS NOT NULL').bind(id).first();
  if (!t) fail(404, 'That table is not in the trash');
  return t;
}

/** Runs stopped at delete time stay stopped; the table comes back as it was, minus the queue. */
export async function restoreTable(db, id) {
  const t = await trashed(db, id);
  // Its folder may have been removed while it sat in the trash; then it comes back to the top level.
  const keep = t.folder_id && await db.prepare('SELECT 1 AS ok FROM folders WHERE id=?1').bind(t.folder_id).first();
  await db.prepare('UPDATE tables SET deleted_at=NULL, folder_id=?2, updated_at=?3 WHERE id=?1').bind(id, keep ? t.folder_id : null, nowIso()).run();
  return { ok: true };
}

/** Children first, so this works whether or not D1 enforces the ON DELETE CASCADE clauses. */
function purgeStmts(db, id) {
  return [
    db.prepare('DELETE FROM cells_meta WHERE row_id IN (SELECT id FROM rows WHERE table_id=?1)').bind(id),
    db.prepare('DELETE FROM cell_jobs WHERE table_id=?1').bind(id),
    db.prepare('DELETE FROM runs WHERE table_id=?1').bind(id),
    db.prepare('DELETE FROM views WHERE table_id=?1').bind(id),
    db.prepare('DELETE FROM rows WHERE table_id=?1').bind(id),
    db.prepare('DELETE FROM columns WHERE table_id=?1').bind(id),
    db.prepare('DELETE FROM tables WHERE id=?1 AND deleted_at IS NOT NULL').bind(id),
  ];
}

export async function purgeTable(db, id) {
  await trashed(db, id);
  await db.batch(purgeStmts(db, id));
  return { ok: true };
}

/** The cron's share: purge tables that have been in the trash longer than TRASH_DAYS. */
export async function purgeExpired(db, now = Date.now()) {
  const cutoff = new Date(now - TRASH_DAYS * 86400_000).toISOString();
  const { results } = await db.prepare('SELECT id FROM tables WHERE deleted_at IS NOT NULL AND deleted_at < ?1 ORDER BY deleted_at LIMIT ?2')
    .bind(cutoff, PURGE_PER_TICK).all();
  for (const { id } of results) await db.batch(purgeStmts(db, id));
  return { purged: results.map((r) => r.id) };
}
