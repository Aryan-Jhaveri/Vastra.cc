// Resolves a `next` redirect target, accepting only same-origin paths. Parsing
// with URL (rather than prefix checks) catches `/\evil.com`, `/<tab>/evil.com`
// and similar inputs that browsers normalise into protocol-relative URLs.
export function safeNextUrl(next: string | null): URL | null {
  if (!next || !next.startsWith('/')) return null
  try {
    const u = new URL(next, window.location.origin)
    return u.origin === window.location.origin ? u : null
  } catch {
    return null
  }
}
