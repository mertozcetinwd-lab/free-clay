/**
 * The free functions: no key, no provider bill. Each is a plain object the registry reads:
 *
 *   id, name, blurb        what the picker shows
 *   inputs                 [{key, label, required}]: the column feeds each one through a template
 *   outputs                [{key, label, type}]: fields a run returns; any can become its own column
 *   primary, type          which output fills the column's own cell, and that cell's type
 *   subrequests            worst-case fetches per cell (the batch size is computed from this)
 *   costMicros             estimated cost per cell (0 here)
 *   heavy                  parses HTML (CPU), so a batch takes fewer of these
 *   run(input, ctx)        -> {status: 'done'|'no_result', data} ; throws with a readable message
 *
 * Ported from the lead engine's Python (scripts/liveness.py, email-discover.py, email-verify.py).
 */

import { normalizeDomain, doh, fetchPage, titleOf, metaDescription, htmlToText, hrefs, decode } from './web.js';

const done = (data) => ({ status: 'done', data });
const none = (data = {}) => ({ status: 'no_result', data });
const needDomain = (v) => {
  const d = normalizeDomain(v);
  if (!d) throw new Error(`Not a domain: ${String(v).slice(0, 80)}`);
  return d;
};

/** Parked, for-sale and placeholder markers: scripts/liveness.py PARKED, kept in step with it. */
export const PARKED = [
  'coming soon', 'launching soon', 'opening soon', 'under construction',
  'site for sale', 'domain is for sale', 'domain for sale', 'buy this domain',
  'this domain is parked', 'parked domain', 'domain parking',
  'sedoparking', 'sedo.com', 'afternic', 'bodis.com', 'hugedomains',
  'godaddy.com/domainsearch', 'future home of', 'default web page',
  'welcome to nginx', 'apache2 default', 'it works!', 'index of /',
];

/** MX host suffix -> who runs the mailbox. Order matters: the first match wins. */
const MX_PROVIDERS = [
  [/(^|\.)(google\.com|googlemail\.com)$/, 'Google Workspace'],
  [/(^|\.)(outlook\.com|protection\.outlook\.com|office365\.us)$/, 'Microsoft 365'],
  [/(^|\.)zoho\.(com|eu|in)$/, 'Zoho'],
  [/(^|\.)(protonmail\.ch|proton\.me)$/, 'Proton'],
  [/(^|\.)secureserver\.net$/, 'GoDaddy'],
  [/(^|\.)(mail\.icloud\.com|me\.com)$/, 'iCloud'],
  [/(^|\.)yahoodns\.net$/, 'Yahoo'],
  [/(^|\.)mimecast\.com$/, 'Mimecast (filter)'],
  [/(^|\.)pphosted\.com$/, 'Proofpoint (filter)'],
  [/(^|\.)barracudanetworks\.com$/, 'Barracuda (filter)'],
];

export function mxHosts(answers) {
  return answers.filter((a) => a.type === 15)
    .map((a) => { const [pref, host] = a.data.split(/\s+/); return { pref: Number(pref), host: (host || '').replace(/\.$/, '').toLowerCase() }; })
    .filter((x) => x.host).sort((a, b) => a.pref - b.pref).map((x) => x.host);
}

export function providerOf(hosts) {
  for (const h of hosts) for (const [re, name] of MX_PROVIDERS) if (re.test(h)) return name;
  return hosts.length ? 'Other' : null;
}

const ROLE = /^(info|sales|support|hello|contact|admin|office|team|help|billing|accounts?|marketing|hr|jobs|careers|press|media|service|enquiries|inquiries|noreply|no-reply|webmaster|postmaster)@/;
const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|zoho|mail|yandex)\.[a-z.]+$/;
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/* ---------------------------------------------------------------- functions */

export const normalize_domain = {
  id: 'normalize_domain', category: 'company', name: 'Normalize domain', blurb: 'Pull a clean domain out of a URL, an email or messy text.',
  inputs: [{ key: 'text', label: 'URL, email or text', required: true }],
  outputs: [{ key: 'domain', label: 'Domain', type: 'text' }],
  primary: 'domain', type: 'text', subrequests: 0, costMicros: 0,
  async run({ text }) {
    const d = normalizeDomain(text);
    return d ? done({ domain: d }) : none();
  },
};

export const domain_alive = {
  id: 'domain_alive', category: 'company', name: 'Domain alive', blurb: 'Does the domain resolve in DNS? Checked over DNS-over-HTTPS.',
  inputs: [{ key: 'domain', label: 'Domain or URL', required: true }],
  outputs: [{ key: 'alive', label: 'Alive', type: 'checkbox' }, { key: 'ips', label: 'IP addresses', type: 'text' }],
  primary: 'alive', type: 'checkbox', subrequests: 2, costMicros: 0,
  async run({ domain }, { fetch }) {
    const d = needDomain(domain);
    const r = await doh(fetch, d, 'A');
    const ips = r.answers.filter((a) => a.type === 1).map((a) => a.data);
    return done({ alive: r.status === 0 && ips.length > 0, ips: ips.join(', ') || null });
  },
};

export const email_provider = {
  id: 'email_provider', category: 'company', name: 'Email provider', blurb: 'Who hosts their email: Google Workspace, Microsoft 365, or other. From MX records.',
  inputs: [{ key: 'domain', label: 'Domain, URL or email', required: true }],
  outputs: [{ key: 'provider', label: 'Email provider', type: 'text' }, { key: 'mx', label: 'MX records', type: 'text' }],
  primary: 'provider', type: 'text', subrequests: 2, costMicros: 0,
  async run({ domain }, { fetch }) {
    const d = needDomain(domain);
    const r = await doh(fetch, d, 'MX');
    const hosts = mxHosts(r.answers);
    if (!hosts.length) return done({ provider: 'No MX (cannot receive email)', mx: null });
    return done({ provider: providerOf(hosts), mx: hosts.join(', ') });
  },
};

export const website_check = {
  id: 'website_check', category: 'web', name: 'Website check', blurb: 'Is the site live, parked or down? Plus its title and description.',
  inputs: [{ key: 'domain', label: 'Domain or URL', required: true }],
  outputs: [
    { key: 'status', label: 'Site status', type: 'select' }, { key: 'http_status', label: 'HTTP status', type: 'number' },
    { key: 'final_url', label: 'Final URL', type: 'url' }, { key: 'title', label: 'Page title', type: 'text' },
    { key: 'description', label: 'Meta description', type: 'text' },
  ],
  primary: 'status', type: 'select', subrequests: 2, costMicros: 0, heavy: true,
  async run({ domain }, { fetch }) {
    const target = /^https?:\/\//i.test(String(domain).trim()) ? String(domain).trim() : needDomain(domain);
    const p = await fetchPage(fetch, target, { cap: 64_000 });
    if (!p.status) return done({ status: 'down', http_status: null, final_url: null, title: null, description: p.error?.slice(0, 200) || null });
    const low = p.html.toLowerCase();
    const parked = PARKED.find((m) => low.includes(m));
    const status = !p.ok ? 'down' : parked ? 'parked' : 'live';
    return done({ status, http_status: p.status, final_url: p.url, title: titleOf(p.html), description: metaDescription(p.html) || (parked ? `Matched "${parked}"` : null) });
  },
};

export const scrape_website = {
  id: 'scrape_website', category: 'web', name: 'Scrape website', blurb: 'The page as plain text (first 8,000 characters), ready to feed an AI column.',
  inputs: [{ key: 'url', label: 'Domain or URL', required: true }],
  outputs: [{ key: 'text', label: 'Page text', type: 'text' }, { key: 'title', label: 'Page title', type: 'text' }],
  primary: 'text', type: 'text', subrequests: 2, costMicros: 0, heavy: true,
  async run({ url }, { fetch }) {
    const target = /^https?:\/\//i.test(String(url).trim()) ? String(url).trim() : needDomain(url);
    const p = await fetchPage(fetch, target);
    if (!p.ok) throw new Error(p.status ? `The site answered HTTP ${p.status}` : `Could not reach the site: ${p.error}`);
    const text = htmlToText(p.html, 8000);
    return text ? done({ text, title: titleOf(p.html) }) : none({ title: titleOf(p.html) });
  },
};

/* ---------- find contact info on the site */

const JUNK_EMAIL = /(\.(png|jpe?g|gif|webp|svg|css|js)$)|(@(example|sentry|wixpress|sentry-next|domain|email)\.)|(^(your|name|user|email)@)/i;
const SOCIAL = [
  ['facebook', /^https?:\/\/(www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)[^\s"'?#]+/i],
  ['instagram', /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|explore)[^\s"'?#]+/i],
  ['x', /^https?:\/\/(www\.)?(twitter|x)\.com\/(?!intent|share|home)[^\s"'?#]+/i],
  ['linkedin', /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|in|school)\/[^\s"'?#]+/i],
  ['youtube', /^https?:\/\/(www\.)?youtube\.com\/(@|c\/|channel\/|user\/)[^\s"'?#]+/i],
  ['tiktok', /^https?:\/\/(www\.)?tiktok\.com\/@[^\s"'?#]+/i],
];

export function contactsFrom(html, siteDomain) {
  const links = hrefs(html);
  const emails = new Set();
  for (const l of links) if (/^mailto:/i.test(l)) emails.add(decodeURIComponent(l.slice(7).split('?')[0]).trim().toLowerCase());
  const text = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' '));
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) emails.add(m[0].toLowerCase());
  const good = [...emails].filter((e) => EMAIL_RE.test(e) && !JUNK_EMAIL.test(e));
  // Addresses on the site's own domain first: a gmail.com address on the page is often a web designer's.
  good.sort((a, b) => Number(!a.endsWith('@' + siteDomain)) - Number(!b.endsWith('@' + siteDomain)));
  const phones = new Set();
  for (const l of links) if (/^tel:/i.test(l)) phones.add(l.slice(4).replace(/[^\d+]/g, ''));
  for (const m of htmlToText(html, 50_000).matchAll(/(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g)) phones.add(`${m[1]}${m[2]}${m[3]}`);
  const socials = {};
  for (const l of links) for (const [k, re] of SOCIAL) if (!socials[k] && re.test(l)) socials[k] = l.split(/[?#]/)[0];
  const contactPage = links.find((l) => /contact|about/i.test(l) && !/^(mailto|tel):/i.test(l));
  return { emails: good.slice(0, 10), phones: [...phones].filter((p) => p.replace(/\D/g, '').length >= 10).slice(0, 5), socials, contactPage };
}

export const find_contact_info = {
  id: 'find_contact_info', category: 'contact', name: 'Find contact info on site', blurb: 'Emails, phone numbers and social links published on the homepage or contact page.',
  inputs: [{ key: 'domain', label: 'Domain or URL', required: true }],
  outputs: [
    { key: 'email', label: 'Email found', type: 'email' }, { key: 'emails', label: 'All emails', type: 'text' },
    { key: 'phone', label: 'Phone found', type: 'text' }, { key: 'facebook', label: 'Facebook', type: 'url' },
    { key: 'instagram', label: 'Instagram', type: 'url' }, { key: 'linkedin', label: 'LinkedIn page', type: 'url' },
    { key: 'x', label: 'X / Twitter', type: 'url' },
  ],
  primary: 'email', type: 'email', subrequests: 3, costMicros: 0, heavy: true,
  async run({ domain }, { fetch }) {
    const d = needDomain(domain);
    const home = await fetchPage(fetch, d);
    if (!home.ok) throw new Error(home.status ? `The site answered HTTP ${home.status}` : `Could not reach the site: ${home.error}`);
    let found = contactsFrom(home.html, d);
    // Only one extra page, and only when the homepage had no email: two fetches, not a crawl.
    if (!found.emails.length && found.contactPage) {
      let url;
      try { url = new URL(found.contactPage, home.url).href; } catch { url = null; }
      if (url && normalizeDomain(url) === d) {
        const p = await fetchPage(fetch, url);
        if (p.ok) {
          const more = contactsFrom(p.html, d);
          found = { emails: more.emails, phones: [...found.phones, ...more.phones], socials: { ...more.socials, ...found.socials } };
        }
      }
    }
    const data = {
      email: found.emails[0] || null, emails: found.emails.join(', ') || null, phone: found.phones[0] || null,
      facebook: found.socials.facebook || null, instagram: found.socials.instagram || null,
      linkedin: found.socials.linkedin || null, x: found.socials.x || null,
    };
    return Object.values(data).some(Boolean) ? done(data) : none(data);
  },
};

/* ---------- email permutations and checks */

const clean = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');

export function permutations(first, last, domain) {
  const f = clean(first); const l = clean(last);
  if (!f || !domain) return [];
  const list = l
    ? [`${f}.${l}`, `${f}`, `${f[0]}${l}`, `${f}${l}`, `${f[0]}.${l}`, `${f}_${l}`, `${f}${l[0]}`, `${l}.${f}`, `${l}`, `${f}-${l}`]
    : [f];
  return [...new Set(list)].map((x) => `${x}@${domain}`);
}

export const email_permutations = {
  id: 'email_permutations', category: 'email', name: 'Email permutations', blurb: 'The usual patterns (first.last@, flast@, first@...). Guesses, not verified addresses.',
  inputs: [{ key: 'first_name', label: 'First name', required: true }, { key: 'last_name', label: 'Last name' }, { key: 'domain', label: 'Company domain', required: true }],
  outputs: [{ key: 'email', label: 'Most common pattern', type: 'email' }, { key: 'all', label: 'All patterns', type: 'text' }],
  primary: 'email', type: 'email', subrequests: 0, costMicros: 0,
  async run({ first_name, last_name, domain }) {
    const list = permutations(first_name, last_name, needDomain(domain));
    return list.length ? done({ email: list[0], all: list.join(', ') }) : none();
  },
};

/**
 * Syntax + MX. It proves the domain accepts mail, NOT that the mailbox exists: that needs an SMTP
 * probe, which Workers cannot open (no raw TCP to port 25; scripts/smtp-verify.py explains). So the
 * answer is never "valid", only "domain accepts mail".
 */
export const email_check = {
  id: 'email_check', category: 'email', name: 'Email syntax + MX check', blurb: 'Well-formed, and does the domain accept mail? Flags role and free-mail addresses. Does not prove the mailbox exists.',
  inputs: [{ key: 'email', label: 'Email', required: true }],
  outputs: [
    { key: 'result', label: 'Check result', type: 'select' }, { key: 'valid', label: 'Passes check', type: 'checkbox' },
    { key: 'role', label: 'Role address', type: 'checkbox' }, { key: 'free_mail', label: 'Free mail', type: 'checkbox' },
    { key: 'provider', label: 'Mailbox provider', type: 'text' },
  ],
  primary: 'result', type: 'select', subrequests: 2, costMicros: 0, validates: 'email',
  async run({ email }, { fetch }) {
    const e = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(e)) return done({ result: 'bad syntax', valid: false, role: false, free_mail: false, provider: null });
    const domain = e.split('@')[1];
    const r = await doh(fetch, domain, 'MX');
    const hosts = mxHosts(r.answers);
    const flags = { role: ROLE.test(e), free_mail: FREE_MAIL.test(e) };
    if (!hosts.length) return done({ result: r.status === 3 ? 'domain does not exist' : 'no MX', valid: false, ...flags, provider: null });
    return done({ result: 'domain accepts mail', valid: true, ...flags, provider: providerOf(hosts) });
  },
};

/* ---------- webhook out */

/**
 * Posts the whole row (formulas included) as JSON to a URL you choose: a Zap, a Make scenario,
 * your own endpoint. Optional signing with a Worker secret you name, same scheme as webhook in:
 * X-Signature: sha256=<hex HMAC-SHA256(secret, body)>.
 */
export const send_to_webhook = {
  id: 'send_to_webhook', category: 'export', name: 'Send row to webhook', blurb: 'POST this row as JSON to a URL (Zapier, Make, n8n, your own server). Optionally signed.',
  inputs: [{ key: 'url', label: 'Webhook URL (https)', required: true }, { key: 'signing_secret', label: 'Sign with Worker secret (name, optional)' }],
  outputs: [{ key: 'result', label: 'Webhook result', type: 'text' }, { key: 'http_status', label: 'HTTP status', type: 'number' }],
  primary: 'result', type: 'text', subrequests: 1, costMicros: 0,
  async run({ url, signing_secret }, { fetch, secret, row }) {
    const target = String(url || '').trim();
    if (!/^https:\/\/[^\s/]+/i.test(target)) throw new Error('The webhook URL must start with https://');
    const body = JSON.stringify({ row_id: row?.id ?? null, data: row?.data || {}, sent_at: new Date().toISOString() });
    const headers = { 'content-type': 'application/json', 'user-agent': 'free-clay/1.0' };
    const name = String(signing_secret || '').trim();
    if (name) {
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret(name)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
      headers['x-signature'] = 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    const r = await fetch(target, { method: 'POST', headers, body });
    if (!r.ok) throw new Error(`The webhook answered HTTP ${r.status}`);
    return done({ result: `sent (${r.status})`, http_status: r.status });
  },
};

export const FREE = [normalize_domain, domain_alive, email_provider, website_check, scrape_website, find_contact_info, email_permutations, email_check, send_to_webhook];
