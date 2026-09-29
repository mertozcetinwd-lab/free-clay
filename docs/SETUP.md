# Set up Free Clay, step by step

About 15 minutes. You need a computer (Windows, macOS or Linux), and three free things. Every step
says whether **you** do it or the setup script does. With an AI coding agent (Claude Code, Cursor,
Codex), give it [AGENTS.md](../AGENTS.md) and it runs everything except the parts marked YOU.

## 0. What you need (YOU, once)

| What | Why | Where | Cost |
|---|---|---|---|
| Node.js 22 or newer | runs the setup, the tests and the local preview | https://nodejs.org (the LTS button) | free |
| Git | downloads this repo | https://git-scm.com/downloads (macOS: `xcode-select --install`) | free |
| A Cloudflare account | where your Free Clay lives | https://dash.cloudflare.com/sign-up | free plan is enough |

Check them in a terminal:

```bash
node --version
git --version
```

Node must say v22 or higher.

## 1. Get the code

```bash
git clone https://github.com/mertozcetinwd-lab/free-clay.git
cd free-clay
npm install
```

No GitHub account needed. Or download the ZIP from the repo page (Code, Download ZIP) and unzip it.

## 2. Run the setup

```bash
npm run setup
```

It walks through seven steps and skips anything already done, so you can run it again safely:

1. **Checks** Node and installs wrangler (Cloudflare's command line).
2. **Cloudflare login (YOU):** a browser window opens; approve it and come back.
3. **Database:** creates a D1 database called `free-clay`, writes its id into `wrangler.toml`,
   and creates the tables.
4. **App password:** makes a random password for your Free Clay and sets it as a Cloudflare secret.
   It is printed once at the end: save it in your password manager.
5. **Keys (YOU, optional):** for each provider it shows what it unlocks, what it costs and where to
   get it, then asks if you want to add it now. If yes, wrangler asks for the value: paste it there.
   It goes straight to Cloudflare and is never shown again. See [KEYS.md](KEYS.md).
6. **Open data:** downloads the free business data for the states you pick (FL by default; ALL is
   about 1.2 GB) from [free-clay-data](https://github.com/mertozcetinwd-lab/free-clay-data) and
   builds the map tiles. See [DATA.md](DATA.md).
7. **Deploy:** publishes it and prints your address, like `https://free-clay.yourname.workers.dev`.

Options: `--states FL,GA`, `--all-states`, `--no-data`, `--keys-from-env` (reads keys from a `.env`
in this folder, see `.env.example`), `--yes` (no questions), `--dry` (show the plan, change nothing).

## 3. First five minutes in the app

1. Open the address and sign in with the password.
2. **Settings, Data sources:** add a contact email. OpenStreetMap's place search and SEC EDGAR ask
   every app for one. Then press **Run check**: each free source should say 200 OK.
3. **Settings, AI context:** describe your business in a few lines; agents use it.
4. **Find leads, Local businesses:** type a town, pick a category, Search this area. Free.
5. **Home, Start from template:** pick "Website health check", paste a few websites, press Run.

## Doing it by hand instead

Everything the script does, as plain commands:

```bash
npx wrangler login
npx wrangler d1 create free-clay
```

Copy the `database_id` it prints into `wrangler.toml` (replace `PASTE_YOUR_DATABASE_ID_HERE`), then:

```bash
npx wrangler d1 execute free-clay --remote --file schema.sql
npx wrangler d1 migrations apply free-clay --remote
npx wrangler secret put APP_PASSWORD
node dev/get-places.mjs --states FL
npx wrangler deploy
```

Each key, when you want it: `npx wrangler secret put GROQ_API_KEY` (then list the name in
Settings, Keys).

## Updating later

```bash
git pull
npm install
npx wrangler d1 migrations apply free-clay --remote
npx wrangler deploy
```

Migrations only add; they never delete your data. Always apply them before deploying new code.

## Try it without Cloudflare first

```bash
npm run preview
```

Then open http://localhost:8787 (password `preview`). Map, company, job-board, treg and Groq calls
are answered with made-up data, so every page works with no keys and no real requests. Add demo
data with `npm run demo` in a second terminal.

## Run the checks

```bash
npm test
npm run mutate
```

`npm test` runs 200 tests with no network. `npm run mutate` plants real bugs one at a time and
makes sure the tests catch every one.
