/**
 * Table templates for Home, "Start from template" (LOAM-PLAN.md phase 11; Clay's Templates modal,
 * teardown-v2 section 2). Each is a plan the server checks and builds (POST /api/assist/build,
 * src/assist.js buildPlan): data columns to fill, then enrichment columns wired to them. Building
 * runs nothing. Free functions unless the blurb says "your key".
 */

export const TABLE_TEMPLATES = [
  {
    id: 'sample', name: 'Florida roofers (sample)', icon: 'table', sample: true,
    blurb: 'Fictional rows with a waterfall and enrichments already set up. The fastest way to see a run.',
  },
  {
    id: 'site_health', name: 'Website health check', icon: 'globe',
    blurb: 'Is each site live or parked, who hosts their email, and the contact details on the site. Free.',
    plan: { name: 'Website health check', columns: [{ name: 'Company', type: 'text' }, { name: 'Website', type: 'url' }],
      enrichments: [
        { name: 'Site status', fn: 'website_check', inputs: { domain: 'Website' } },
        { name: 'Email provider', fn: 'email_provider', inputs: { domain: 'Website' } },
        { name: 'Contact on site', fn: 'find_contact_info', inputs: { domain: 'Website' } },
      ] },
  },
  {
    id: 'inbound', name: 'Inbound lead check', icon: 'inbox',
    blurb: 'Leads from a form: is the email real, which company domain, is the domain alive. Free.',
    plan: { name: 'Inbound leads', columns: [{ name: 'Name', type: 'text' }, { name: 'Email', type: 'email' }, { name: 'Company', type: 'text' }],
      enrichments: [
        { name: 'Email check', fn: 'email_check', inputs: { email: 'Email' } },
        { name: 'Company domain', fn: 'normalize_domain', inputs: { text: 'Email' } },
        { name: 'Domain alive', fn: 'domain_alive', inputs: { domain: 'Company domain' } },
      ] },
  },
  {
    id: 'email_find', name: 'Find work emails', icon: 'mail',
    blurb: 'Likely email patterns for free, then Hunter to find and verify (your key, Hunter’s price).',
    plan: { name: 'Work emails', columns: [{ name: 'First name', type: 'text' }, { name: 'Last name', type: 'text' }, { name: 'Website', type: 'url' }],
      enrichments: [
        { name: 'Email guesses', fn: 'email_permutations', inputs: { first_name: 'First name', last_name: 'Last name', domain: 'Website' } },
        { name: 'Hunter email', fn: 'hunter_email_finder', inputs: { first_name: 'First name', last_name: 'Last name', domain: 'Website' } },
      ] },
  },
  {
    id: 'treg_emails', name: 'Work emails, 23 providers (treg)', icon: 'mail',
    blurb: 'Name and company in, a work email out, tried across 23 providers by treg and verified. Your TREG_TOKEN; usually under a cent a row.',
    plan: { name: 'Work emails (treg)', columns: [{ name: 'Full name', type: 'text' }, { name: 'Website', type: 'url' }],
      enrichments: [
        { name: 'Work email', fn: 'treg_email_find', inputs: { full_name: 'Full name', domain: 'Website' } },
        { name: 'Email verified', fn: 'treg_email_verify', inputs: { email: 'Work email' } },
      ] },
  },
  {
    id: 'treg_accounts', name: 'Account research (treg)', icon: 'building',
    blurb: 'Domains in; company size, industry, recent news and open roles out. Your TREG_TOKEN; a few cents a row.',
    plan: { name: 'Account research', columns: [{ name: 'Company', type: 'text' }, { name: 'Website', type: 'url' }],
      enrichments: [
        { name: 'Company data', fn: 'treg_company_enrich', inputs: { domain: 'Website' } },
        { name: 'Latest news', fn: 'treg_company_news', inputs: { domain: 'Website' } },
        { name: 'Open roles', fn: 'treg_company_jobs', inputs: { domain: 'Website' } },
      ] },
  },
  {
    id: 'site_text', name: 'Website text for AI', icon: 'file-text',
    blurb: 'Pulls each site’s text, ready for an AI or agent column to read. Free.',
    plan: { name: 'Website text', columns: [{ name: 'Company', type: 'text' }, { name: 'Website', type: 'url' }],
      enrichments: [{ name: 'Site text', fn: 'scrape_website', inputs: { url: 'Website' } }] },
  },
  {
    id: 'lookalikes', name: 'Lookalike prospecting', icon: 'sparkle',
    blurb: 'Your best customers in, companies like them out, from Exa (your key, about $0.007 a row).',
    plan: { name: 'Lookalikes', columns: [{ name: 'Customer', type: 'text' }, { name: 'Website', type: 'url' }],
      enrichments: [{ name: 'Lookalikes', fn: 'exa_find_similar', inputs: { url: 'Website' } }] },
  },
  {
    id: 'local_lookup', name: 'Google Maps lookup', icon: 'pin',
    blurb: 'Rating, reviews, phone and site for businesses by name and town (your Google key, $0.035 a row).',
    plan: { name: 'Maps lookup', columns: [{ name: 'Business and town', type: 'text' }],
      enrichments: [{ name: 'Google Maps', fn: 'places_lookup', inputs: { query: 'Business and town' } }] },
  },
];
