# MCP server

Vastra exposes its wardrobe tools as an **MCP server** over Streamable HTTP at
`/mcp`, mounted on the existing Express app. Any MCP client — Claude Desktop,
Claude Code, Home Assistant, other agents — can search the closet, suggest
outfits and save outfits **using its own model**. Vastra only pays for the
`ai`-scope tools (`suggest_outfit`, `try_on`) through `runInstrumented`; the client's
model does the reasoning.

> Self-host only. `/mcp` is gated behind `requireTokensEnabled` and **404s in
> HOSTED_MODE** (the public SaaS), exactly like the personal-API-token routes.
> Run a self-hosted instance (`HOSTED_MODE` unset) to use MCP.

## Prerequisites

1. A self-hosted Vastra instance running on `http://localhost:3000`.
2. A personal API token with the scopes you need (Settings → Connections).
   Tokens are bearer `vst_…` strings; `read` is always included.

| Token scope | Tools it unlocks |
|------------|------------------|
| `read`     | closet, outfit and collection reads, weather/forecast, sizes, `find_related`, `discover_closet`, `list_my_photos` (and the shop tools when enabled) |
| `write`    | outfit and collection changes (in addition to read) |
| `ai`       | `suggest_outfit`, `try_on` (in addition to read) |

The full list is the [tool table](#tool-list) below.

The token's scopes filter **both** `tools/list` and `tools/call`: a tool whose
scope isn't on the token is omitted from the list **and** rejected on call
(JSON-RPC `MethodNotFound`), not just hidden.

## Connect a client

### Claude Code (tested)

```sh
claude mcp add --transport http vastra http://localhost:3000/mcp \
  --header "Authorization: Bearer vst_YOUR_TOKEN_HERE"
claude mcp get vastra   # should show "✔ Connected"
```

Start a new Claude Code session afterwards; the tools load at session start.
Remove it with `claude mcp remove vastra -s local`.

### Claude Desktop

Claude Desktop's config file launches local (stdio) servers. Reach Vastra's
HTTP endpoint through the `mcp-remote` bridge. Add this to
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
`%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "vastra": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://localhost:3000/mcp",
        "--header",
        "Authorization: Bearer vst_YOUR_TOKEN_HERE"
      ]
    }
  }
}
```

Restart Claude Desktop. `npx mcp-remote` downloads the bridge from npm on
first run; pin a version (`mcp-remote@x.y.z`) if you want a reproducible
setup. Desktop's Connectors UI can't reach `localhost`, because connectors
are called from Anthropic's servers, so use the config file instead.

### Remote and sandboxed agents (Codex, other non-Claude clients)

`http://localhost:3000/mcp` only works for a client on the same machine.
Agents that run in their own sandbox or on another machine (Codex, cloud
agents, anything not on the Mac running Vastra) can't reach your
`localhost`. For those, use the dev tunnel:

1. Run `npm run dev`. `scripts/dev.ts` opens a cloudflared quick tunnel to
   Vite on `:5173` and prints a `https://<random>.trycloudflare.com` URL (also
   written to `WEB_APP_URL` in `.env`).
2. Point the client at `https://<random>.trycloudflare.com/mcp`. Vite proxies
   `/mcp` to Express on `:3000`, the same way it proxies `/api` and `/images`.
3. Sanity check without a token: a `POST` should return
   `401 {"error":"Unauthorized"}` (JSON). An HTML page means the request
   reached the SPA instead of MCP.

   ```sh
   curl -s -w '\n%{http_code}\n' -X POST https://<random>.trycloudflare.com/mcp \
     -H 'Content-Type: application/json' -d '{}'
   ```

Caveats:

- **The URL changes on every restart.** Quick tunnels are ephemeral. Update
  the client's config each time you restart `npm run dev`.
- **The tunnel makes `/mcp` publicly reachable.** Anyone who learns the URL
  can hit it; the only guard is the bearer token. Mint a narrowly-scoped token
  for the agent (`read` only unless it needs more), keep it out of shared
  configs and repos, and revoke it in Settings → Connections when you're done.
  Stop the tunnel when you're not using it.
- **Sandbox network access.** Some agents block outbound network by default.
  If the agent can't connect, check its own sandbox or environment settings
  and allow outbound access to the tunnel domain.

#### Codex

Codex configures MCP servers in `~/.codex/config.toml` (see OpenAI's
[Codex MCP docs](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)).
Streamable HTTP servers take a `url`. `bearer_token_env_var` names an
environment variable whose value is sent as `Authorization: Bearer …`, which
keeps the token out of the config file:

```toml
[mcp_servers.vastra]
url = "https://<random>.trycloudflare.com/mcp"
bearer_token_env_var = "VASTRA_MCP_TOKEN"
```

```sh
export VASTRA_MCP_TOKEN=vst_YOUR_TOKEN_HERE
```

`codex mcp add vastra --url https://<random>.trycloudflare.com/mcp` also adds
the server, but the CLI has no bearer-token flag, so set
`bearer_token_env_var` in `config.toml` afterwards.

Codex's `[sandbox_workspace_write] network_access = true` controls outbound
network for commands Codex runs in its workspace-write sandbox. OpenAI's
config reference doesn't say whether that setting also applies to MCP
connections, so enable it only if Codex can't reach the server otherwise.
This setup was checked against OpenAI's docs (September 2026) but hasn't
been tested end to end with Codex against Vastra.

### Tokens

Replace `vst_YOUR_TOKEN_HERE` with a token minted in Settings → Connections.
For outfit suggestions, give the token the `ai` scope; for saving outfits, the
`write` scope. A read-only token is safest for trying it out. Tokens are
secrets: revoke one in Settings → Connections if it ends up in a chat log or
a shared config.

### Before you try suggestions: pass a location

`get_weather` and `suggest_outfit` resolve a location in this order:

1. **Explicit input** — pass `location` (a place name, geocoded with the same
   Open-Meteo geocoder the Settings location picker uses) **or** `lat`+`lon`
   (validated ranges; the two forms are mutually exclusive).
2. **Saved location** — the one in Settings → Location, which is opt-in and
   separate from the browser's location.
3. **Error** mentioning both options if neither is available.

The resolved `{ name, lat, lon }` is returned in the tool result so the
client's model can confirm it. An explicit input location is **never
persisted** — it's used for that call only (no settings write, no job-param
snapshot). So "what should I wear in Paris next week?" works without you
saving anything; "what should I wear today?" works once you press **Save** in
Settings → Location.

```
# Pass a place name
{ "location": "Toronto" }
# Pass coordinates
{ "lat": 43.65, "lon": -79.38 }
# Use the saved location
{}
```

## Tool list

All tools take the user's identity from the bearer token — **no** `userId` /
`user_id` / `email` parameter is accepted. Results are JSON text content with an
explicit field allowlist (no `userId` leaks to the client model).

Ids in results are handles for chaining calls (`search_closet` → `get_item`),
not something to show people: users can't search by id. The server's
`initialize` response carries instructions telling the client model to
describe items by colour, category and brand, and outfits and collections by
name. MCP clients show results as text; rendering item cards in the client
(MCP Apps UI) is planned, not built.

| Tool | Scope | Input | Returns (lists capped at 25) |
|------|-------|-------|------------------------------|
| `search_closet` | `read` | `query?`, `category?`, `color?`, `season?`, `occasion?`, `brand?`, `size?` | matching items (id, image, category, color, brand, size) |
| `get_item` | `read` | `id` | full item details (incl. size) |
| `list_outfits` | `read` | `occasion?`, `season?` | saved outfits |
| `get_outfit` | `read` | `id` | outfit + hydrated items |
| `list_collections` | `read` | (none) | outfit collections |
| `get_collection` | `read` | `id` | collection + its outfits |
| `get_weather` | `read` | `location?` or `lat?`+`lon?` (else saved location) | current weather + resolved location |
| `get_forecast` | `read` | `start_date?`, `days?`, `location?` or `lat?`+`lon?` | daily forecast (up to 7 days) |
| `suggest_outfit` | `ai` | `occasion?`, `location?` or `lat?`+`lon?` (else saved location) | 2 AI outfit suggestions + resolved location |
| `create_outfit` | `write` | `name`, `item_ids[]`, `occasion?`, `season?`, `notes?` | the created outfit |
| `update_outfit` | `write` | `id`, `name?`, `item_ids[]?`, `occasion?`, `season?`, `notes?` | the updated outfit |
| `create_collection` | `write` | `name`, `description?`, `outfit_ids[]?` | the created collection |
| `add_outfits_to_collection` | `write` | `collection_id`, `outfit_ids[]` | the collection |
| `remove_outfits_from_collection` | `write` | `collection_id`, `outfit_ids[]` | the collection |
| `update_collection` | `write` | `id`, `name?`, `description?` | the collection |
| `search_shop` | `read` | `query`, `intent?`, `item_ids[]?`, `outfit_ids[]?`, `min_price?`, `max_price?`, `currency?`, `budget[]?`, `sizes[]?`, `location?` \| `country?` | shop products + applied filters (only when the shop is enabled); ships to the saved location's country by default |
| `list_liked_products` | `read` | (none) | liked shop products (only when the shop is enabled) |
| `find_related` | `read` | `kind` (`item` / `outfit` / `collection`), `id` | related items (for an item) or saved outfits, scored; only while a decision provider is configured |
| `discover_closet` | `read` | `query` | closest items + related saved outfits by embedding retrieval (no LLM) |
| `list_my_photos` | `read` | (none) | the user's try-on photos, or a message to add one in the app |
| `try_on` | `ai` | `photo_id?`, `item_ids[]` or `outfit_id`, `instruction?` | try-on image, saved to Try On history |
| `get_my_sizes` | `read` | (none) | `{ sizes, editAt }`, or `{ disabled: true, editAt }` when "Use my sizes in Ask" is off |

Costs: `find_related` uses the free, centrally funded decision model (no
wallet debit; shares the in-app Find related daily cap and reuses a still-valid
saved result). `discover_closet` makes at most one cached query embedding and
no LLM call. `try_on` is the paid image generation (wallet-debited in
HOSTED_MODE; free self-hosted) and saves the result to Try On history. No tool
adds items or uploads photos — add a try-on photo in the app.

This table is checked against the tool registry (`src/agent/tools.ts`) by
`test/docs/mcpDocs.test.ts`: add a row when you add a tool.


**Sizes are read-only for agents** (#329). The sizes on the user's own items
are the main reference: `search_closet` returns each item's `size` and filters
on it with `size` (case- and space-insensitive, so `32x30` matches `32 × 30`).
Many items have no size (hijabs, kurtis, accessories), which is normal.
`get_my_sizes` is an optional fallback: the per-category sizes from
Settings › Sizes, or `{ disabled: true }` while "Use my sizes in Ask" is off.
No tool changes sizes. `get_my_sizes` returns `editAt: "/settings/sizes"` so
the client model can tell the user where to update them (an item's own size is
edited in its details). Sizes are personal data and only ever go back to the calling
agent — never to stores, Discover or analytics.

`get_weather` and `suggest_outfit` resolve a location from explicit input
(`location` place name, or `lat`+`lon`) before falling back to the user's saved
location from Settings (server-side location, opt-in). They throw if neither is
available. An explicit input location is never persisted — it's used for that
call only (#333).

## Auth & security model

- **Bearer-only.** `/mcp` authenticates with `Authorization: Bearer vst_…`
  through `requireApiToken` (#321). Cookies are **not** accepted (the
  `closet-auth` cookie does not work on `/mcp`), so the cookie/CSRF surface
  never applies here.
- **401 before any MCP parsing.** A missing or invalid token is rejected by
  the auth middleware before the MCP transport processes the request.
- **Per-user isolation.** The token resolves to a single user; every tool
  call is scoped to that user. A token minted for user A cannot read user B's
  items (foreign ids return `not found`, never `forbidden` — no information
  leak).
- **`ai`-scope tools are instrumented.** `suggest_outfit` and `try_on` go through
  `runInstrumented` carrying `tool_call_id` = the JSON-RPC request id, so the
  `ai_calls` ledger records it (no-op in self-host, wallet-debited in
  HOSTED_MODE — but `/mcp` is off in HOSTED_MODE today).
- **Rate-limited per token.** 120 requests/min overall, plus a stricter
  20/min budget for `ai`-scope tool calls (`suggest_outfit`, `try_on`), since those spend
  the operator's model budget. Over the limit → `429 { error: 'rate_limited' }`.

## Transport details

- **Streamable HTTP, stateless.** One MCP `Server` + `StreamableHTTPServerTransport`
  per request; no per-session server state. JSON responses (not SSE) — the
  tools are simple request/response with no streaming or notifications.
- `/mcp` is **not** under `/api`, so it's mounted **before** the SPA fallback
  in `server.ts` (otherwise the SPA would shadow it). For the same reason the
  Vite dev server needs its own `/mcp` proxy entry in `vite.config.ts`, which
  the dev tunnel depends on. GET/DELETE `/mcp`
  return `405 Method not allowed`.

## Home Assistant

Point the Home Assistant MCP integration at `http://localhost:3000/mcp` with
the `Authorization: Bearer vst_…` header. A read-only token is enough for
closet search; add `ai` if you want outfit suggestions exposed to the assistant.
