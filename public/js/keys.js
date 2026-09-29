/**
 * Every key Free Clay knows how to use: what it unlocks, where to get it, and what it costs.
 * One list for the Keys page, the setup script (dev/setup.mjs) and KEYS.md, so they never
 * disagree. Prices are the providers' own, as read on the date given; check them before you buy.
 *
 * None is required. With no keys at all you get open data, the free functions, tables,
 * Audiences, workflows, signals, MCP, the API and the CLI.
 */

export const KEYS = [
  { name: 'GROQ_API_KEY', label: 'Groq', recommended: true, url: 'https://console.groq.com/keys',
    unlocks: 'Agents, AI columns, the describe-a-table box and the formula writer.', cost: 'Free tier (rate-limited). Groq console, 2026-09.' },
  { name: 'TREG_TOKEN', label: 'treg', recommended: true, url: 'https://treg.to',
    unlocks: 'One token for thousands of provider tools: work emails (23 providers), phones, people search, company data, Google search and Maps, web scraping, company news and jobs.',
    cost: 'Pay per call at the provider price, 0% markup, $1 free once for new teams (treg’s figures). Company enrich measured at $0.0019, Google search $0.0005 (2026-09-29).',
    how: 'Sign in at treg.to (or `treg login` with their CLI), copy your team token.' },
  { name: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)', url: 'https://console.anthropic.com/settings/keys',
    unlocks: 'Claude models for agents and AI columns.', cost: 'Per token. Sonnet 5 $2 in / $10 out per 1M tokens (Anthropic list price).' },
  { name: 'OPENAI_API_KEY', label: 'OpenAI', url: 'https://platform.openai.com/api-keys', unlocks: 'OpenAI models for agents and AI columns.', cost: 'Per token; type the model price in the agent.' },
  { name: 'OPENROUTER_API_KEY', label: 'OpenRouter', url: 'https://openrouter.ai/keys', unlocks: 'Hundreds of models for agents through one key.', cost: 'Per token at each model’s price.' },
  { name: 'EXA_API_KEY', label: 'Exa', url: 'https://dashboard.exa.ai/api-keys', unlocks: 'Lookalike companies and semantic web search.', cost: 'About $0.007 a search (measured 2026-08-06).' },
  { name: 'GOOGLE_MAPS_API_KEY', label: 'Google Maps (Places)', url: 'https://console.cloud.google.com/google/maps-apis/credentials',
    unlocks: 'Google Maps as a Find leads source and a per-row lookup.', cost: '$35 per 1,000 Text Search (Enterprise) with 1,000 free a month (Google, 2026-09-28).' },
  { name: 'HUNTER_API_KEY', label: 'Hunter', url: 'https://hunter.io/api-keys', unlocks: 'Find and verify work emails directly with Hunter.', cost: 'Free plan: 50 finds a month (Hunter, 2026-07-31).' },
  { name: 'HUBSPOT_TOKEN', label: 'HubSpot (CRM)', url: 'https://developers.hubspot.com/docs/api/private-apps',
    unlocks: 'Send rows to HubSpot as contacts (create or update).', cost: 'Included in your HubSpot plan. Make a private app with crm.objects.contacts.write.' },
  { name: 'INSTANTLY_API_KEY', label: 'Instantly (sequencer)', url: 'https://app.instantly.ai/app/settings/integrations',
    unlocks: 'Add rows as leads to an Instantly campaign.', cost: 'Included in your Instantly plan (API v2 key).' },
  { name: 'SMARTLEAD_API_KEY', label: 'Smartlead (sequencer)', url: 'https://app.smartlead.ai/app/settings/profile',
    unlocks: 'Add rows as leads to a Smartlead campaign.', cost: 'Included in your Smartlead plan.' },
  { name: 'PROSPEO_API_KEY', label: 'Prospeo', url: 'https://app.prospeo.io/api', unlocks: 'Find work emails directly with Prospeo.', cost: 'Free plan: 75 credits a month (Prospeo, 2026-07-31).' },
];

export const keyInfo = (name) => KEYS.find((k) => k.name === name) || null;
