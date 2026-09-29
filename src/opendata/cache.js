/**
 * The open-data cache. cached(source, key, ttl, fn) returns a stored answer while it is fresh and
 * otherwise calls fn once and stores what it returns. Keys are the query itself as JSON, so two
 * identical searches share an entry. Failures are never stored.
 */

import { parseJson } from '../util.js';

export const DAY = 86400_000;

/** replace: skip the lookup and overwrite (fresh data the caller already has, like a browser search). */
export async function cached(db, source, key, ttlMs, fn, now = Date.now(), { replace = false } = {}) {
  if (!replace) {
    const hit = await peek(db, source, key, now);
    if (hit !== null) return { value: hit, cached: true };
  }
  const value = await fn();
  await db.prepare(`INSERT INTO data_cache (source, key, payload, fetched_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT(source, key) DO UPDATE SET payload=excluded.payload, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at`)
    .bind(source, key, JSON.stringify(value), new Date(now).toISOString(), new Date(now + ttlMs).toISOString()).run();
  return { value, cached: false };
}

/** A fresh cached answer, or null. */
export async function peek(db, source, key, now = Date.now()) {
  const hit = await db.prepare('SELECT payload FROM data_cache WHERE source=?1 AND key=?2 AND expires_at > ?3')
    .bind(source, key, new Date(now).toISOString()).first();
  return hit ? parseJson(hit.payload, null) : null;
}

/** The cron's share: drop expired entries, a bounded number per tick. */
export async function sweepCache(db, now = Date.now()) {
  await db.prepare('DELETE FROM data_cache WHERE rowid IN (SELECT rowid FROM data_cache WHERE expires_at <= ?1 LIMIT 500)')
    .bind(new Date(now).toISOString()).run();
}
