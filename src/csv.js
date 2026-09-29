/** CSV in and out: a real parser for imports, and formula-safe cells for exports. Parser and
 *  csvCell are the CRM's (builds/free-crm/src/csv.js), copied so this folder deploys alone. */

export const MAX_IMPORT_ROWS = 5000;

/** RFC 4180: quoted fields, doubled quotes, commas and newlines inside quotes, BOM, CRLF. */
export function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** A cell that starts with = + - @ becomes a formula in Excel; prefix it so an export cannot run code. */
export function csvCell(v) {
  const s = v == null ? '' : typeof v === 'object' ? (Array.isArray(v) ? v.join(', ') : JSON.stringify(v)) : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

/**
 * Header spellings seen in Apollo, HubSpot, Sales Navigator-style and Google Maps exports. Each
 * group is one meaning: an incoming header in a group lands in an existing column whose name is in
 * the same group, so "Company Website" fills your "Website" column instead of making a twin.
 */
const GROUPS = [
  ['email', 'email address', 'e-mail', 'work email', 'business email', 'contact email'],
  ['website', 'domain', 'company domain', 'company website', 'website url', 'url', 'web', 'site', 'company domain name'],
  ['company', 'company name', 'organization', 'organization name', 'account name', 'business name', 'business'],
  ['first name', 'firstname', 'first', 'given name'],
  ['last name', 'lastname', 'last', 'surname', 'family name'],
  ['name', 'full name', 'contact name', 'person name', 'contact'],
  ['phone', 'phone number', 'mobile', 'mobile phone', 'telephone', 'work phone', 'direct phone'],
  ['title', 'job title', 'position', 'role'],
  ['linkedin', 'linkedin url', 'linkedin profile', 'person linkedin url'],
  ['city', 'town', 'locality'],
  ['state', 'region', 'province', 'state/region'],
  ['country', 'country/region'],
  ['address', 'street address', 'formatted address', 'full address'],
  ['industry', 'category', 'vertical'],
  ['employees', 'employee count', 'number of employees', '# employees', 'company size', 'headcount'],
];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/[_\s]+/g, ' ');
const groupOf = new Map(GROUPS.flatMap((g, i) => g.map((name) => [name, i])));

/**
 * For each CSV header, the existing column key it fills, or null (a new column gets made).
 * Exact name or key first, then the alias group. Two headers never map to the same column.
 */
export function mapHeaders(headers, columns) {
  const taken = new Set();
  const byName = new Map();
  for (const c of columns) { byName.set(norm(c.name), c.key); byName.set(norm(c.key), c.key); }
  const exact = headers.map((h) => {
    const k = byName.get(norm(h));
    if (!k || taken.has(k)) return null;
    taken.add(k);
    return k;
  });
  return headers.map((h, i) => {
    if (exact[i]) return exact[i];
    const g = groupOf.get(norm(h));
    if (g === undefined) return null;
    const hit = columns.find((c) => groupOf.get(norm(c.name)) === g && !taken.has(c.key));
    if (!hit) return null;
    taken.add(hit.key);
    return hit.key;
  });
}
