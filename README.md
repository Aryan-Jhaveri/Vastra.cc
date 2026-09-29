<div align="center">

# Vastra

**Your personal stylist. Your personal inventory. Your personal smart wardrobe.**

https://github.com/user-attachments/assets/6c8c49a0-b35c-4935-8fe0-dd7c167b15dc

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React_18-61DAFB?style=flat&logo=react&logoColor=black)](https://reactjs.org/)
[![Gemini](https://img.shields.io/badge/Google_Gemini-4285F4?style=flat&logo=google&logoColor=white)](https://ai.google.dev/)
[![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)](https://www.docker.com/)

</div>

---

## What is Vastra?

Vastra is a wardrobe app you run yourself. Photograph your clothes and it
categorises them, suggests outfits for today's weather, and lets you try
combinations on virtually before you open the closet. It installs as a PWA on
phones and desktops, and supports several accounts on one instance, each with
its own isolated closet.

- **Closet:** photo → AI fills in category, colours, season and occasion. Scan a
  care label for brand, size and material. Keep several views per item.
- **Outfits:** weather-aware suggestions, a manual outfit builder, collections,
  and scheduled reminders with push notifications.
- **Try-on:** put closet items (or garments from anywhere) on a photo of
  yourself, with an optional instruction.
- **Discover:** upload an inspiration photo (or open a shared outfit link), and
  Vastra finds matching pieces and outfits in your closet.
- **Ask:** a chat agent over your closet, weather and outfits.
- **MCP server:** connect your own agent (Claude Code, Claude Desktop, and other
  MCP clients) with a personal token. See [MCP.md](MCP.md).

## Quick start (Docker)

You need Docker with the Compose plugin.

```bash
git clone https://github.com/Aryan-Jhaveri/Vastra.cc.git vastra
cd vastra
./install.sh
```

The installer writes `.env`, starts the stack and offers `make setup` to pick
AI providers (Gemini, OpenRouter, or your own Ollama). Then create your account,
which prints a one-time sign-in link:

```bash
docker compose exec closet node src/transport/web/admin/admin.mjs create-admin you@example.com
```

Open http://localhost:3000. With no API keys at all, Vastra starts in mock mode
so you can look around first. Only accounts you create can sign in until you set
`ALLOW_SIGNUPS=true`. [DEPLOY.md](DEPLOY.md) covers GPU model servers, Ollama on
a Mac, HTTPS, updates and backups.

## Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Aryan-Jhaveri/Vastra.cc)

One click in the browser, no CLI. It needs a paid instance for the persistent
disk. After the first deploy, open the service's **Shell** and run the
`create-admin` command above; see [DEPLOY.md](DEPLOY.md#render).

## Local development

Node 22 is what the Docker image uses.

```bash
npm install
(cd src/transport/web/app && npm install)
cp .env.example .env      # at minimum set GEMINI_API_KEY, or keep the mocks
npm run web:dev           # API on :3000, Vite on :5173
```

Open http://localhost:5173. Sign in with your email: without a mail provider
configured, the sign-in link is printed in the server log (in dev, open it on
port 5173 instead of 3000). Migrations run
automatically when the server starts.

## AI keys: three layers

You can go from zero cost to fully real AI one step at a time.

| Layer | What you get | How |
|---|---|---|
| **Mock** (default) | Try-on, image generation and embeddings return fixtures; nothing is billed | `MOCK_AI_IMAGE_GEN=true`, `MOCK_EMBEDDINGS=true` |
| **Gemini key** | Real categorise, tag scan, suggestions and chat | `GEMINI_API_KEY` from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) (free tier) |
| **Your own models or providers** | Real image generation and embeddings, other vendors, or no cloud at all | See below |

Options for the third layer, all set by the instance operator in `.env`:

- **Vertex AI:** set `GCP_PROJECT_ID` and `GOOGLE_APPLICATION_CREDENTIALS`, and
  Gemini calls bill to your Google Cloud project.
- **OpenRouter:** set `OPENROUTER_API_KEY`. Any model id containing a `/`
  (for example `mistralai/mistral-small-3.2-24b-instruct`) routes through it.
- **Local models:** any OpenAI-compatible server (Ollama, llama.cpp, vLLM, LM
  Studio). Set `OPENAI_COMPAT_BASE_URL` and prefix a model id with `local/`,
  e.g. `VISION_MODEL=local/qwen3-vl-8b`. Local calls cost nothing.
- **Decision provider** (ranking and "Find related"): `DECISIONS_PROVIDER` is
  `openrouter` (default, uses `OPENROUTER_API_KEY`), `typesafe` (a
  TypeSafe-compatible server at `DECISIONS_URL`), or `llm` (any chat model via
  `DECISIONS_MODEL`). With none configured, Related sections are hidden and
  ranking falls back to simpler ordering.

Every variable is documented in `.env.example`.

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript (ESM) on Node |
| Database | SQLite + Drizzle ORM |
| AI | Gemini, OpenRouter or any OpenAI-compatible server |
| Backend | Express v5 |
| Frontend | React 18, Vite, Tailwind CSS v4, Radix UI |
| Scheduling | Croner |
| Push | VAPID + web-push |
| Tests | Vitest + Testing Library |

## Architecture

The core (database, tools and AI) doesn't depend on the web layer, so another
client can reuse the same functions.

```
src/
  ai/         categorise, suggest, try-on, hero image, discover, chat
  agent/      the Ask agent and its tool registry (also served over MCP)
  db/         SQLite schema, queries and migrations
  storage/    image compression and per-user storage
  tools/      core logic shared by every transport
  weather/    Open-Meteo forecasts
  transport/
    web/      Express API + React PWA
    mcp/      MCP server
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Vastra is free software, licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

If you run a modified version of Vastra as a network service, the AGPL requires you to offer your users the source of that modified version.

&copy; 2026 Vastra.
