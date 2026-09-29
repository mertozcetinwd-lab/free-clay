-- Phase 6 of LOAM-PLAN.md: answers from open-data services, kept so the same search costs no
-- request the second time (Nominatim's terms require caching; Overpass asks for restraint).
-- The cron removes expired entries (src/opendata/cache.js, sweepCache).
CREATE TABLE IF NOT EXISTS data_cache (
  source      TEXT NOT NULL,
  key         TEXT NOT NULL,
  payload     TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (source, key)
);
CREATE INDEX IF NOT EXISTS idx_data_cache_expires ON data_cache(expires_at);
