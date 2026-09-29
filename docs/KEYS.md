# Keys: what each one unlocks

**None is required.** With no keys you get open data (15.5M US businesses), SEC and Wikidata
companies, public job boards, 9 free enrichment functions, tables, Audiences, workflows, signals,
MCP, the API and the CLI.

Start with two:

1. **Groq** (free tier): turns on agents, AI columns, the describe box and the formula writer.
2. **treg** (pay per call, provider price): one token for work emails, phones, people search,
   company data, Google search and Maps, scraping, company news and jobs.

## How to add a key (YOU)

In the free-clay folder:

```bash
npx wrangler secret put GROQ_API_KEY
```

Wrangler asks for the value (hidden) and sends it straight to Cloudflare. Then open **Settings,
Keys** in the app and press **List GROQ_API_KEY** (or run `npm run setup` again, which does both).

Never paste a key into a chat, an issue, a commit or a file you share. An AI agent helping you
should hand you the terminal for this step (see [AGENTS.md](../AGENTS.md)).

## Every key

| Secret name | Provider | Unlocks | Cost (provider's figures) | Get it |
|---|---|---|---|---|
| `GROQ_API_KEY` | Groq | Agents, AI columns, describe box, formula writer | Free tier, rate-limited (1,000 output tokens a minute on the default model) | https://console.groq.com/keys |
| `TREG_TOKEN` | treg | 10 functions (work email over 23 providers, phone, person and company enrich, verify, web extract, Google search, Maps, news, jobs), People search, job-change signal, agent tools | Per call at the provider's price, 0% markup; $1 free once for new teams (treg). Measured: company enrich $0.0019, Google search $0.0005, page extract $0 | https://treg.to (sign in; or `treg login` with their CLI) |
| `ANTHROPIC_API_KEY` | Anthropic | Claude for agents and AI columns | Per token (Sonnet 5 $2 in / $10 out per 1M) | https://console.anthropic.com/settings/keys |
| `OPENAI_API_KEY` | OpenAI | OpenAI models for agents and AI columns | Per token | https://platform.openai.com/api-keys |
| `OPENROUTER_API_KEY` | OpenRouter | Hundreds of models for agents | Per token at each model's price | https://openrouter.ai/keys |
| `EXA_API_KEY` | Exa | Lookalike companies, semantic web search | About $0.007 a search (measured) | https://dashboard.exa.ai/api-keys |
| `GOOGLE_MAPS_API_KEY` | Google Maps Platform | Google Maps as a Find leads source and per-row lookup | $35 per 1,000 Text Search (Enterprise), 1,000 free a month | https://console.cloud.google.com/google/maps-apis/credentials |
| `HUNTER_API_KEY` | Hunter | Find and verify work emails directly | Free plan: 50 finds a month | https://hunter.io/api-keys |
| `PROSPEO_API_KEY` | Prospeo | Find work emails directly | Free plan: 75 credits a month | https://app.prospeo.io/api |
| `HUBSPOT_TOKEN` | HubSpot | Send rows to HubSpot as contacts | Included in your plan; private app with `crm.objects.contacts.write` | https://developers.hubspot.com/docs/api/private-apps |
| `INSTANTLY_API_KEY` | Instantly | Add rows to an Instantly campaign | Included in your plan (API v2 key) | https://app.instantly.ai/app/settings/integrations |
| `SMARTLEAD_API_KEY` | Smartlead | Add rows to a Smartlead campaign | Included in your plan | https://app.smartlead.ai/app/settings/profile |

Any other API: add its key with `npx wrangler secret put ANY_NAME`, list the name, and use it in an
HTTP column or a workflow API step as `{{secret:ANY_NAME}}`. `APP_PASSWORD` can never be sent.

## Money safety

- Nothing runs until you press Run (auto-run starts off).
- Every run has a budget (Settings, default $1.00). It reserves the worst case before any call and
  stops before it would go over.
- treg calls send a hard cap per row (`X-Treg-Route-Max-Cost`); treg refuses rather than spend more.
- Agents check the worst case before every model call against their own budget.
- Every paid call is in the ledger at the real price: Settings, Spend.
- Prices change. Settings, Prices lets you type your own price for any function.
