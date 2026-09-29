/**
 * Send rows to the tools you already use, on your own keys (Clay's "Export to email sequence" and
 * CRM sync, Upgrade-gated there, teardown-v2 section 4). Each runs once per row when you press
 * Run, like any column, so nothing is sent until you choose to.
 *
 * Built from each provider's public API documentation (read 2026-09-29), not yet tested against
 * a live account: run one row first and check it arrived. They send only what the row maps in.
 *
 * Sending cold email is the sender's legal responsibility (CAN-SPAM in the US, GDPR in the EU):
 * a real postal address, a working unsubscribe you honour, honest subject lines. These functions
 * add a lead to your own campaign; your sequencer does the sending.
 */

import { readCapped, normalizeDomain } from './web.js';

const done = (data) => ({ status: 'done', data });
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const need = (v, what) => { if (!str(v)) throw new Error(`Needs ${what}`); return str(v); };

async function fail(name, r) {
  const text = (await readCapped(r, 2000).catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  const hint = r.status === 401 || r.status === 403 ? ' (check the key)' : r.status === 429 ? ' (rate limited)' : '';
  return new Error(`${name} HTTP ${r.status}${hint}: ${text}`);
}

const personInputs = [
  { key: 'email', label: 'Email', required: true }, { key: 'first_name', label: 'First name' }, { key: 'last_name', label: 'Last name' },
  { key: 'company', label: 'Company' }, { key: 'website', label: 'Website' }, { key: 'phone', label: 'Phone' },
];

/** HubSpot: create the contact, or update it when HubSpot says it already exists (409). */
export const hubspot_upsert_contact = {
  id: 'hubspot_upsert_contact', category: 'export', name: 'HubSpot: add or update contact', group: 'Your key', secret: 'HUBSPOT_TOKEN', provider: 'HubSpot',
  blurb: 'Creates the contact in your HubSpot CRM, or updates it if the email is already there. Needs a private app token with crm.objects.contacts.write.',
  inputs: personInputs, outputs: [{ key: 'result', label: 'HubSpot result', type: 'text' }, { key: 'contact_id', label: 'HubSpot contact ID', type: 'text' }],
  primary: 'result', type: 'text', subrequests: 2, costMicros: 0, costSource: 'HubSpot API calls are included in your HubSpot plan.',
  async run(i, { fetch, secret }) {
    const properties = Object.fromEntries(Object.entries({ email: need(i.email, 'an email').toLowerCase(), firstname: str(i.first_name), lastname: str(i.last_name),
      company: str(i.company), website: str(i.website), phone: str(i.phone) }).filter(([, v]) => v));
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${secret('HUBSPOT_TOKEN')}` };
    let r = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', { method: 'POST', headers, body: JSON.stringify({ properties }) });
    if (r.status === 409) {
      const text = await readCapped(r, 4000).catch(() => '');
      const id = (text.match(/Existing ID:\s*(\d+)/) || [])[1];
      if (!id) throw new Error('HubSpot says the contact exists but did not give its ID');
      r = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ properties }) });
      if (!r.ok) throw await fail('HubSpot', r);
      return done({ result: 'updated', contact_id: id });
    }
    if (!r.ok) throw await fail('HubSpot', r);
    const j = await r.json().catch(() => ({}));
    return done({ result: 'created', contact_id: j.id ? String(j.id) : null });
  },
};

/** Instantly (API v2): add the lead to one of your campaigns. */
export const instantly_add_lead = {
  id: 'instantly_add_lead', category: 'export', name: 'Instantly: add lead to campaign', group: 'Your key', secret: 'INSTANTLY_API_KEY', provider: 'Instantly',
  blurb: 'Adds the row as a lead in an Instantly campaign (API v2). Copy the campaign ID from its URL in Instantly.',
  inputs: [{ key: 'campaign_id', label: 'Campaign ID', required: true }, ...personInputs.filter((x) => x.key !== 'phone'), { key: 'personalization', label: 'First line (optional)' }],
  outputs: [{ key: 'result', label: 'Instantly result', type: 'text' }, { key: 'lead_id', label: 'Instantly lead ID', type: 'text' }],
  primary: 'result', type: 'text', subrequests: 1, costMicros: 0, costSource: 'Included in your Instantly plan.',
  async run(i, { fetch, secret }) {
    const body = Object.fromEntries(Object.entries({ campaign: need(i.campaign_id, 'a campaign ID'), email: need(i.email, 'an email').toLowerCase(), first_name: str(i.first_name),
      last_name: str(i.last_name), company_name: str(i.company), website: str(i.website), personalization: str(i.personalization) }).filter(([, v]) => v));
    const r = await fetch('https://api.instantly.ai/api/v2/leads', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret('INSTANTLY_API_KEY')}` }, body: JSON.stringify(body) });
    if (!r.ok) throw await fail('Instantly', r);
    const j = await r.json().catch(() => ({}));
    return done({ result: 'added', lead_id: j.id ? String(j.id) : null });
  },
};

/** Smartlead: add the lead to a campaign. */
export const smartlead_add_lead = {
  id: 'smartlead_add_lead', category: 'export', name: 'Smartlead: add lead to campaign', group: 'Your key', secret: 'SMARTLEAD_API_KEY', provider: 'Smartlead',
  blurb: 'Adds the row as a lead in a Smartlead campaign, respecting your global block list. The campaign ID is in its URL in Smartlead.',
  inputs: [{ key: 'campaign_id', label: 'Campaign ID', required: true }, ...personInputs],
  outputs: [{ key: 'result', label: 'Smartlead result', type: 'text' }],
  primary: 'result', type: 'text', subrequests: 1, costMicros: 0, costSource: 'Included in your Smartlead plan.',
  async run(i, { fetch, secret }) {
    const id = need(i.campaign_id, 'a campaign ID');
    if (!/^\d{1,12}$/.test(id)) throw new Error('A Smartlead campaign ID is a number');
    const lead = Object.fromEntries(Object.entries({ email: need(i.email, 'an email').toLowerCase(), first_name: str(i.first_name), last_name: str(i.last_name),
      company_name: str(i.company), website: normalizeDomain(i.website) || str(i.website), phone_number: str(i.phone) }).filter(([, v]) => v));
    const q = new URLSearchParams({ api_key: secret('SMARTLEAD_API_KEY') });
    const r = await fetch(`https://server.smartlead.ai/api/v1/campaigns/${id}/leads?${q}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lead_list: [lead], settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false } }) });
    if (!r.ok) throw await fail('Smartlead', r);
    const j = await r.json().catch(() => ({}));
    const added = j.upload_count ?? j.total_leads ?? null;
    return done({ result: added === 0 ? 'already there or blocked' : 'added' });
  },
};

export const SEND = [hubspot_upsert_contact, instantly_add_lead, smartlead_add_lead];
