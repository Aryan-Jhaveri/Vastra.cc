#!/usr/bin/env bash
# Vastra self-host installer (#315 Phase 3, #354). Run it from a checkout:
#
#   git clone https://github.com/Aryan-Jhaveri/Vastra.cc.git vastra && cd vastra && ./install.sh
#
# It writes .env (mode 600), picks the compose profiles and starts the stack.
# Nothing is fetched from a package registry at runtime; the model servers
# pull their images and weights on first start.
#
#   ./install.sh                     interactive
#   ./install.sh --cpu               Vastra only (API keys or mock mode)
#   ./install.sh --gpu               + model servers on this NVIDIA box
#   ./install.sh --gpu --gateway gpu.example.com
#                                    model servers for a Vastra elsewhere, behind TLS + a key
#   ./install.sh --mac-ollama        Vastra in Docker, Ollama running natively on this Mac
#   --yes          take the defaults, ask nothing
#   --dry-run      write .env (or --env-file) and print the compose command, start nothing
#   --env-file F   write F instead of .env
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
cd "$root"

mode=""        # cpu | gpu | mac-ollama
gateway=""     # domain, or empty
assume_yes=0
dry_run=0
env_file="$root/.env"

while [ $# -gt 0 ]; do
  case "$1" in
    --cpu) mode=cpu ;;
    --gpu) mode=gpu ;;
    --mac-ollama) mode=mac-ollama ;;
    --gateway) gateway="${2:?--gateway needs a domain}"; shift ;;
    --yes|-y) assume_yes=1 ;;
    --dry-run) dry_run=1 ;;
    --env-file) env_file="${2:?--env-file needs a path}"; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
ask_yn() { # ask_yn "question" default(y|n)
  local def="$2" reply
  if [ "$assume_yes" = 1 ] || [ ! -t 0 ]; then [ "$def" = y ]; return; fi
  read -r -p "$1 [$( [ "$def" = y ] && echo Y/n || echo y/N )] " reply
  reply="${reply:-$def}"
  [[ "$reply" =~ ^[Yy] ]]
}
secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else od -An -tx1 -N32 /dev/urandom | tr -d ' \n'; fi
}

# ── Preflight ────────────────────────────────────────────────────────────────
if [ "$dry_run" = 0 ]; then
  command -v docker >/dev/null 2>&1 || { say "Docker is required: https://docs.docker.com/engine/install/"; exit 1; }
  docker compose version >/dev/null 2>&1 || { say "Docker Compose v2 is required (the 'docker compose' plugin)."; exit 1; }
fi

os="$(uname -s)"
if [ -z "$mode" ]; then
  if [ "$os" = Darwin ]; then
    say "Docker on a Mac can't use the Apple GPU, so models run natively (Ollama) or through API keys."
    if ask_yn "Use Ollama running on this Mac for chat and vision?" n; then mode=mac-ollama; else mode=cpu; fi
  else
    gpu_default=n
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then gpu_default=y; fi
    if ask_yn "NVIDIA GPU on this machine (run the model servers here)?" "$gpu_default"; then mode=gpu; else mode=cpu; fi
  fi
fi
if [ "$mode" = gpu ] && [ -z "$gateway" ] && [ "$assume_yes" = 0 ] && [ -t 0 ]; then
  if ask_yn "Will a Vastra on another machine use these models (publish an authenticated gateway)?" n; then
    read -r -p "Gateway domain (DNS pointing here, for the TLS certificate): " gateway
  fi
fi
if [ -n "$gateway" ] && [ "$mode" != gpu ]; then say "--gateway needs --gpu"; exit 2; fi
if [ "$mode" = gpu ] && [ "$dry_run" = 0 ] && ! docker info 2>/dev/null | grep -qi nvidia; then
  say "Warning: Docker doesn't list an NVIDIA runtime. Install the NVIDIA Container Toolkit first:"
  say "  https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
fi

# ── .env ─────────────────────────────────────────────────────────────────────
if [ -f "$env_file" ]; then
  say "Keeping the existing $(basename "$env_file") (delete it to regenerate)."
else
  model_key="$(secret)"
  gateway_key="$(secret)"
  gemini_key="${GEMINI_API_KEY:-}"
  if [ "$mode" = cpu ] && [ -z "$gemini_key" ] && [ "$assume_yes" = 0 ] && [ -t 0 ]; then
    read -r -s -p "Gemini API key (optional; Enter to start in mock mode): " gemini_key; echo
  fi

  umask 077
  {
    say "# Written by install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Every option is documented in .env.example."
    say "# Self-host: HOSTED_MODE stays unset (no wallet, no Stripe)."
    say "# Only accounts you create can sign in. First admin (after start):"
    say "#   docker compose exec closet node src/transport/web/admin/admin.mjs create-admin you@example.com"
    say "# Set true to let anyone who can reach this instance make an account (a household)."
    say "ALLOW_SIGNUPS=false"
    say ""
    case "$mode" in
      gpu)
        say "# ── Model servers on this box (docker compose --profile gpu) ──"
        say "MODEL_API_KEY=$model_key"
        say "HF_TOKEN="
        say "# GPU memory shares per server (sum ≤ 0.95); re-measure on your card (#296)."
        say "QWEN_IMAGE_GPU_UTIL=0.40"
        say "CLM_EMBED_GPU_UTIL=0.20"
        say "QWEN_VL_GPU_UTIL=0.22"
        say "QWEN_EMBED_GPU_UTIL=0.08"
        say ""
        say "# Chat + vision (Qwen3-VL-8B)"
        say "OPENAI_COMPAT_BASE_URL=http://qwen-vl:8001/v1"
        say "OPENAI_COMPAT_API_KEY=$model_key"
        say "VISION_MODEL=local/qwen3-vl-8b"
        say "TEXT_MODEL=local/qwen3-vl-8b"
        say "# Try-on + Make Pretty (Qwen-Image-2.1)"
        say "IMAGE_GEN_BASE_URL=http://qwen-image:8091/v1"
        say "IMAGE_GEN_API_KEY=$model_key"
        say "IMAGE_GEN_MODEL=local/Qwen/Qwen-Image-2.1"
        say "MOCK_AI_IMAGE_GEN=false"
        say "# Embeddings (Qwen3-VL-Embedding-2B: text and images in one space)"
        say "EMBED_BASE_URL=http://qwen-embed:8002/v1"
        say "EMBED_API_KEY=$model_key"
        say "TEXT_EMBED_MODEL=local/qwen3-vl-embedding-2b"
        say "IMAGE_EMBED_MODEL=local/qwen3-vl-embedding-2b"
        say "TEXT_EMBED_DIM=1024"
        say "IMAGE_EMBED_DIM=1024"
        say "TEXT_EMBED_ENABLED=true"
        say "IMAGE_EMBED_ENABLED=true"
        say "MOCK_EMBEDDINGS=false"
        say "# Decisions (CLM-8B via clm-serve)"
        say "DECISIONS_PROVIDER=typesafe"
        say "DECISIONS_URL=http://clm:8700/v1/systemone"
        say "DECISIONS_API_KEY=$model_key"
        say "DECISIONS_MAX_TOKENS=2048"
        if [ -n "$gateway" ]; then
          say ""
          say "# ── Gateway for a Vastra on another machine (--profile gateway) ──"
          say "GATEWAY_DOMAIN=$gateway"
          say "GATEWAY_API_KEY=$gateway_key"
        fi
        ;;
      mac-ollama)
        say "# ── Ollama on this Mac (run: ollama pull qwen3-vl:8b) ──"
        say "OPENAI_COMPAT_BASE_URL=http://host.docker.internal:11434/v1"
        say "VISION_MODEL=local/qwen3-vl:8b"
        say "TEXT_MODEL=local/qwen3-vl:8b"
        say "# No image generation on the Apple GPU through Docker: try-on stays mocked."
        say "MOCK_AI_IMAGE_GEN=true"
        say "MOCK_EMBEDDINGS=true"
        ;;
      cpu)
        if [ -n "$gemini_key" ]; then
          say "GEMINI_API_KEY=$gemini_key"
          say "MOCK_AI_IMAGE_GEN=false"
        else
          say "# Mock mode: no AI keys. Add GEMINI_API_KEY (or local model servers) later."
          say "MOCK_AI_IMAGE_GEN=true"
        fi
        say "MOCK_EMBEDDINGS=true"
        ;;
    esac
  } > "$env_file"
  chmod 600 "$env_file"
  say "Wrote $env_file (mode 600)."
  if [ -n "$gateway" ]; then say "Gateway key for the remote Vastra (GATEWAY_API_KEY): $gateway_key"; fi
fi

# ── Start ────────────────────────────────────────────────────────────────────
cmd=(docker compose)
if [ "$mode" = gpu ]; then cmd+=(--profile gpu); fi
if [ -n "$gateway" ]; then cmd+=(--profile gateway); fi
cmd+=(up -d --build)

# make setup, inside the container (no Node needed on this machine): AI
# providers, sign-ups, email, push. Runs as you, so .env stays yours.
env_dir="$(cd "$(dirname "$env_file")" && pwd)"
setup_cmd=(docker compose run --rm --no-deps --user "$(id -u):$(id -g)" -e VASTRA_IN_CONTAINER=1
  -v "$env_dir:/host" closet node --import tsx scripts/setup.ts --target docker --out "/host/$(basename "$env_file")")

if [ "$dry_run" = 1 ]; then
  say "Would run: ${cmd[*]}"
  if [ "$mode" != gpu ]; then say "Then offer: ${setup_cmd[*]}"; fi
  exit 0
fi
"${cmd[@]}"

# The GPU stack is already wired to its own model servers; setup is for picking API keys or Ollama.
if [ "$mode" != gpu ]; then
  if [ "$assume_yes" = 0 ] && [ -t 0 ] && ask_yn "Pick AI providers now (Gemini, OpenRouter, Ollama…) with make setup?" y; then
    "${setup_cmd[@]}" && "${cmd[@]}"
  else
    say "To pick AI providers later: ${setup_cmd[*]}"
    say "then: ${cmd[*]}"
  fi
fi

say ""
say "Vastra: http://localhost:${WEB_PORT:-3000}"
say "Create your admin account (prints a one-time sign-in link):"
say "  docker compose exec closet node src/transport/web/admin/admin.mjs create-admin you@example.com"
if [ "$mode" = gpu ]; then
  say "Model servers start one after another and download their weights on first run (tens of GB)."
  say "Watch them with:  docker compose ps   (all 'healthy' when ready)"
  say "Then, signed in as admin, check each one: POST /api/admin/connectors/{local,image,decisions}/test"
  if [ -n "$gateway" ]; then
    say "Remote Vastra base URLs: https://$gateway/{vl,image,embed}/v1 and https://$gateway/clm/v1/systemone (see DEPLOY.md)"
  fi
fi
