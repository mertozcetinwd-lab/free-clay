/**
 * Pick a value out of JSON with a simple path: "data.email", "$.results[0].url", 'a["odd key"]'.
 * Own properties only, so a path can never reach an object's prototype. No filters, no wildcards:
 * enough for API responses, small enough to trust.
 */

export function parsePath(path) {
  const s = String(path || '').trim().replace(/^\$\.?/, '');
  const parts = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\["([^"]*)"\]|\['([^']*)'\]/g;
  let m; let last = 0;
  while ((m = re.exec(s))) {
    const gap = s.slice(last, m.index).replace(/\./g, '');
    if (gap) throw new Error(`Bad path near "${gap}"`);
    parts.push(m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3] ?? m[4]));
    last = re.lastIndex;
  }
  if (s.slice(last).replace(/\./g, '')) throw new Error('Bad path');
  return parts;
}

export function getPath(obj, path) {
  let cur = obj;
  for (const k of parsePath(path)) {
    if (cur === null || typeof cur !== 'object') return null;
    if (Array.isArray(cur) && typeof k === 'string' && /^\d+$/.test(k)) { cur = cur[Number(k)]; continue; }
    if (!Object.hasOwn(cur, k)) return null;
    cur = cur[k];
  }
  return cur === undefined ? null : cur;
}
