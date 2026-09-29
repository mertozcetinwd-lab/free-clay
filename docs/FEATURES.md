# Every Clay feature, and what Free Clay does instead

Clay's features come from a two-pass teardown of Clay's own app (read 2026-09-27 and 2026-09-28,
including 18.5 credits spent on fictional rows to see paid results). Clay's prices and counts are
**Clay's figures**. Free Clay's costs are the providers' own prices or calls we measured.

Status: **Built** = in Free Clay now. **Your key** = built, runs on a provider key you add.
**Partial** = the core of it, not every option. **Not built** = with the reason, and what to use.

## Cost at a glance

| Job | Clay (Launch, $0.05 a credit) | Free Clay |
|---|---|---|
| Software | $185 a month (Launch), $495 (Growth, for HTTP API and webhooks) | $0: Cloudflare's free plan |
| Local businesses | 1 credit ($0.05) per Google Maps result | **$0** from open data (15.5M US places), or ~$0.00175 a search through treg |
| Company enrichment | 0.5 credits ($0.025) a row | ~$0.0019 a row through treg (measured 2026-09-29): **~92% less** |
| Work email waterfall | ~1.1 credits ($0.055) a row | ~$0.0048 a hit through treg (treg's price; misses mostly free): **~91% less** |
| Google search | credit-priced | ~$0.0005 a search through treg (measured) |
| AI column / agent | 1 to 45 credits a row (Clay's models); 3 credits default AI column | $0 on Groq's free tier; any model at its own token price |
| Your own API key | still one action per run | nothing added |

## Find leads

| Clay | Status | Free Clay |
|---|---|---|
| People search (Clay's 300M-person database) | Your key | Find leads, People: job title, company domain, location, keywords, through treg's routed people search (22 providers). Capped at $0.10 a search, cached 7 days. |
| Find contacts at company (as a column) | Your key | "treg: find a contact at a company": company domain and a job title in, one person out per row, capped at $0.05. Found 3 of 3 where Clay found 2 of 3 ([CLAY-COMPARISON](CLAY-COMPARISON.md)). |
| Company search (48M companies) | Built | Wikidata by industry and US state (free), every US public company from SEC EDGAR (free), companies by domain through treg. |
| Jobs search | Built | Greenhouse, Lever and Ashby public boards (free); any company through treg's jobs search. |
| Local businesses (Google Maps wizard) | Built | Open data: 15.5M US places on a map with category and radius, free and instant. Google Maps on your key. OpenStreetMap. |
| Company lookalikes | Your key | Exa findSimilar on your key (~$0.007 a search). |
| Search by chat ("describe what you're looking for") | Partial | Home's describe box drafts a whole table on Groq; MCP lets Claude or ChatGPT drive every search. |
| Saved searches, recents | Partial | Searches are cached 7 days; imports are recorded. No saved-search list. |
| Import up to 200 rows to tables, 1M to Audiences | Built | Up to 20,000 rows a table; Audiences up to 200,000 records a kind. |

## Tables (workbooks)

| Clay | Status | Free Clay |
|---|---|---|
| Typed columns, views, filters, sort, search, fill-rate row | Built | Same, with a virtualised grid (20,000 rows), ranges, copy/paste, fill down, undo. |
| Enrichment columns with a catalog (~204 providers) | Built | 29 functions: 9 free, 11 through treg (thousands of provider endpoints behind them), Hunter, Prospeo, Exa, Google Places, HubSpot, Instantly, Smartlead. Any other API through the HTTP column. |
| Waterfalls (~66 presets) | Built | Any functions in order, first valid hit wins, optional validation step, winner recorded. Tools, For you has the work-email preset (treg first, then Hunter, then Prospeo, verified by treg). |
| Use AI column | Built | Groq, Anthropic, OpenAI, any priced model; named JSON fields become columns. |
| Claygent column | Built | Agent column: a saved agent runs once per row with a budget per row. |
| Formula column + formula generator | Built | Hand-written formula language; "Write it" turns a sentence into a formula on Groq. |
| Merge columns | Built | Add column, Merge columns. |
| Message column (subject and body template, AI snippets, conditional snippets, spintax) | Partial | An agent (Outreach email draft template) or an AI column drafts; no template editor, no spintax; nothing sends. |
| HTTP API column (Growth plan) | Built | Any https API, keys filled in from Worker secrets. |
| Webhook source (Upgrade) | Built | Signed webhook into any table. |
| Run control, auto-run | Built | Nothing runs until Run; auto-run exists and starts off. Budget cap on every run. |
| Credits chip on every function | Built | Cost chip per function; the ledger records every call at the real price. |
| CSV import with header mapping | Built | Header aliases (Apollo, HubSpot, Maps exports); import runs nothing. |
| Right-click menus, column menu (rename, color, pin, hide, dedupe, sort, filter, insert, duplicate) | Built | Same. |
| Sandbox mode | Not built | Test on a copy: duplicate the table (column menu), or run on selected rows only. |
| Row history / change log | Partial | History shows spend per run and provider; no per-cell change log. |
| Table settings: description, auto-dedupe | Built | Same. "Share as template" and the Chrome extension are not built. |
| Overview canvas of linked tables | Partial | Folders act as workbooks (tabs along the bottom); no canvas. |

## Audiences

| Clay | Status | Free Clay |
|---|---|---|
| People and Companies databases | Built | Deduplicated on email and domain; each value shows its source and date. |
| Segments with a filter builder | Built | Saved filters with live counts (contains, equals, starts with, empty, greater/less than...). |
| Add source: CSV, Clay table, Find people | Built | CSV upload, send any table, save Find leads results (local, companies, people). |
| Add source: Salesforce, HubSpot, Snowflake, BigQuery, Databricks, Gong (Upgrade) | Not built | Export from them to CSV, or push rows in through the API or a webhook. |
| Send to workflow | Built | Workflow trigger "A new record joins a segment", or a schedule over a segment. |
| Sync to ad platforms (Upgrade) | Not built | Export a segment to CSV and upload it to the ad platform. |
| Export to email sequence (Upgrade) | Your key | Instantly and Smartlead: add leads to a campaign. HubSpot: add or update contacts. |
| Data hub, Reporting | Partial | Coverage bars per field on People and Companies; Spend by provider and table. |

## Orchestration

| Clay | Status | Free Clay |
|---|---|---|
| Signals: job posting | Built | Public job boards, free. |
| Signals: news and fundraising | Built | Google News RSS (free); SEC Form D filings for private raises (free). |
| Signals: job change, promotion, new hire | Your key | Job change signal: people you watch, re-checked through treg (~$0.0026 a check, treg's price). |
| Signals: website change | Built | Page text hashed; the event says what was added. |
| Signals: web intent (who visits your site) | Not built | Needs a tracking pixel plus a reverse-IP database; both are paid products. |
| Signals: custom | Built | A workflow on a schedule with any function, agent or API step. |
| Claygents with Clay's models (Helium to Radon) | Built | Agents on Groq (free tier), Anthropic, OpenAI, OpenRouter or your own endpoint; step cap, budget, fetch cap; every step logged with cost. |
| Claygent tools: web search, find contacts and jobs, business context, MCP servers | Built | Read page, contact info, website check, email provider, Exa search, treg Google search, company data, news, jobs, work email, People and Companies lookup, up to 3 MCP servers, business context. |
| Claygent templates (25) | Built | 9 templates: company research, prospect research, account scoring, contact finder, hiring check, booking check, opening line, outreach email draft, blank. |
| Clay Navigator (browser agent) | Not built | Use treg's "read a hard page" tool for JavaScript sites. |
| Workflows: 7 triggers | Built | Manual, row added, new record in segment, schedule (once, per row, per segment record), webhook, signal. CSV upload counts as rows added. |
| Workflows: nodes | Built | Function, agent, condition, delay, add row, save to People or Companies, call an API, set values. |
| Workflows: Run code node | Not built | Workers refuse eval; call your own endpoint with the API step. |
| Workflows: AI Rules conditional | Partial | Conditions are formulas; put an agent step before it to decide. |
| MCP server (ChatGPT, Claude, Slack) | Built | 21 tools, 2026-07-28 spec plus older clients; token per client, revocable. |
| API keys, public API | Built | REST API under /api/v1 with tokens; OpenAPI file. |
| CLI | Built | bin/free-clay.mjs. |

## Around the app

| Clay | Status | Free Clay |
|---|---|---|
| Sculptor chat assistant | Partial | The describe box drafts tables; Claude through MCP does the rest. |
| Templates (12 table templates) | Built | 9 table templates. |
| Exports | Built | Every CSV download kept 30 days. |
| Trash | Built | 30 days. |
| Teams, roles, SSO | Not built | One password per install; API tokens for tools. Deploy one install per team. |
| Credits, usage page | Built | Spend page: by provider, table and month, cost per hit. |
| AI context (business profile) | Built | Settings, AI context. |
| Chrome extension | Not built | |
| 129 connections, 187 integrations | Partial | treg reaches thousands of provider endpoints with one token; the HTTP column reaches any API. |

## Kept out on purpose

- **No LinkedIn scraping or LinkedIn data.** It breaks LinkedIn's terms. LinkedIn fields that a provider returns are dropped.
- **No mailbox probing from the Worker.** Workers cannot open port 25; verification goes to a provider (treg or Hunter).
- **No sending from Free Clay itself.** Agents draft; sequencers you connect send, under your name. CAN-SPAM (US) and GDPR (EU) duties sit with the sender.
