/**
 * The fields of the two Audiences databases (LOAM-PLAN.md phase 7), shared by the Worker (checks,
 * keys, filters) and the pages. Clay's People database has 39 fields (teardown-v2, Audiences);
 * these are the ones a small business can fill from its own tables and open data. LinkedIn URLs
 * are left out on purpose: Free Clay does not scrape LinkedIn.
 *
 * Each field: [key, label, type]. type is one of the table types (public/js/types.js).
 */

export const FIELDS = {
  people: [
    ['full_name', 'Name', 'text'], ['first_name', 'First name', 'text'], ['last_name', 'Last name', 'text'],
    ['email', 'Email', 'email'], ['phone', 'Phone', 'text'], ['title', 'Job title', 'text'],
    ['company', 'Company', 'text'], ['domain', 'Company domain', 'text'],
    ['city', 'City', 'text'], ['state', 'State', 'text'], ['country', 'Country', 'text'],
    ['profile_url', 'Profile page', 'url'], ['email_status', 'Email status', 'text'], ['notes', 'Notes', 'text'],
  ],
  companies: [
    ['name', 'Name', 'text'], ['domain', 'Domain', 'text'], ['website', 'Website', 'url'],
    ['phone', 'Phone', 'text'], ['email', 'Email', 'email'], ['industry', 'Industry', 'text'],
    ['employees', 'Employees', 'number'], ['founded', 'Founded', 'number'], ['description', 'Description', 'text'],
    ['address', 'Address', 'text'], ['city', 'City', 'text'], ['state', 'State', 'text'], ['country', 'Country', 'text'],
    ['ticker', 'Ticker', 'text'], ['map_link', 'Map link', 'url'], ['notes', 'Notes', 'text'],
  ],
};

export const KINDS = { people: 'People', companies: 'Companies' };

export const fieldKeys = (kind) => FIELDS[kind].map((f) => f[0]);
export const fieldLabel = (kind, key) => FIELDS[kind].find((f) => f[0] === key)?.[1] || key;

/** Filter operators the database understands. value-less ones need no input. */
export const AUD_OPS = {
  contains: 'contains', not_contains: 'does not contain', equals: 'is', not_equals: 'is not',
  starts_with: 'starts with', empty: 'is empty', not_empty: 'is not empty', gt: 'greater than', lt: 'less than',
};
export const AUD_NO_VALUE = ['empty', 'not_empty'];

/** Column-name guesses for "Send to Audiences" from a table: field -> header words. */
export const ALIASES = {
  full_name: ['name', 'full name', 'contact', 'contact name', 'person'],
  first_name: ['first name', 'first', 'firstname', 'given name'],
  last_name: ['last name', 'last', 'lastname', 'surname', 'family name'],
  email: ['email', 'e-mail', 'work email', 'email address'],
  phone: ['phone', 'phone number', 'mobile', 'telephone', 'tel'],
  title: ['title', 'job title', 'role', 'position'],
  company: ['company', 'company name', 'organization', 'business', 'business name'],
  domain: ['domain', 'company domain', 'website domain'],
  website: ['website', 'url', 'site', 'web', 'homepage'],
  city: ['city', 'town'], state: ['state', 'region', 'province'], country: ['country'],
  industry: ['industry', 'category', 'sector', 'sic'],
  employees: ['employees', 'employee count', 'headcount', 'size'],
  founded: ['founded', 'year founded', 'inception'],
  description: ['description', 'about', 'summary'],
  address: ['address', 'street', 'street address'],
  ticker: ['ticker', 'symbol'], map_link: ['map link', 'google maps', 'maps link', 'map'],
  profile_url: ['profile', 'profile page', 'profile url'], email_status: ['email status', 'verification'],
  notes: ['notes', 'note', 'comments'], name: ['name', 'company', 'company name', 'business', 'business name'],
};

/** Guess which table column feeds each field. cols: [{key, name}]. Returns {field: column key}. */
export function guessMap(kind, cols) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  const out = {}; const used = new Set();
  for (const [key] of FIELDS[kind]) {
    const words = ALIASES[key] || [key.replace(/_/g, ' ')];
    const hit = cols.find((c) => !used.has(c.key) && words.includes(norm(c.name)))
      || cols.find((c) => !used.has(c.key) && words.includes(norm(c.key)));
    if (hit) { out[key] = hit.key; used.add(hit.key); }
  }
  return out;
}
