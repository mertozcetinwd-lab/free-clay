/**
 * Small web helpers the free functions share: DNS-over-HTTPS, capped page reads, HTML to text.
 * Every helper takes the fetch it should use, so tests never touch the network.
 */

/** Page bytes read before stopping. Parsing is CPU, and the free plan gives 10 ms per request. */
export const PAGE_CAP = 100_000;

const UA = 'Mozilla/5.0 (compatible; free-clay/1.0; +https://github.com/)';

/** "https://www.Acme.com/about?x" | "bob@acme.com" | "Acme.com." -> "acme.com". null if not a domain. */
export function normalizeDomain(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  if (s.includes('@') && !s.includes('/')) s = s.split('@').pop();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/\//, '');
  s = s.split(/[/?#\s]/)[0].replace(/:\d+$/, '').replace(/\.$/, '').replace(/^www\d?\./, '');
  try { s = new URL('http://' + s).hostname; } catch { return null; }
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(s)) return null;
  return s;
}

/**
 * One DNS-over-HTTPS query. Cloudflare first, Google if Cloudflare errors (the order
 * scripts/liveness.py settled on, reversed so the Worker's own network answers first).
 * Returns {status, answers: [{type, data}]}; throws only when both resolvers fail.
 * status 0 = NOERROR, 3 = NXDOMAIN (the name does not exist).
 */
export async function doh(fetch, name, type) {
  const urls = [
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
  ];
  let last;
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/dns-json' } });
      if (!r.ok) { last = new Error(`resolver answered HTTP ${r.status}`); continue; }
      const j = await r.json();
      return { status: j.Status, answers: (j.Answer || []).map((a) => ({ type: a.type, data: String(a.data || '') })) };
    } catch (e) { last = e; }
  }
  throw new Error('DNS lookup failed: ' + (last?.message || 'no answer'));
}

/** Read at most `cap` bytes of a response body as text. Big pages are cut, not refused. */
export async function readCapped(res, cap = PAGE_CAP) {
  if (!res.body) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader();
  const chunks = []; let n = 0;
  while (n < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); n += value.byteLength;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(n, cap));
  let o = 0;
  for (const c of chunks) { const part = c.subarray(0, all.length - o); all.set(part, o); o += part.length; if (o >= all.length) break; }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

/**
 * Fetch a site's page: https first, then http. Returns {ok, status, url, html} or {ok:false, error}.
 * `path` lets callers ask for /contact on the same host.
 */
export async function fetchPage(fetch, target, { cap = PAGE_CAP } = {}) {
  const tries = /^https?:\/\//i.test(target) ? [target] : [`https://${target}`, `http://${target}`];
  let lastErr = 'no response';
  for (const url of tries) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.5' } });
      const html = await readCapped(r, cap);
      return { ok: r.ok, status: r.status, url: r.url || url, html };
    } catch (e) { lastErr = String(e?.message || e); }
  }
  return { ok: false, status: 0, url: tries[0], html: '', error: lastErr };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export const decode = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

export function titleOf(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decode(m[1]).replace(/\s+/g, ' ').trim().slice(0, 300) : null;
}

export function metaDescription(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]*>/i) || html.match(/<meta[^>]+property=["']og:description["'][^>]*>/i);
  const c = m && m[0].match(/content=["']([^"']*)["']/i);
  return c ? decode(c[1]).replace(/\s+/g, ' ').trim().slice(0, 500) : null;
}

/** Visible text: scripts, styles and tags removed, whitespace collapsed. */
export function htmlToText(html, max = 8000) {
  return decode(String(html)
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v\r]+/g, ' ').replace(/ *\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim().slice(0, max);
}

export function hrefs(html) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 500) out.push(decode(m[1]).trim());
  return out;
}
