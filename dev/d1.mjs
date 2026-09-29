/**
 * A minimal D1 over node:sqlite (Node 22.5+): prepare/bind/first/all/run and an atomic batch()
 * with RETURNING. Used by the tests and by the no-wrangler preview (dev/preview.mjs).
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

export function makeD1(file = ':memory:') {
  const sql = new DatabaseSync(file);
  sql.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  // Then every migration not yet applied, recorded in d1_migrations the way wrangler does it, so a
  // saved preview database upgrades itself and never runs a migration twice.
  sql.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)`);
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (sql.prepare('SELECT 1 FROM d1_migrations WHERE name=?').get(name)) continue;
    sql.exec(readFileSync(new URL(name, dir), 'utf8'));
    sql.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  }
  let queries = 0;
  const prepare = (text) => {
    let args = [];
    const s = {
      bind(...v) { args = v; return s; },
      async run() { queries++; sql.prepare(text).run(...args); return { success: true }; },
      async first() { queries++; return sql.prepare(text).get(...args) ?? null; },
      async all() { queries++; return { results: sql.prepare(text).all(...args) }; },
      runSync() {
        queries++;
        if (/RETURNING/i.test(text)) return { results: sql.prepare(text).all(...args) };
        sql.prepare(text).run(...args); return { results: [] };
      },
    };
    return s;
  };
  const DB = {
    prepare,
    async batch(stmts) {
      sql.exec('BEGIN');
      try { const r = stmts.map((x) => x.runSync()); sql.exec('COMMIT'); return r; }
      catch (e) { sql.exec('ROLLBACK'); throw e; }
    },
    /** Statements run since the last reset: D1 allows 50 per invocation on the free plan. */
    get queries() { return queries; },
    resetQueries() { queries = 0; },
  };
  return { sql, DB };
}
