#!/usr/bin/env bash
# Boot the production entrypoint (src/combined.ts, same as the Docker CMD) in a
# throwaway data dir with a scrubbed environment, then probe a few routes.
#
#   scripts/smoke-boot.sh selfhost   HOSTED_MODE unset, no AI keys → must boot in
#                                    mock mode with billing routes unmounted (#315 Phase 1)
#   scripts/smoke-boot.sh hosted     HOSTED_MODE=true → billing routes mounted
#
# The repo's .env is never read (DOTENV_CONFIG_PATH=/dev/null) and the process
# gets only the variables listed below, so a real key can't mask a missing one.
set -euo pipefail

mode="${1:?usage: smoke-boot.sh selfhost|hosted}"
port="${SMOKE_PORT:-3999}"
root="$(cd "$(dirname "$0")/.." && pwd)"
data="$(mktemp -d "${TMPDIR:-/tmp}/vastra-smoke.XXXXXX")"
log="$data/server.log"

env_args=(
  PATH="$PATH" HOME="$data" NODE_ENV=production
  CLOSET_DATA_DIR="$data" PORT="$port" DOTENV_CONFIG_PATH=/dev/null
  WEB_AUTH_PASSWORD=smoke MOCK_AI_IMAGE_GEN=true MOCK_EMBEDDINGS=true
)
case "$mode" in
  selfhost) ;;
  hosted)   env_args+=(HOSTED_MODE=true GCP_PROJECT_ID=smoke-project) ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac

cd "$root"
env -i "${env_args[@]}" node --import tsx src/combined.ts >"$log" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; rm -rf "$data"; }
trap cleanup EXIT

fail() { echo "FAIL [$mode]: $*" >&2; echo "--- server log (last 40 lines)" >&2; tail -40 "$log" >&2; exit 1; }

status() { curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port$1"; }

for _ in $(seq 1 60); do
  kill -0 "$pid" 2>/dev/null || fail "server exited during boot"
  [ "$(status /api/auth/status)" = 200 ] && break
  sleep 0.5
done
[ "$(status /api/auth/status)" = 200 ] || fail "/api/auth/status never returned 200"
echo "ok   [$mode] boots; /api/auth/status 200"

billing="$(status /api/billing/balance)"
metrics="$(status /api/admin/metrics)"
if [ "$mode" = selfhost ]; then
  [ "$billing" = 404 ] || fail "/api/billing is mounted when self-hosted (got $billing, want 404)"
  [ "$metrics" = 404 ] || fail "/api/admin/metrics is mounted when self-hosted (got $metrics, want 404)"
  echo "ok   [$mode] billing + admin metrics unmounted"
else
  [ "$billing" != 404 ] || fail "/api/billing is not mounted in HOSTED_MODE"
  echo "ok   [$mode] billing mounted ($billing without a session)"
fi
