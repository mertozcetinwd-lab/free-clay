# Free Clay

A lead-research workspace you own, running on Cloudflare's free plan. Tables with enrichment
columns, a People and a Companies database, agents, workflows, signals, an MCP server, an API and a
CLI. You pay each provider directly on your own key, or nothing at all for the free sources it
ships with.

It rebuilds the software Clay sells: the table and waterfall, Audiences, Claygents, Workflows,
Signals, MCP and the API. It does not resell anyone's data. More on that below.

> Not affiliated with Clay Labs. "Clay" is their name; this is an independent, open-source rebuild.

## What it does

**Find leads** (free unless noted)
- **Local businesses:** 15,482,798 US places from Overture Maps (release 2026-09-23.0, counted in the built tile index; licences
  CDLA Permissive 2.0, Apache 2.0 and CC0), searched on a map by category and radius, as static
  files your Worker serves. Google Maps on your own key and OpenStreetMap are the other two sources.
- **Companies:** Wikidata by industry and state (CC0), and every US public company from SEC EDGAR.
- **Jobs:** open roles from public Greenhouse, Lever and Ashby boards.
- **Lookalikes:** companies like a customer you paste, from Exa on your key.

**Tables**
- Typed columns, a virtualised grid (20,000 rows), ranges, copy and paste, fill down, undo, views,
  filters, a "%" fill-rate row, CSV in and out, a signed webhook in.
- **Enrichment columns** (one function), **waterfalls** (providers in order, first valid hit wins,
  the winner recorded), **AI columns** on your key, **Agent columns** (a saved agent per row),
  **formulas**, and **HTTP columns** for any API.
- Nothing runs until you press Run. Every run has a budget, reserved before any call; every call is
  in a ledger, free ones too.
- Seven templates (website health, inbound leads, work emails, lookalikes...) and a "describe what
  you want" box that drafts a table on Groq's free tier.

**Audiences**
- One **People** and one **Companies** database across all tables. The same email (people) or
  domain (companies) is the same record. New values fill blanks; values already there stay unless
  you choose to overwrite. Each value shows where it came from and when.
- Filters, search, **segments** (saved filters that stay current), send any table in, send any
  segment out to a table, upload a CSV, save Find leads results straight in.

**Agents** (Clay calls them Claygents)
- A prompt with `{{inputs}}`, a model on your key (Groq free tier, Anthropic, OpenAI, OpenRouter or
  your own OpenAI-compatible endpoint), tools it may call, and named output fields.
- Tools: read a page, find contact info, check a website, email provider, web search (Exa), look
  up your People and Companies, and **any MCP server** you point it at.
- A step limit, a budget per run checked before every model call, a cap on web requests, and every
  step logged with its cost. Tool results are passed to the model as data, never as instructions.
- Seven templates: company research, account scoring, business contact finder, hiring check,
  online booking check, opening-line draft, blank.

**Workflows**
- Triggers: by hand, a row added to a table, a schedule (once, or per row, or per segment record),
  a webhook URL, a signal.
- Steps: run a function, run an agent, condition, delay (up to 7 days), add a row, save to People
  or Companies, call an API, set values. Drawn on a canvas; every run logged step by step with its
  cost; a budget per run.

**Signals**
- New job posts, website changes (what text was added), Google News stories, and SEC filings
  (Form D for private raises, 8-K for news). The first check saves a baseline, so you only hear
  about what is new. Each event can add a row to a table and start workflows.

**MCP, API and CLI**
- An **MCP server** at `/mcp` with 20 tools, for Claude, ChatGPT and Cursor. It follows the
  2026-07-28 spec (stateless Streamable HTTP) and still answers older clients.
- A **REST API** at `/api/v1` (every route the app uses, described in `/openapi.json`) and a
  **`free-clay` command** (`bin/free-clay.mjs`, Node 18+, no installs).
- API tokens are shown once and stored as SHA-256 hashes; revoke one and it stops at once.

**Also:** Exports (every CSV download kept 30 days), Trash (30 days), Spend by provider and table,
AI context (what your agents know about your business), light, dark and phone layouts.

## What it does not do, on purpose

- **No resold database.** Clay sells its own database (302M people and 48M companies, Clay's count)
  and data from about 130 providers (Clay's count). Here the data is open data you can check, your
  own imports, and the providers you choose to pay.
- **No LinkedIn data.** Scraping LinkedIn breaks its terms.
- **No mailbox probing.** Workers cannot open port 25, so the free email check stops at "the domain
  accepts mail". For "this mailbox exists", use a verifier on your key.
- **No sending.** Agents draft; nothing is emailed. If you send what you find, CAN-SPAM duties sit
  with you as the sender: a real address, a working unsubscribe you honour, honest subjects.

## What we saw when Clay spent its own credits

We spent 18.5 of a Free workspace's 200 credits and 28 of its 500 actions (Clay's Settings, Usage,
2026-09-28) on fictional example.com rows, to see what paid enrichment does. Clay's figures:

- Its Work Email waterfall tried 11 providers. Every miss was refunded ("Charged: 0 (Refunded)").
  All 5.5 credits went to one provider that guessed `name@example.co` for rows whose website was
  example.com, billed 1.1 credits a row, including 2 rows its own validator marked invalid.
- Its Enrich company matched placeholder domains to unrelated pages and billed them as hits.
- Its agent builder's test runs were not billed.

What Free Clay does differently: waterfalls can require a validation step before a result counts, the
provider that answered is recorded per cell, and every paid call is in your own ledger at the
provider's price. (From the author's Clay teardown notes, 2026-09-28.)

## What it costs

- **Running it:** $0 on Cloudflare's free plan. One Worker, one D1 database, static files for the
  open data (limits at developers.cloudflare.com/workers/platform/limits and /d1/platform/limits,
  read 2026-09-27). The free plan's 50 outbound requests per invocation are why runs go through
  queues: each batch takes what fits and the next carries on.
- **Per use:** whatever your providers charge, or $0 for the free sources.

For comparison, Clay's own prices, read in its app on 2026-09-27: Launch $185 a month, the HTTP API
column needs Growth at $495 a month, the free plan stops at 200 rows per table, and your own API key
still costs one action per run.

## Deploy it

You need [Node.js](https://nodejs.org) 20 or newer and a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

```bash
npm install
npx wrangler login
npx wrangler d1 create free-clay
```

Copy the `database_id` it prints into `wrangler.toml`, then:

```bash
npx wrangler d1 execute free-clay --remote --file schema.sql
npx wrangler d1 migrations apply free-clay --remote
npx wrangler secret put APP_PASSWORD
node dev/get-places.mjs --states FL
npx wrangler deploy
```

`get-places` downloads the open-data places for the states you pick (all 50 without `--states`,
about 3.1 GB of tiles) into `public/data/places`, which deploy uploads as static files. Updating an
existing install: pull, then `npx wrangler d1 migrations apply free-clay --remote`, then deploy.

`node dev/go-live.mjs` does the whole thing in one command and then proves it works (free functions
against real sites, one capped call to each paid function you have a key for, a run end to end).

## Keys

Keys never go in the database, the browser or the code:

```bash
npx wrangler secret put GROQ_API_KEY
```

Then add the same name in Settings, Keys. Names Free Clay looks for: `GROQ_API_KEY` (free tier: the
describe box and agents), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`,
`HUNTER_API_KEY`, `PROSPEO_API_KEY`, `EXA_API_KEY`, `GOOGLE_MAPS_API_KEY`. HTTP columns, workflow
API steps and agent MCP servers can use any name you add. The app password can never be sent.

## Use it from Claude, Cursor or a terminal

Make a token on the MCP page, then:

```bash
claude mcp add --transport http free-clay https://your-worker.workers.dev/mcp --header "Authorization: Bearer fc_..."
```

The MCP page has the Claude Desktop and Cursor versions. For the terminal:

```bash
FREE_CLAY_URL=https://your-worker.workers.dev FREE_CLAY_TOKEN=fc_... node bin/free-clay.mjs tables
```

## Run it on your computer first

`node dev/preview.mjs --fake-opendata` runs the whole app with Node alone (password `preview`).
`--fake-opendata` answers the map, company, job-board and Groq calls with made-up data, so every
page can be tried without a key or a real request.

## How it is built

```
src/index.js         routes, login and token auth, the MCP route, the cron (queues take turns)
src/tables.js        tables, columns, rows, CSV, views      src/runner.js   the cell queue
src/kinds/           enrichment, waterfall, formula, AI (and Agent) and HTTP columns
src/functions/       free.js (no key) and byok.js (your key): each function is one object
src/audiences.js     People and Companies                   src/agents.js   the agent loop
src/workflows.js     graphs, triggers and the run queue     src/signals.js  the four watchers
src/mcp.js           the MCP server       src/tokens.js      API tokens      src/exports.js
src/opendata/        open-data sources with a shared User-Agent and cache
public/js/           the app, plain ES modules; types, formulas and templates are shared with
                     the Worker, so the browser and the server agree
migrations/          numbered database changes       bin/free-clay.mjs   the CLI
dev/                 preview.mjs, d1.mjs (D1 on node:sqlite), mutate.mjs, get-places.mjs, go-live.mjs
```

No build step and no runtime dependencies: `wrangler deploy` uploads the files as they are. The
map is Leaflet (BSD-2) and the workflow canvas Drawflow (MIT), both in `public/vendor/` with their
licences.

## Tests

```bash
npm test
```

190 tests, none of which touch the network (node:sqlite stands in for D1, a fake fetch for every
provider). `node dev/mutate.mjs` plants real bugs one at a time (an agent ignoring its budget, a
revoked token still working, a webhook taking any secret, a signal flooding on its first check,
95 in all) and checks the tests fail for each: 95 of 95 are caught.

MIT licensed. Built by [Mert Ozcetin](https://mertozcetin.kit.com): *build it, don't rent it.*
