// Migration 0007 rebuilds `columns` (to allow 'message'). cells_meta points at it ON DELETE CASCADE,
// so a careless rebuild wipes every cell's status and result. This builds a database the way an
// install made before 0007 looks, fills it, applies 0007, and checks nothing was lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

test('migration 0007 keeps every column, cell status and result, and allows message columns', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');   // D1 enforces foreign keys
  const oldSchema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8').replace("'ai', 'http', 'message')", "'ai', 'http')");
  db.exec(oldSchema);
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files.filter((f) => f < '0007')) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  assert.throws(() => db.exec(`INSERT INTO tables (name, created_at, updated_at) VALUES ('x','t','t'); INSERT INTO columns (table_id, key, name, kind, created_at) VALUES (1, 'm', 'M', 'message', 't')`), /CHECK/);
  db.exec(`INSERT INTO rows (table_id, data, created_at, updated_at) VALUES (1, '{"a":1}', 't', 't'), (1, '{"a":2}', 't', 't');
    INSERT INTO columns (table_id, key, name, kind, config, created_at, description, pinned) VALUES (1, 'a', 'A', 'data', '{}', 't', 'desc', 1), (1, 'b', 'B', 'enrich', '{"fn":"x"}', 't', NULL, 0);
    INSERT INTO cells_meta (row_id, column_id, status, provider, cost_micros, result, updated_at) VALUES (1, 2, 'done', 'x', 1900, '{"v":1}', 't'), (2, 2, 'error', 'x', 0, NULL, 't');`);
  const before = { cols: db.prepare('SELECT * FROM columns ORDER BY id').all(), cells: db.prepare('SELECT * FROM cells_meta ORDER BY row_id').all() };
  db.exec(readFileSync(new URL('0007_message_kind.sql', dir), 'utf8'));
  assert.deepEqual(db.prepare('SELECT * FROM columns ORDER BY id').all(), before.cols);
  assert.deepEqual(db.prepare('SELECT * FROM cells_meta ORDER BY row_id').all(), before.cells);
  db.exec(`INSERT INTO columns (table_id, key, name, kind, created_at) VALUES (1, 'm', 'M', 'message', 't')`);
  assert.equal(db.prepare(`SELECT id FROM columns WHERE key='m'`).get().id, 3);   // ids carry on
  db.exec('DELETE FROM columns WHERE id = 2');                                     // the cascade still works
  assert.equal(db.prepare('SELECT count(*) n FROM cells_meta').get().n, 0);
  assert.equal(db.prepare(`SELECT count(*) n FROM sqlite_master WHERE name IN ('cells_meta_keep','columns_new')`).get().n, 0);
});
