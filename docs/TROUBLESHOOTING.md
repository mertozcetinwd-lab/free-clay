# Troubleshooting

| You see | Why | Fix |
|---|---|---|
| "The database is missing an update this version needs" | New code, old database | `npx wrangler d1 migrations apply free-clay --remote`, then reload |
| "APP_PASSWORD is not set" | The Worker has no password secret | `npx wrangler secret put APP_PASSWORD` |
| Setup stops at "Not logged in to Cloudflare" | wrangler has no login | `npx wrangler login`, then `npm run setup` again |
| `PASTE_YOUR_DATABASE_ID_HERE` errors | wrangler.toml has no database id | `npx wrangler d1 list`, copy the id for free-clay into wrangler.toml (or run setup) |
| "X is not set. Run: npx wrangler secret put X" | A function or agent needs a key | Add it (docs/KEYS.md), list the name in Settings, Keys, reload |
| Keys page says "Needs ..." though you set it | The name is not listed in the app | Settings, Keys, "List NAME" |
| Find leads, Local businesses: "outside the US" or no results | Tiles for that state were not built | `node dev/get-places.mjs --states XX`, then `npx wrangler deploy` |
| Typing a town gives an error | Place search needs a contact email | Settings, Data sources: add one |
| SEC answers 403 | SEC needs the contact email in the User-Agent | Settings, Data sources: add one; SEC may block for ~10 minutes after a 403 |
| OSM source says servers are busy | Public Overpass servers time out often | Use Open data (the default) or Google |
| Agent or AI column: "Groq HTTP 429 ... Request too large" | Groq's free tier caps output tokens a minute (1,000 on the default model) | Keep Max tokens at 800 or less on Groq; wait a minute between long runs; or use another provider |
| "treg HTTP 402: every provider would cost more than this row's cap" | treg refused rather than go over the cap | Raise the function's price in Settings, Prices (it is the cap), or use another step |
| "treg HTTP 402: your treg balance is empty" | Out of treg credit | Top up at treg.to |
| A run stops with "reached its budget" | The run's budget was used up | Raise it in the Run popover or Settings, Default budget |
| `/mcp` answers 401 | No or revoked token | Make a token on the MCP page; send `Authorization: Bearer fc_...` |
| MCP client cannot connect after deploying | Old wrangler.toml without `/mcp` in `run_worker_first` | Pull the latest wrangler.toml section (`run_worker_first = ["/api/*", "/mcp"]`) and deploy |
| `npm test` fails with "node:sqlite" | Node older than 22.5 | Install Node 22 or newer |
| The page is blank after an update | A cached old file, or a broken deploy | Hard reload (Ctrl/Cmd+Shift+R); `npm test` includes a check that every page file parses |
| Screenshots script: "No Chrome or Edge found" | It drives an installed browser | Install Chrome, or set `CHROME=/path/to/chrome` |

Still stuck: open an issue with the exact message (never include keys, tokens or your password).
