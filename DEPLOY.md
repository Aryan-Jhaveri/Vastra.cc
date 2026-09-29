# Deploying Vastra yourself

Vastra runs as one Docker container with a SQLite database and an image folder
on a volume. The AI can come from API keys (Gemini, OpenRouter), from model
servers you run, or from nothing at all: with no keys it starts in mock mode.

- [Quick start](#quick-start)
- [Render](#render)
- [Prebuilt image](#prebuilt-image)
- [Data and volumes](#data-and-volumes)
- [Configuration](#configuration)
- [Models on your own NVIDIA GPU](#models-on-your-own-nvidia-gpu)
- [GPU on a separate machine](#gpu-on-a-separate-machine)
- [Mac](#mac)
- [Your own model servers (Ollama, llama.cpp, vLLM)](#your-own-model-servers-ollama-llamacpp-vllm)
- [Checking the connections](#checking-the-connections)
- [Switching embedding models](#switching-embedding-models)
- [HTTPS and cookies](#https-and-cookies)
- [Updates and migrations](#updates-and-migrations)
- [Backups](#backups)

## Quick start

You need Docker with the Compose plugin. From a checkout:

```bash
git clone https://github.com/Aryan-Jhaveri/Vastra.cc.git vastra
cd vastra
./install.sh
```

The installer asks one or two questions, writes `.env` (mode 600), starts the
stack, and offers `make setup` (run inside the container, so this machine needs
no Node) to pick AI providers, the sign-up policy, email and push. It tests each
connection before writing. Then create your account:

```bash
docker compose exec closet node src/transport/web/admin/admin.mjs create-admin you@example.com
```

It prints a one-time sign-in link. Open http://localhost:3000. Sign-ups are
closed by default (`ALLOW_SIGNUPS=false`): only accounts you create can sign in.
Set `ALLOW_SIGNUPS=true` for a household. The admin sees the active config,
read-only, under Settings › Instance.

| Command | What you get |
|---|---|
| `./install.sh --cpu` | Vastra only. Paste a Gemini key when asked, or skip it for mock mode. |
| `./install.sh --gpu` | Vastra plus the model servers on this machine's NVIDIA GPU. |
| `./install.sh --gpu --gateway gpu.example.com` | The model servers behind an authenticated HTTPS gateway, for a Vastra on another machine. |
| `./install.sh --mac-ollama` | Vastra in Docker, chat and vision from Ollama running natively on your Mac. |

Add `--dry-run` to see the `.env` and the compose command without starting
anything. An existing `.env` is never overwritten.

Without Docker: `npm install`, `(cd src/transport/web/app && npm install && npm run build)`,
then `npm start` serves the API and the built app on port 3000.

**Signing in.** Users sign in with a link sent by email (Resend: set
`RESEND_API_KEY`, `RESEND_FROM_NOREPLY`). Without a mail key the link is printed
in the server log instead, which is fine for a personal instance. "Continue with
Google" appears when `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`
are both set.

## Render

The README's **Deploy to Render** button reads `render.yaml`: one web service
from the Dockerfile, a 1 GB disk at `/data`, self-host mode, sign-ups closed and
mock AI until you add a key. A persistent disk needs a paid instance type.

1. Click the button, name the service, and set `WEB_APP_URL` to its URL
   (`https://<name>.onrender.com`). `GEMINI_API_KEY` is optional.
2. After the first deploy, open **Shell** and create your account:
   `node src/transport/web/admin/admin.mjs create-admin you@example.com`
3. To pick providers, either set keys under **Environment**, or run
   `make setup TARGET=render` from a checkout and paste what it prints.

The Shell also runs the maintenance scripts: `node --import tsx scripts/sweep-images.ts`
(orphaned images, dry run) and `node --import tsx scripts/image-backup.ts restore`
(images missing on disk, dry run; see [Backups](#backups)).

## Prebuilt image

Tagged releases publish `ghcr.io/aryan-jhaveri/vastra:<version>` (amd64 and
arm64), starting with `2.0.0`. There is no `latest` tag: pin a version.

```bash
docker run -d --name vastra -p 3000:3000 -v vastra-data:/data \
  -e ALLOW_SIGNUPS=false ghcr.io/aryan-jhaveri/vastra:2.0.0
docker exec vastra node src/transport/web/admin/admin.mjs create-admin you@example.com
```

## Data and volumes

Everything Vastra stores lives in one directory: `closet.db` plus each user's
images under `users/<userId>/images/`.

- In Docker the container uses `/data` (`CLOSET_DATA_DIR=/data`), mapped from
  `VASTRA_DATA_DIR` on the host (default `~/.closet`).
- Outside Docker, `CLOSET_DATA_DIR` defaults to `~/.closet`.

Back this directory up; see [Backups](#backups).

## Configuration

`.env.example` documents every variable. The ones most installs touch:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Minimum real AI: categorise, tag scan, suggestions, chat |
| `MOCK_AI_IMAGE_GEN`, `MOCK_EMBEDDINGS` | `true` returns fixtures for image generation and embeddings; set `false` once you have a real provider |
| `GCP_PROJECT_ID`, `GCP_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS` | Route Gemini calls through Vertex AI on your Google Cloud project |
| `OPENROUTER_API_KEY` | Enables model ids containing `/`, and the default decision provider |
| `VISION_MODEL`, `TEXT_MODEL`, `AGENT_MODEL`, `IMAGE_GEN_MODEL` | Which model does what; `local/…` ids go to your own server |
| `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_API_KEY` | Your OpenAI-compatible server for `local/` models |
| `DECISIONS_PROVIDER`, `DECISIONS_URL`, `DECISIONS_MODEL` | Ranking and "Find related" (see below) |
| `ALLOW_SIGNUPS` | `false` (default on self-host): only accounts you create (`create-admin`) can sign in. `true` for a household |
| `WEB_AUTH_PASSWORD` | Legacy break-glass password form; only with `ADMIN_BEARER_FALLBACK=true`. Not needed: use `create-admin` |
| `WEB_PORT` | Host port (default 3000) |
| `APP_BASE_URL` | Public URL, used in share links and the Google sign-in redirect. Set it in production. |
| `WEB_APP_URL` | Public URL used in emailed sign-in links (default `http://localhost:3000`). Set it in production. |
| `CHAT_ENABLED` | The Ask tab; on by default whenever a text model is usable |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL` | Push notifications for reminders (`make setup` generates the keys) |
| `BACKUP_ENCRYPTION_SECRET`, `R2_*` | Nightly encrypted backups of the database and images |
| `IMAGE_SWEEP`, `IMAGE_SWEEP_GRACE_DAYS` | Monthly cleanup of image files nothing references: `apply` (default), `report` or `off`; 30-day grace |

Model server URLs and keys are set by the operator only; users can never point
Vastra at a server.

**Decision provider.** Ranking and "Find related" answer yes/no questions about
items. `DECISIONS_PROVIDER=openrouter` (default) uses `OPENROUTER_API_KEY`;
`typesafe` calls a TypeSafe-compatible server at `DECISIONS_URL`; `llm` asks any
chat model (`DECISIONS_MODEL`, which can be `local/…`). With none configured,
Related sections are hidden and ranking falls back.

## Models on your own NVIDIA GPU

`--profile gpu` starts model servers next to Vastra:

| Service | Model | Used for | GPU share |
|---|---|---|---|
| `qwen-image` | Qwen-Image-2.1 on vLLM-Omni | Try-on, Make Pretty | `QWEN_IMAGE_GPU_UTIL=0.40` |
| `clm-embed` + `clm` | CLM-v0.1-8B (`clm-serve` + Qwen3-8B encoder) | Ranking, Related | `CLM_EMBED_GPU_UTIL=0.20` |
| `qwen-vl` | Qwen3-VL-8B-Instruct | Categorise, tag scan, detection, suggest, Ask | `QWEN_VL_GPU_UTIL=0.22` |
| `qwen-embed` | Qwen3-VL-Embedding-2B | Text and image embeddings | `QWEN_EMBED_GPU_UTIL=0.08` |

Plan on a 96 GB-class card to run all four (about 78 GB in use). vLLM claims 90%
of GPU memory by default, which is why each server has an explicit
`*_GPU_UTIL`; the defaults add up to 0.90. Measure your card and adjust them in
`.env`. The servers start one after another, because each sizes itself from the
memory free when it starts.

Requirements:

- An NVIDIA driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
  `docker run --rm --gpus all nvidia/cuda:12.8.1-base-ubuntu24.04 nvidia-smi` should list the card.
- Disk for weights: the shared `hf-cache` volume grows to tens of GB. Set
  `HF_TOKEN` if a model page asks you to accept its licence first. Qwen-Image-2.1
  is under the Qwen Research License.
- Patience on first start: `docker compose ps` shows each server as `healthy`
  once it's ready.

Model servers never publish a port. Vastra reaches them over the internal
`models` network, and each requires `MODEL_API_KEY`, which the installer
generates. Two images are built from source (`deploy/gpu/qwen-image.Dockerfile`,
`deploy/gpu/clm.Dockerfile`); pin `VLLM_OMNI_REF` and `CLM_REF` to a tested commit.

## GPU on a separate machine

```bash
# on the GPU box
./install.sh --gpu --gateway gpu.example.com
```

The `gateway` service (Caddy) is the only thing published, on ports 80 and 443,
with an automatic Let's Encrypt certificate for a real domain. It rejects any
request without `Authorization: Bearer $GATEWAY_API_KEY`, then forwards with
`MODEL_API_KEY`. It refuses to start if either key is empty.

On the Vastra machine, add to `.env`:

```env
OPENAI_COMPAT_BASE_URL=https://gpu.example.com/vl/v1
OPENAI_COMPAT_API_KEY=<GATEWAY_API_KEY>
VISION_MODEL=local/qwen3-vl-8b
TEXT_MODEL=local/qwen3-vl-8b

IMAGE_GEN_BASE_URL=https://gpu.example.com/image/v1
IMAGE_GEN_API_KEY=<GATEWAY_API_KEY>
IMAGE_GEN_MODEL=local/Qwen/Qwen-Image-2.1
MOCK_AI_IMAGE_GEN=false

EMBED_BASE_URL=https://gpu.example.com/embed/v1
EMBED_API_KEY=<GATEWAY_API_KEY>
TEXT_EMBED_MODEL=local/qwen3-vl-embedding-2b
IMAGE_EMBED_MODEL=local/qwen3-vl-embedding-2b
TEXT_EMBED_DIM=1024
IMAGE_EMBED_DIM=1024
MOCK_EMBEDDINGS=false

DECISIONS_PROVIDER=typesafe
DECISIONS_URL=https://gpu.example.com/clm/v1/systemone
DECISIONS_API_KEY=<GATEWAY_API_KEY>
```

A private link (Tailscale, a Cloudflare tunnel) works the same way.

## Mac

Docker on a Mac can't use the Apple GPU. Run [Ollama](https://ollama.com) or LM
Studio natively:

```bash
ollama pull qwen3-vl:8b
./install.sh --mac-ollama
```

This uses `http://host.docker.internal:11434/v1`. Image generation doesn't run
on Apple Silicon through Docker, so try-on stays in mock mode unless you add a
Gemini key or a remote image server.

## Your own model servers (Ollama, llama.cpp, vLLM)

Give a model variable a `local/` prefix and Vastra sends it to
`OPENAI_COMPAT_BASE_URL` with the prefix stripped:

```env
OPENAI_COMPAT_BASE_URL=http://localhost:11434/v1   # Ollama; llama.cpp :8080/v1, vLLM :8001/v1
OPENAI_COMPAT_API_KEY=                             # if your server needs one
VISION_MODEL=local/qwen3-vl-8b                     # the name your server reports
TEXT_MODEL=local/qwen3-vl-8b
```

Once `VISION_MODEL` or `TEXT_MODEL` is `local/`, every job follows it;
`DETECTION_MODEL` and `AGENT_MODEL` still override. The Ask tab needs tool-call
support (`--jinja` for llama.cpp, `--enable-auto-tool-choice` for vLLM).

Each server (chat, image, embed, decisions) has an in-flight limit, and further
calls queue; a full queue answers "busy". Tune `<PREFIX>_MAX_CONCURRENCY`,
`_MAX_QUEUE` and `_TIMEOUT_MS`, e.g. `IMAGE_GEN_MAX_CONCURRENCY=1` and
`IMAGE_GEN_MAX_PER_USER=1`.

Embeddings take the same form (`TEXT_EMBED_MODEL`, `IMAGE_EMBED_MODEL`,
`EMBED_BASE_URL`). A text-only embedder such as Ollama's needs
`EMBED_REQUEST=input`; image embeddings need a server that accepts chat-style
messages (vLLM with `--runner pooling`).

## Checking the connections

Signed in as the admin:

| Route | Checks |
|---|---|
| `POST /api/admin/connectors/local/test` | Chat, vision and tool calls |
| `POST /api/admin/connectors/image/test` | One small image edit |
| `POST /api/admin/connectors/decisions/test` | The decision provider |

They only use the configured servers; a request can never name a URL.
`make compose-check` and `make gateway-check` (both need Docker) check the
compose stack and the gateway from a checkout.

## Switching embedding models

Vectors carry the model and dimension that made them, so nothing mixes after a
switch, but items stay unsearchable until they're re-embedded:

```text
GET  /api/admin/embeddings/status    coverage per model and re-embed progress
POST /api/admin/embeddings/reembed   start a background re-embed (resumable)
POST /api/admin/embeddings/prune     delete the old model's vectors once coverage is complete
```

## HTTPS and cookies

Put a reverse proxy in front of port 3000, for example Caddy on the host:

```
vastra.example.com {
  reverse_proxy localhost:3000
}
```

Or start the Cloudflare tunnel profile with `CLOUDFLARE_TUNNEL_TOKEN` in `.env`:
`docker compose --profile tunnel up -d`.

Sessions use an `httpOnly`, `SameSite=Lax` cookie. It's marked `Secure` when the
request arrives over HTTPS, as reported by the proxy's `X-Forwarded-Proto`
header (Vastra trusts one proxy hop), so make sure your proxy sends it. Set
`APP_BASE_URL` and `WEB_APP_URL` to your public `https://` URL. Push notifications and PWA
install also need HTTPS.

## Updates and migrations

```bash
git pull
docker compose up -d --build     # add the same --profile flags you installed with
```

Database migrations run automatically every time the server starts; there's no
separate migrate step. Back up the data directory before a big upgrade.

Health check: `GET /api/auth/status` returns 200 once the server is up.

## Backups

Stop the stack or accept a slightly inconsistent copy, then:

```bash
tar -czf vastra-backup-$(date +%Y%m%d).tar.gz ~/.closet
```

Nightly encrypted backups to an S3-compatible Cloudflare R2 bucket you own switch
on with `BACKUP_ENCRYPTION_SECRET` and `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BACKUP_BUCKET` (optional `BACKUP_CRON`, default
03:00 UTC). Generate the secret with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and
keep a copy somewhere other than the server: without it the backups can't be
decrypted.

Images are backed up in the same run, one encrypted object per file under
`images/` in the bucket, uploading only what changed since the last night.
Remote copies are never deleted. To put back images that are missing on disk
(a lost volume, or a file the monthly cleanup removed), run
`make restore-images` (a dry run), then `make restore-images APPLY=1`; in a
container, `node --import tsx scripts/image-backup.ts restore [--apply]`. It
never overwrites a file that exists.
