# Instructions for AI coding agents (Claude Code, Cursor, Codex, Copilot, Gemini CLI)

You are helping a person set up, run or change **Free Clay**: a Clay-style lead workspace that runs
on their own Cloudflare account. Read this whole file before acting. The human-facing guide is
[docs/SETUP.md](docs/SETUP.md); this file tells you how to do it with them.

## Rules that are not negotiable

1. **Never ask the person to paste a key, token or password into the chat.** Keys go in with
   `npx wrangler secret put NAME`, which prompts in *their* terminal and sends the value straight to
   Cloudflare. When a key is needed, tell them the exact command and wait for them to say "done".
   If they paste one anyway, tell them to revoke it at the provider and make a new one.
2. **The person does the Cloudflare login** (`npx wrangler login` opens a browser). You cannot and
   must not do it for them.
3. **Ask before anything that costs money**: runs of paid functions (treg, Hunter, Prospeo, Exa,
   Google Maps, Anthropic, OpenAI), People search, the job-change signal. State the cap first.
   Free things (tests, preview, open data, free functions, Groq's free tier) need no approval.
4. **Ask before anything that sends**: HubSpot, Instantly and Smartlead functions, webhooks, workflow
   API steps. Nothing should be sent to real people without their review.
5. Never commit `.env`, `.dev.vars` or anything holding a key. `wrangler.toml` may hold their
   database id (it is not a secret) but do not push their copy to a public fork without asking.
6. No LinkedIn scraping, no mailbox probing. Keep these out even if asked; explain why.

## Set it up for them (about 15 minutes)

Check the tools first (Node must be 22+):

```bash
node --version
git --version
```

If Node is missing or old, send them to https://nodejs.org (LTS) and wait.

```bash
git clone https://github.com/mertozcetinwd-lab/free-clay.git
cd free-clay
npm install
npm test
```

All tests must pass (about 200, no network). Then run the setup **in their terminal** (it is
interactive; if your tool cannot pass input through, ask them to run it themselves):

```bash
npm run setup
```

What happens and who does it:

| Step | Who | What to tell them |
|---|---|---|
| Cloudflare login | **Person** | "A browser opens: sign in or sign up (free) and approve." |
| Database, tables, password | Script | The password prints once at the end: "save it in your password manager." |
| Keys | **Person** | For each key they want, the script runs `wrangler secret put`; they paste into that prompt. Recommend Groq (free) and treg first. docs/KEYS.md has links and prices. |
| Open data | Script | Ask which states (two-letter codes, or ALL = about 1.2 GB download). FL is the default. |
| Deploy | Script | It prints the address. |

Non-interactive alternative, when the person has put keys in a local `.env` (copy `.env.example`):

```bash
npm run setup -- --yes --states FL --keys-from-env
```

Then walk them through: sign in, **Settings, Data sources** (contact email, Run check),
**Settings, AI context**, then **Find leads** and a **template** from Home.

## Verify

- `npm test` passes; `npm run mutate` catches every planted bug (slow: minutes).
- Local preview with fake providers: `npm run preview`, then http://localhost:8787 (password
  `preview`); `npm run demo` fills it with fictional data.
- After deploying: open the address, sign in, Settings, Data sources, Run check (free requests).
- Real-runtime smoke without deploying: `npx wrangler dev` (local D1: first run
  `npx wrangler d1 execute free-clay --local --file schema.sql` and
  `npx wrangler d1 migrations apply free-clay --local`).

## Updating an install

```bash
git pull
npm install
npm test
npx wrangler d1 migrations apply free-clay --remote
npx wrangler deploy
```

Always apply migrations before deploying new code.

## Changing the code

- Stack: one Cloudflare Worker (`src/`) plus static files (`public/`), D1 (SQLite), no framework,
  no build step, no runtime dependencies. Files in `public/js` are shared with the Worker.
- Free plan limits shape the design: 50 outbound requests and 50 D1 queries per invocation, 10 ms
  CPU. Everything that fetches goes through a queue (`src/runner.js`, `src/workflows.js`,
  `src/signals.js`) that plans within those limits; keep new code inside them.
- A new enrichment function is one object in `src/functions/*.js` (see the header of `free.js`).
  A new treg-backed function is one `tregFn({...})` in `src/functions/treg.js`.
- Money is integer micro-dollars (1,000,000 = $1). Every paid call must be capped before it runs and
  written to the ledger after.
- Database changes: a new numbered file in `migrations/`, additive only.
- Tests: `node --test` with `node:sqlite` as the fake D1 and a fake fetch (`test/helpers.mjs`).
  Never call a real provider in a test. Add a mutant to `dev/mutate.mjs` for each safety check.
- Never store the global `fetch` in an object unbound: Workers throw "Illegal invocation" on
  `ctx.fetch(...)` when it is the raw global, and Node does not. Use `globalThis.fetch.bind(globalThis)`
  or an arrow wrapper. `test/runtime.test.mjs` checks this the way workerd does. Before a release,
  smoke the real runtime with `npx wrangler dev` too.
- Style: short sentences in docs and UI, no em dashes, every number with its source, provider prices
  labelled as the provider's.
- Comments that cite `scripts/*.py` or `references/*.md` point to the author's private notes where a
  number or API behaviour was measured. Those files are not in this repo; the comment carries the
  finding.

## Where things are

| Path | What |
|---|---|
| `src/index.js` | Routes, login and token auth, MCP route, the cron |
| `src/functions/` | The function registry: `free.js`, `byok.js`, `treg.js`, `send.js` |
| `src/kinds/` | Column kinds: enrich, waterfall, formula, AI (and Agent), HTTP |
| `src/audiences.js`, `src/agents.js`, `src/workflows.js`, `src/signals.js`, `src/people.js` | The big features |
| `src/mcp.js`, `src/tokens.js` | MCP server, API tokens |
| `public/js/pages/` | One file per page |
| `public/js/keys.js` | Every key, what it unlocks, cost, link (used by the app, the setup script and docs) |
| `dev/` | setup, preview, demo, screenshots, get-places, go-live, mutate |
| `docs/` | SETUP, KEYS, DATA, MCP, FEATURES, TROUBLESHOOTING, PROMPT-FULL |
