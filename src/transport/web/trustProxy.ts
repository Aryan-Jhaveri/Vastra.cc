// Which proxies' X-Forwarded-For Express believes (OSS audit 2026-09-28).
// A blanket "1 hop" let a client that reaches the app directly (docker
// compose publishes the port) choose its own req.ip and dodge every per-IP
// rate limit.
//
// TRUST_PROXY: "false" | a hop count | a comma list of addresses/subnets or
// the names loopback, linklocal, uniquelocal. Default: 1 on Render / hosted
// (exactly one load balancer in front); otherwise only loopback and private
// peers (a local reverse proxy, the cloudflared or Caddy container), never a
// public client.
export function trustProxySetting(env: NodeJS.ProcessEnv = process.env): boolean | number | string {
  const raw = env.TRUST_PROXY?.trim()
  if (!raw) return env.RENDER || env.HOSTED_MODE === 'true' ? 1 : 'loopback, linklocal, uniquelocal'
  if (raw === 'false' || raw === '0') return false
  if (/^\d+$/.test(raw)) return Number(raw)
  if (raw === 'true') return 1 // "trust everything" is never what anyone means
  return raw
}
