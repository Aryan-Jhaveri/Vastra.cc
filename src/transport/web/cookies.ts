import type { Request } from 'express'

// lax is browser-default CSRF protection; cookies still ride top-level navigations
// (auth flows + Stripe redirect work). Telegram WebView dependency removed when that
// transport was deprecated.
const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000

// remember=true (default) → persistent 6h cookie; remember=false → session
// cookie (dies with the browser tab), replacing the old localStorage /
// sessionStorage split — the browser no longer stores the session token at
// all (#295), so the lifetime lives entirely in the cookie.
export function cookieOpts(req: Request, remember = true) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https'
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    ...(remember ? { maxAge: SESSION_MAX_AGE_MS } : {}),
  }
}
