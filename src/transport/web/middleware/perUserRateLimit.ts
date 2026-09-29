import { rateLimit, type RateLimitInfo } from 'express-rate-limit'

export function perUserRateLimit(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    skip: () => !!process.env.VITEST,
    keyGenerator: (req) => req.userId ?? `ip:${req.ip}`,
    handler: (req, res) => {
      const rl = (req as { rateLimit?: RateLimitInfo }).rateLimit
      const retryAfterSeconds = rl?.resetTime
        ? Math.max(1, Math.ceil((rl.resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(windowMs / 1000)
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds })
    },
  })
}

// #321 — Per-token rate limiter for the /mcp + /api/ha/* mounts. Keys on the
// authenticated token id (falling back to IP for unauthenticated probes), so
// one noisy token can't exhaust another user's budget. Mounters pick a
// stricter `max` for the `ai` scope (e.g. requireApiToken(['ai']) behind a
// perTokenRateLimit(60_000, 20) vs a read mount at 60_000/120).
export function perTokenRateLimit(windowMs: number, max: number) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    skip: () => !!process.env.VITEST,
    keyGenerator: (req) => req.tokenId ?? `ip:${req.ip}`,
    handler: (req, res) => {
      const rl = (req as { rateLimit?: RateLimitInfo }).rateLimit
      const retryAfterSeconds = rl?.resetTime
        ? Math.max(1, Math.ceil((rl.resetTime.getTime() - Date.now()) / 1000))
        : Math.ceil(windowMs / 1000)
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds })
    },
  })
}
