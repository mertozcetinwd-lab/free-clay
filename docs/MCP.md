# MCP: use Free Clay from Claude, ChatGPT or Cursor

Free Clay runs an MCP server at `https://<your-worker>.workers.dev/mcp`. It follows the 2026-07-28
MCP spec (stateless Streamable HTTP) and still answers older clients that start with `initialize`.

## 1. Make a token (YOU)

In the app: **MCP** page, **New token**, name it after the app ("Claude Code"). Copy it: it is
shown once and stored only as a hash. Revoke it on the same page at any time.

## 2. Connect

**Claude Code**

```bash
claude mcp add --transport http free-clay https://YOUR-WORKER.workers.dev/mcp --header "Authorization: Bearer fc_YOUR_TOKEN"
```

**Claude Desktop** (Settings, Developer, Edit config: `claude_desktop_config.json`)

```json
{ "mcpServers": { "free-clay": { "command": "npx", "args": ["-y", "mcp-remote", "https://YOUR-WORKER.workers.dev/mcp", "--header", "Authorization: Bearer fc_YOUR_TOKEN"] } } }
```

**Cursor** (`.cursor/mcp.json`)

```json
{ "mcpServers": { "free-clay": { "url": "https://YOUR-WORKER.workers.dev/mcp", "headers": { "Authorization": "Bearer fc_YOUR_TOKEN" } } } }
```

**ChatGPT:** Settings, Connectors, add a custom connector with the server URL and the same
Authorization header (where your plan allows custom headers).

The MCP page in the app shows these with your address and token filled in.

## 3. The 21 tools

| Tool | What it does | Costs money? |
|---|---|---|
| `list_tables`, `get_rows` | Read your tables | No |
| `create_table`, `add_rows` | Build a table and fill it | No |
| `list_functions`, `add_enrichment_column` | See the 28 functions, add one as a column | No |
| `run_column` | Run a column on a table's rows | Only paid functions, up to `budget_usd` |
| `search_people`, `search_companies` | Search your Audiences | No |
| `save_people`, `save_companies` | Add or update Audiences records | No |
| `find_local_businesses` | Open-data businesses near a town (radius up to 5 km here) | No |
| `find_people` | People by title, company, place (treg) | Yes, capped at `max_usd` (default $0.10) |
| `find_companies` | Wikidata by industry, SEC by name or ticker | No |
| `find_jobs` | Open roles from public job boards | No |
| `list_agents`, `run_agent` | Run a saved agent once | Only the agent's model and tools, within its budget |
| `list_workflows`, `run_workflow` | Start a workflow on an item or a table | Only paid steps, within the budget per run |
| `signal_events` | Recent signal events | No |
| `spend` | What paid providers cost this month | No |

Try: "Find roofers within 5 km of Gainesville, FL, make a table of them, add a website check
column and run it."

## 4. Test it from a terminal

```bash
curl -s https://YOUR-WORKER.workers.dev/mcp \
  -H "Authorization: Bearer fc_YOUR_TOKEN" -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: 2026-07-28" -H "Mcp-Method: tools/list" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 5. MCP servers inside Free Clay's agents

The other direction: an agent in Free Clay can use the tools of any MCP server (Streamable HTTP).
In the agent builder: **MCP servers, Add MCP server**, give a name, the https URL and, if it needs
one, the name of a Worker secret holding its bearer token (`npx wrangler secret put THAT_NAME`).
Up to 3 per agent. Each tool call counts against the agent's step limit.

treg also offers its catalog as an MCP server (`https://treg.to/mcp/v2/`, header `X-Treg-Token`);
add it to Claude or Cursor directly with treg's instructions. Inside Free Clay you do not need it:
the treg functions and agent tools already use your `TREG_TOKEN`.
