/**
 * Column types: how a value is stored, shown, sorted and filtered. Shared by the Worker (which
 * coerces on write, so bad data never lands in D1) and the browser (which shows and edits it).
 * No DOM here, so node:test proves every rule (test/logic.test.mjs).
 */

export const TYPES = {
  text: 'Text', number: 'Number', currency: 'Currency', date: 'Date', url: 'URL', email: 'Email',
  checkbox: 'Checkbox', select: 'Select', multi_select: 'Multi-select', json: 'JSON',
};

export const KINDS = {
  data: 'Data', enrich: 'Enrichment', waterfall: 'Waterfall', formula: 'Formula', ai: 'AI', http: 'HTTP API', message: 'Message',
};

export const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/** "$1,250.50" -> 1250.5; "12%" -> 12; junk -> null. */
export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v ?? '').replace(/[$€£,\s%]/g, '');
  if (!s || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
  return Number(s);
}

/** 2026-09-27, 9/27/2026, 09/27/26, "Sep 27, 2026" or an ISO timestamp -> "2026-09-27". Else null. */
export function toDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);   // US order, what a US spreadsheet exports
  if (m) return ymd(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  const t = Date.parse(s);
  if (Number.isFinite(t) && /[a-z]/i.test(s)) {
    const d = new Date(t);
    return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }
  return null;
}

function ymd(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;   // 2026-02-30 is not a day
  return dt.toISOString().slice(0, 10);
}

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  return /^(true|yes|y|1|x|checked|on)$/i.test(String(v ?? '').trim());
}

export function toList(v) {
  if (Array.isArray(v)) return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))];
  const s = String(v ?? '').trim();
  if (!s) return [];
  if (s.startsWith('[')) { try { return toList(JSON.parse(s)); } catch { /* fall through */ } }
  return toList(s.split(/[,;|]/));
}

/**
 * The value to store for a cell of this type, or null to clear it. A value that does not fit the
 * type is kept as text rather than thrown away: an import must never silently lose data, and the
 * cell shows it in red so it can be fixed.
 */
export function coerce(type, v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && v.trim() === '' && type !== 'text') return null;
  switch (type) {
    case 'number': case 'currency': { const n = toNumber(v); return n === null ? String(v).trim() : n; }
    case 'date': return toDate(v) ?? String(v).trim();
    case 'checkbox': return toBool(v);
    case 'email': return String(v).trim().toLowerCase();
    case 'url': return String(v).trim();
    case 'multi_select': { const l = toList(v); return l.length ? l : null; }
    case 'select': return String(v).trim() || null;
    case 'json': return typeof v === 'string' ? (tryJson(v) ?? v) : v;
    default: {
      if (typeof v === 'object') return JSON.stringify(v);
      const s = String(v);
      return s === '' ? null : s.slice(0, 50_000);
    }
  }
}

const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** True when a stored value does not match its column type (shown in red, counted as not filled). */
export function invalid(type, v) {
  if (isEmpty(v)) return false;
  if (type === 'number' || type === 'currency') return typeof v !== 'number';
  if (type === 'date') return !/^\d{4}-\d{2}-\d{2}$/.test(String(v));
  if (type === 'email') return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v));
  return false;
}

/** Guess a type for a new column from its header and its first values (CSV import). */
export function inferType(header, samples) {
  const h = String(header || '').toLowerCase();
  const vals = samples.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 50);
  if (/e-?mail/.test(h)) return 'email';
  if (/(website|domain|url|linkedin|link)\b/.test(h)) return 'url';
  if (!vals.length) return 'text';
  const all = (re) => vals.every((v) => re.test(v));
  if (all(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) return 'email';
  if (all(/^https?:\/\//i)) return 'url';
  if (all(/^\$\s?-?[\d,]+(\.\d+)?$/)) return 'currency';
  if (all(/^-?[\d,]*\.?\d+$/) && !/(phone|zip|postal|id)\b/.test(h)) return 'number';
  if (all(/^(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})$/)) return 'date';
  if (all(/^(true|false|yes|no)$/i)) return 'checkbox';
  return 'text';
}

/* ---------------------------------------------------------------- display */

export function fmtNumber(n) {
  if (isEmpty(n)) return '';
  return typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(n);
}

export function fmtMoney(n, currency = 'USD') {
  if (isEmpty(n)) return '';
  if (typeof n !== 'number') return String(n);
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: Number.isInteger(n) ? 0 : 2 }).format(n);
  } catch { return '$' + n.toLocaleString('en-US'); }
}

/** Cost in micro-dollars as money a person reads: $0, $0.0019, $0.35, $12.40. */
export function fmtMicros(m) {
  const usd = Number(m || 0) / 1e6;
  if (usd === 0) return '$0';
  if (usd < 0.01) return '$' + usd.toFixed(4).replace(/0+$/, '');
  return '$' + usd.toFixed(2);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(d) {
  const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}` : String(d ?? '');
}

/** The text a person sees for a value. Search and "contains" filters match against this. */
export function displayText(type, v) {
  if (isEmpty(v)) return '';
  switch (type) {
    case 'number': return fmtNumber(v);
    case 'currency': return fmtMoney(v);
    case 'date': return fmtDate(v);
    case 'checkbox': return v ? 'Yes' : 'No';
    case 'multi_select': return Array.isArray(v) ? v.join(', ') : String(v);
    default: return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}
