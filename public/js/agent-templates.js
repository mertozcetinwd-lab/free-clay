/**
 * Starting points for new agents, like Clay's Claygent templates (teardown-v2 5.2): Prospecting,
 * Account scoring, Contact scoring, Copywriting. All run on Groq's free tier by default and use
 * only read-only tools. Copy drafts are drafts: Free Clay never sends.
 */

const GROQ = { provider: 'groq', model: 'qwen/qwen3.8-27b' };

export const AGENT_TEMPLATES = [
  {
    id: 'blank', name: 'Blank agent', blurb: 'Start from nothing.', icon: 'sparkle',
    agent: { ...GROQ, name: 'New agent', prompt: '', tools: ['read_page'], fields: [], max_steps: 6 },
  },
  {
    id: 'company_summary', name: 'Company research', blurb: 'Reads the website and says what the business does, for whom, and where.', icon: 'building',
    agent: { ...GROQ, name: 'Company research', tools: ['read_page'], max_steps: 4,
      prompt: 'Read the website {{domain}} and describe the business: what it sells or does, who its customers are, and where it operates.',
      fields: [{ name: 'summary', type: 'text' }, { name: 'industry', type: 'text' }, { name: 'service_area', type: 'text' }] },
  },
  {
    id: 'account_score', name: 'Account scoring', blurb: 'Scores a company 1 to 10 against your ideal customer, with the reason.', icon: 'target',
    agent: { ...GROQ, name: 'Account scoring', tools: ['read_page'], max_steps: 4, use_context: true,
      instructions: 'You qualify companies for a small agency. Be strict: a 10 is a near-perfect fit, a 5 is unclear, a 1 is clearly wrong.',
      prompt: 'Score how well {{domain}} fits our ideal customer, described in the business context. Read their website first.',
      fields: [{ name: 'score', type: 'number' }, { name: 'reason', type: 'text' }] },
  },
  {
    id: 'contact_finder', name: 'Business contact finder', blurb: 'The published main email, phone and owner name (only if the site shows it).', icon: 'user',
    agent: { ...GROQ, name: 'Business contact finder', tools: ['find_contact_info', 'read_page'], max_steps: 5,
      prompt: 'Find the published business contact details for {{company}} (website {{domain}}): the main email, the main phone, and the owner or manager name only if the website states it. Say which page each came from.',
      fields: [{ name: 'email', type: 'email' }, { name: 'phone', type: 'text' }, { name: 'owner_name', type: 'text' }, { name: 'source_page', type: 'url' }] },
  },
  {
    id: 'hiring_check', name: 'Hiring check', blurb: 'Does the company list open roles on its own site, and which ones?', icon: 'briefcase',
    agent: { ...GROQ, name: 'Hiring check', tools: ['read_page'], max_steps: 5,
      prompt: 'Check whether {{domain}} lists open jobs on its own website (look for a careers or jobs page). List the roles if there are any.',
      fields: [{ name: 'hiring', type: 'checkbox' }, { name: 'roles', type: 'text' }, { name: 'careers_page', type: 'url' }] },
  },
  {
    id: 'booking_check', name: 'Online booking check', blurb: 'Can customers book or request a quote online? Which tool do they use?', icon: 'calendar',
    agent: { ...GROQ, name: 'Online booking check', tools: ['read_page'], max_steps: 4,
      prompt: 'Look at {{domain}}. Can a customer book an appointment or request a quote online? If yes, which tool does the site use (for example Calendly, Housecall Pro, Jobber, a form)?',
      fields: [{ name: 'online_booking', type: 'checkbox' }, { name: 'tool', type: 'text' }] },
  },
  {
    id: 'prospect_research', name: 'Prospect research (treg)', blurb: 'Google, company data and recent news in one brief: what they do, how big, what changed lately.', icon: 'search',
    agent: { ...GROQ, name: 'Prospect research', tools: ['read_page', 'google_search', 'company_enrich', 'company_news'], max_steps: 6, use_context: true, budget_micros: 50_000,
      prompt: 'Research {{company}} ({{domain}}): what they sell, roughly how many people work there, where they operate, and anything that changed recently (news, hiring, new services). Use their site first, then the other tools.',
      fields: [{ name: 'summary', type: 'text' }, { name: 'employees', type: 'number' }, { name: 'recent_change', type: 'text' }, { name: 'fit_reason', type: 'text' }] },
  },
  {
    id: 'email_draft', name: 'Outreach email draft', blurb: 'A short, specific first email from their site and news. A draft you review and send yourself.', icon: 'mail',
    agent: { ...GROQ, name: 'Outreach email draft', tools: ['read_page', 'company_news'], max_steps: 5, use_context: true, budget_micros: 30_000,
      instructions: 'You write plain, short cold emails for a small business owner. No flattery, no exclamation marks, no made-up facts, under 90 words. One specific detail from their site or news, one clear question. You only draft; a person reviews and sends.',
      prompt: 'Draft a first email to {{first_name}} at {{company}} ({{domain}}) about how we could help, based on the business context and something specific from their website or recent news.',
      fields: [{ name: 'subject', type: 'text' }, { name: 'body', type: 'text' }, { name: 'detail_used', type: 'text' }] },
  },
  {
    id: 'first_line', name: 'Opening line draft', blurb: 'A short, specific first line for an email, from their website. A draft you review.', icon: 'pencil',
    agent: { ...GROQ, name: 'Opening line draft', tools: ['read_page'], max_steps: 4, use_context: true,
      instructions: 'You write plain, specific openers. No flattery, no exclamation marks, no made-up facts. Mention one real detail from their site.',
      prompt: 'Write one opening sentence (under 25 words) for an email to {{company}}, based on something specific on their website {{domain}}.',
      fields: [{ name: 'first_line', type: 'text' }, { name: 'detail_used', type: 'text' }] },
  },
];
