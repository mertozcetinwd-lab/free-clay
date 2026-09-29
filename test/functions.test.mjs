import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeFetch, html, dns } from './helpers.mjs';
import { normalizeDomain, htmlToText, readCapped } from '../src/functions/web.js';
import { domain_alive, email_provider, website_check, scrape_website, find_contact_info, email_permutations, email_check, normalize_domain, contactsFrom } from '../src/functions/free.js';

test('normalize domain handles URLs, emails, www, ports, junk', () => {
  assert.equal(normalizeDomain('https://www.Acme-Roofing.com/about?x=1'), 'acme-roofing.com');
  assert.equal(normalizeDomain('Bob@Acme.co.uk'), 'acme.co.uk');
  assert.equal(normalizeDomain('acme.com:8080/'), 'acme.com');
  assert.equal(normalizeDomain('localhost'), null);
  assert.equal(normalizeDomain('not a domain'), null);
  assert.equal(normalizeDomain(''), null);
});

test('normalize_domain as a function: no_result on junk, no fetch at all', async () => {
  assert.deepEqual(await normalize_domain.run({ text: 'http://www.beta.example.com' }), { status: 'done', data: { domain: 'beta.example.com' } });
  assert.equal((await normalize_domain.run({ text: '???' })).status, 'no_result');
});

test('domain alive: A records mean alive, NXDOMAIN means dead', async () => {
  const f = fakeFetch({ 'cloudflare-dns.com': (r) => r.url.includes('acme') ? dns([[1, '93.184.216.34']]) : dns([], 3) });
  assert.deepEqual((await domain_alive.run({ domain: 'acme.example.com' }, { fetch: f })).data, { alive: true, ips: '93.184.216.34' });
  assert.deepEqual((await domain_alive.run({ domain: 'gone.example.com' }, { fetch: f })).data, { alive: false, ips: null });
  assert.equal(f.calls[0].headers.get('accept'), 'application/dns-json');
});

test('DNS falls back to Google when Cloudflare fails', async () => {
  const f = fakeFetch({ 'cloudflare-dns.com': new Error('boom'), 'dns.google': dns([[1, '1.2.3.4']]) });
  assert.equal((await domain_alive.run({ domain: 'acme.example.com' }, { fetch: f })).data.alive, true);
  assert.equal(f.calls.length, 2);
});

test('both resolvers down is an error, not "dead"', async () => {
  const f = fakeFetch({ 'cloudflare-dns.com': new Error('x'), 'dns.google': new Error('y') });
  await assert.rejects(domain_alive.run({ domain: 'acme.example.com' }, { fetch: f }), /DNS lookup failed/);
});

test('email provider from MX, lowest preference first', async () => {
  const f = fakeFetch({ 'type=MX': dns([[15, '20 alt1.aspmx.l.google.com.'], [15, '10 aspmx.l.google.com.']]) });
  assert.deepEqual((await email_provider.run({ domain: 'acme.example.com' }, { fetch: f })).data,
    { provider: 'Google Workspace', mx: 'aspmx.l.google.com, alt1.aspmx.l.google.com' });
  const m = fakeFetch({ 'type=MX': dns([[15, '0 acme-com.mail.protection.outlook.com.']]) });
  assert.equal((await email_provider.run({ domain: 'acme.com' }, { fetch: m })).data.provider, 'Microsoft 365');
  const n = fakeFetch({ 'type=MX': dns([]) });
  assert.match((await email_provider.run({ domain: 'acme.com' }, { fetch: n })).data.provider, /No MX/);
});

test('website check: live, parked, down', async () => {
  const live = fakeFetch({ 'https://acme.example.com': html('<title>Acme Roofing | Tampa</title><meta name="description" content="Roofs &amp; gutters">') });
  assert.deepEqual((await website_check.run({ domain: 'acme.example.com' }, { fetch: live })).data,
    { status: 'live', http_status: 200, final_url: 'https://acme.example.com', title: 'Acme Roofing | Tampa', description: 'Roofs & gutters' });
  const parked = fakeFetch({ 'https://': html('<h1>This domain is for sale!</h1> Buy this domain today') });
  assert.equal((await website_check.run({ domain: 'x.example.com' }, { fetch: parked })).data.status, 'parked');
  const down = fakeFetch({ 'https://': new Error('connect ECONNREFUSED'), 'http://': new Error('connect ECONNREFUSED') });
  assert.equal((await website_check.run({ domain: 'x.example.com' }, { fetch: down })).data.status, 'down');
});

test('scrape drops scripts and styles and caps the text', async () => {
  const f = fakeFetch({ 'https://': html('<style>.a{}</style><script>var x=1</script><p>We fix roofs.</p><p>' + 'x'.repeat(20000) + '</p>') });
  const r = await scrape_website.run({ url: 'acme.example.com' }, { fetch: f });
  assert.ok(r.data.text.startsWith('We fix roofs.'));
  assert.ok(!r.data.text.includes('var x'));
  assert.equal(r.data.text.length, 8000);
  const bad = fakeFetch({ 'https://': html('nope', 503) });
  await assert.rejects(scrape_website.run({ url: 'acme.example.com' }, { fetch: bad }), /HTTP 503/);
});

test('page reads stop at the cap instead of downloading everything', async () => {
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(50_000).fill(97)); if (pulled > 100) c.close(); } });
  const text = await readCapped(new Response(stream), 120_000);
  assert.equal(text.length, 120_000);
  assert.ok(pulled <= 4);
});

test('contact finder: own-domain email first, junk dropped, socials found', () => {
  const page = `<a href="mailto:designer@gmail.com">x</a> <a href="mailto:Office@acme.example.com?subject=hi">Email</a>
    logo@2x.png <a href="tel:+1 (352) 555-0142">Call</a> <a href="https://www.facebook.com/acmeroofing">fb</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a> <a href="https://instagram.com/acme.roofs/">ig</a>`;
  const c = contactsFrom(page, 'acme.example.com');
  assert.deepEqual(c.emails, ['office@acme.example.com', 'designer@gmail.com']);
  assert.equal(c.phones[0], '+13525550142');
  assert.equal(c.socials.facebook, 'https://www.facebook.com/acmeroofing');
  assert.equal(c.socials.instagram, 'https://instagram.com/acme.roofs/');
});

test('contact finder: form placeholders and dummy addresses are not contacts', () => {
  const page = `<form><input type="email" placeholder="you@company.com"><input value="name@acme.example.com">
    <textarea>jane.doe@acme.example.com</textarea><div data-hint="sales@acme.example.com"></div></form>
    <p>For example you@yourcompany.com or john.doe@email.com</p> <p>Sample: sales@company.com, team@yourcompany.com</p>
    <p>Press: press@acme.example.com</p>`;
  assert.deepEqual(contactsFrom(page, 'acme.example.com').emails, ['press@acme.example.com']);
});

test('contact finder tries one contact page when the homepage has no email', async () => {
  const f = fakeFetch({
    'https://acme.example.com/contact': html('<p>Write to hello@acme.example.com</p>'),
    'https://acme.example.com': html('<a href="/contact">Contact us</a> Call (352) 555-0100'),
  });
  const r = await find_contact_info.run({ domain: 'acme.example.com' }, { fetch: f });
  assert.equal(r.data.email, 'hello@acme.example.com');
  assert.equal(r.data.phone, '3525550100');
  assert.equal(f.calls.length, 2);
});

test('contact finder never follows a contact link to another site', async () => {
  const f = fakeFetch({ 'https://acme.example.com': html('<a href="https://evil.example.net/contact">Contact</a>') });
  const r = await find_contact_info.run({ domain: 'acme.example.com' }, { fetch: f });
  assert.equal(r.status, 'no_result');
  assert.equal(f.calls.length, 1);
});

test('email permutations', async () => {
  const r = await email_permutations.run({ first_name: 'José', last_name: "O'Brien", domain: 'https://acme.example.com' });
  assert.equal(r.data.email, 'jose.obrien@acme.example.com');
  assert.ok(r.data.all.includes('jobrien@acme.example.com'));
  assert.equal((await email_permutations.run({ first_name: '', last_name: 'x', domain: 'acme.com' })).status, 'no_result');
});

test('email check: syntax, MX, role and free-mail flags; never claims the mailbox exists', async () => {
  const f = fakeFetch({ 'type=MX': (r) => r.url.includes('nomx') ? dns([], 3) : dns([[15, '10 aspmx.l.google.com.']]) });
  assert.deepEqual((await email_check.run({ email: 'info@acme.example.com' }, { fetch: f })).data,
    { result: 'domain accepts mail', valid: true, role: true, free_mail: false, provider: 'Google Workspace' });
  assert.equal((await email_check.run({ email: 'bob@nomx.example.com' }, { fetch: f })).data.result, 'domain does not exist');
  assert.equal((await email_check.run({ email: 'not an email' }, { fetch: f })).data.valid, false);
  assert.equal((await email_check.run({ email: 'x@gmail.com' }, { fetch: f })).data.free_mail, true);
});

test('htmlToText keeps line breaks between blocks and decodes entities', () => {
  assert.equal(htmlToText('<h1>Acme &amp; Sons</h1><p>Roofs&nbsp;done</p>'), 'Acme & Sons\nRoofs done');
});
