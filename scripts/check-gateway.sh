#!/usr/bin/env bash
# #354 — run the real Caddy gateway against an echo upstream and check that
# the bearer check fires before routing, the path prefix is stripped, and the
# upstream sees MODEL_API_KEY, never the client's key. Needs Docker.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
net="vastra-gw-check-$$"
port="${GATEWAY_CHECK_PORT:-18080}"
cleanup() { docker rm -f "$net-gw" "$net-echo" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker network create "$net" >/dev/null
docker run -d --name "$net-echo" --network "$net" --network-alias qwen-vl python:3.12-slim python3 -c "
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'path': self.path, 'auth': self.headers.get('Authorization')}).encode()
        self.send_response(200); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(('0.0.0.0', 8001), H).serve_forever()" >/dev/null
docker run -d --name "$net-gw" --network "$net" -p "$port:8080" \
  -e GATEWAY_API_KEY=client-key -e MODEL_API_KEY=upstream-key -e 'GATEWAY_DOMAIN=http://:8080' \
  -v "$root/deploy/gpu/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 >/dev/null

for _ in $(seq 1 30); do curl -s -o /dev/null "localhost:$port/health" && break; sleep 1; done

fail=0
expect() { # expect <code> <path> [auth header]
  local got
  got="$(curl -s -o /dev/null -w '%{http_code}' ${3:+-H "$3"} "localhost:$port$2")"
  if [ "$got" = "$1" ]; then echo "ok   $1 $2 ${3:-(no auth)}"; else echo "FAIL $2 ${3:-(no auth)}: want $1, got $got"; fail=1; fi
}
expect 401 /vl/v1/models
expect 401 /vl/v1/models "Authorization: Bearer wrong"
expect 401 /vl/v1/models "Authorization: Bearer "
expect 401 /health
expect 200 /health "Authorization: Bearer client-key"
expect 404 /nope "Authorization: Bearer client-key"

echoed="$(curl -s -H 'Authorization: Bearer client-key' "localhost:$port/vl/v1/models")" # gitleaks:allow (dummy test key)
if [ "$echoed" = '{"path": "/v1/models", "auth": "Bearer upstream-key"}' ]; then
  echo "ok   upstream sees /v1/models with MODEL_API_KEY"
else
  echo "FAIL upstream saw: $echoed"; fail=1
fi
exit "$fail"
