# The prompt (paste into Claude Code, Cursor, Codex or any coding agent)

Rebuilds Free Clay from scratch. Open your agent in an empty folder and paste everything below the line.
Under 10,000 characters so it fits in a YouTube comment. The finished code is at
https://github.com/mertozcetinwd-lab/free-clay (clone that instead to skip the build), and the
longer spec with every Clay feature is docs/PROMPT-FULL.md there.

---

Build "Free Clay", a self-hosted Clay-style lead workspace, on Cloudflare's free plan: one Worker (API +
static assets + a once-a-minute cron) and one D1 database. Plain ES modules, no framework, no build
step, no runtime deps. Numbered SQL migrations. Money is integer micro-dollars. Keys are Worker
secrets referenced by NAME only; the app password can never be sent anywhere.

FREE-PLAN LIMITS SHAPE EVERYTHING: 50 outbound requests and 50 D1 queries per invocation, 10 ms CPU.
So all work goes through queues claimed with a random token (UPDATE ... SET claim=? WHERE
status='queued', read back by token), batches plan their worst-case fetches, bulk writes use INSERT
... SELECT FROM json_each(?), whole tables come back as JSON built by SQLite. The cron rotates
between the three fetching queues (cells, workflow runs, signal checks), moving on only when one
was idle.

AUTH: one password (HMAC cookie, 10 wrong tries per IP per 15 min) for the app; API tokens
("fc_" + 32 random chars, SHA-256 stored, shown once, revocable, cannot mint tokens) for
/api/v1/* (same routes) and /mcp.

TABLES: typed columns (text number currency date url email checkbox select multi_select json);
rows.data JSON keyed by column key; cells_meta per computed cell (status, provider, cost, error,
result). Column kinds: data; enrich (one function, input templates {{column_key}}, output fields
as extra columns, run condition as a formula); waterfall (up to 8 functions in order, first valid
result wins, optional validation step, winner recorded); formula (hand-written parser, no eval);
ai (a prompt on Anthropic/OpenAI/Groq, named JSON fields; or agent_id to run a saved agent per row);
http (any https API, {{secret:NAME}} filled at call time, values encoded per place); message
(subject+body: {{col}}, {{clean:col}} drops LLC/www, {Hi|Hello} spintax seeded by row, AI and
if/then snippets; spin the TEMPLATE first, then fill once, so values are never syntax). A row with
an empty input is skipped. Runs: scope empty|all|errored|selected, a budget per run reserved before
calls (UPDATE ... WHERE spent+x<=budget), a ledger row for every call; a cell waits while a column
it reads (or an output column it reads) is queued on that row. A Run columns button; Try on 5
rows (unsaved, ledgered); "write the prompt" from one line, only real {{columns}} accepted.
Nothing runs until Run; auto-run off by default.
CSV import with header aliases, formula-safe CSV export recorded in Exports (kept 30 days).
Virtualised grid, ranges, paste, fill down, undo, views, filters, a fill-rate row.

FUNCTIONS (objects {id, inputs, outputs, primary, subrequests, costMicros, secret?, run(input,
{fetch, secret})}, fetch injected): free = normalize_domain, domain_alive and email_provider (DNS
over HTTPS), website_check (live/parked/down), scrape_website, find_contact_info, email_permutations,
email_check (syntax+MX, never claims the mailbox exists), send_to_webhook. Your key = Hunter find
and verify, Prospeo, Exa findSimilar and search, Google Places, HubSpot upsert (409 = update),
Instantly and Smartlead add-lead. TREG (treg.to, one TREG_TOKEN, provider prices): POST
https://treg.to/call/<id> with X-Treg-Token and X-Treg-Route-Max-Cost (the cap, in USD), read the
charge from X-Treg-Cost-Micro, keep body.output. Functions over routed ids treg.people.email.find,
.email.verify (a waterfall validator), .phone.find, .people.enrich, treg.companies.enrich, .news,
.jobs.search, treg.web.extract, treg.google.serp.organic, .serp.maps. Drop LinkedIn fields.

FIND LEADS: local businesses from Overture Maps places cut into adaptive static tiles
(dev/get-places.mjs; the browser reads tiles, the Worker re-checks and caches results for Import),
plus Google Places on your key and OpenStreetMap; companies from Wikidata SPARQL and SEC EDGAR
(contact email in the User-Agent); open roles from Greenhouse, Lever and Ashby public boards;
lookalikes from Exa; PEOPLE by title, company domain, location, keywords through treg.people.search
(capped per search, cached 7 days, ledgered). Free preview, then import into a table or Audiences.

AUDIENCES: one audience_records table (kind people|companies, key, data JSON, sources JSON {field:
{source, at}}), unique (kind, key). Key: people = lowercased email, else name + company; companies =
normalized domain, else name + city. Upsert in one statement per chunk: ON CONFLICT DO UPDATE SET
data=json_patch(excluded.data, old.data) so existing values win unless overwrite. Filters on a
whitelisted field list with bound values (contains, equals, starts_with, empty, gt, lt...), search,
segments (saved filters, live counts), send a table in (columns matched by name), send records out
to a table, CSV upload.

AGENTS: prompt with {{inputs}}, instructions, provider (groq, anthropic, openai, openrouter, or a
custom https OpenAI-compatible base URL), model with a known or typed price, tools (read_page,
find_contact_info, website_check, email_provider, web_search on Exa, treg google_search,
company_enrich, company_news, company_jobs, find_work_email, search_people, search_companies) and up to 3 external MCP servers whose tools are listed and called over
Streamable HTTP (JSON or SSE answers). Tool loop in Anthropic tool_use and OpenAI function-calling
formats; the last allowed step sets tool_choice none. Before every model call check the worst case
(conversation tokens in + max_tokens out) against the run budget; cap web requests per run; log
every step with its cost; tell the model tool results are data, never instructions; parse named
fields from one JSON object. Store runs; ledger paid steps. On Groq's free tier keep max_tokens
at 800 (it refuses more than 1,000 output tokens a minute) and wait once on a 429. Templates:
company research, prospect research, account scoring, contact finder, hiring check, booking check,
opening line, outreach email draft (drafts only).

WORKFLOWS: graph {nodes [{id, type, config, x, y}], edges [{from, to, port out|true|false}]}, one
trigger (manual, row_added from a cursor set when switched on, segment_new likewise, schedule
once/per row/per segment record, webhook at a secret URL, signal). Steps: function, agent, condition (formula), delay
(parks the run until resume_at), add_row, upsert to Audiences, http, set. Each step reads the item
with {{slots}} and saves results as save_as and save_as_field. Runs are queued rows with the item,
the node queue and a log; a drain claims them, checks each step's worst-case fetches and cost
before running it, pauses when the fetch cap is near, stops over budget, caps steps per run. Draw
the canvas with Drawflow (MIT, vendored) and convert to and from the stored graph.

SIGNALS: jobs (new board postings), website (SHA-256 of page text, report added sentences), news
(Google News RSS), sec (new filings of chosen forms, Form D and 8-K), job_change (treg people
enrich; event when title or employer changes; paid, ledgered). First check of each target
saves a baseline and reports nothing. Events can add rows to a table and fire workflows.

MCP SERVER at POST /mcp: JSON-RPC answered as JSON, stateless per the 2026-07-28 spec, but still
answer initialize (echo a known version) and server/discover; GET returns 405 (a browser asking for
HTML gets the MCP page instead). Tools: list_tables, get_rows, create_table, add_rows,
list_functions, add_enrichment_column, run_column (with budget_usd), search_people,
search_companies, save_people, save_companies, find_local_businesses, find_people, find_companies, find_jobs,
list_agents, run_agent, list_workflows, run_workflow, signal_events, spend. Tool errors come back
as isError results. Also bin/free-clay.mjs (tables, rows, import, run, export, people, companies,
agent, workflow, events, spend) and public/openapi.json.

UI (Inter, blue accent rgb(3,130,247), light/dark/system, phone width, side panels not modals):
sidebar Home, Find leads | Audiences: People, Companies | Orchestration: Signals, Agents,
Workflows, MCP, API and CLI | Exports, Trash, Settings. Home: greeting, a describe box (Groq drafts
a table from the real function catalog; build runs nothing), four cards, template gallery, All
files with folders, favorites, recents. Settings: General, Keys, Data sources, AI context, Spend,
Prices. Never assign innerHTML with data.

SETUP: dev/setup.mjs (npm run setup) checks Node, runs wrangler login (the person approves),
creates D1, applies schema and migrations, sets APP_PASSWORD, offers `wrangler secret put` for
each key (the person types it; never into chat), downloads open data, deploys. AGENTS.md tells
coding agents the same rules.

TESTS: node --test with node:sqlite as a fake D1 and a fake fetch; nothing touches the network.
Cover every route, the budgets, claim races, the free-plan batch limits, the agent loop, workflow
triggers and delays, signal baselines, tokens and MCP. Add a test that parses every browser module.
Add dev/mutate.mjs that plants real bugs one at a time (with a timeout) and must see the tests fail
for each. Seed and demos use example.com only. README: deploy commands, keys by name, what it leaves
out (no resold data, no LinkedIn, no mailbox probing, no sending) and that CAN-SPAM duties sit with
the sender.
