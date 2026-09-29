// Regex patterns for major free-email providers + their country variants.
// Disposable / temp-mail services proliferate faster than blocklists update
// (e.g. minitts.net bypassed `disposable-email-domains`), so we invert the
// model: only well-known consumer providers pass. Google Workspace / custom
// business domains land via the Google OAuth flow (which sets emailVerified
// from the IdP) and bypass this guard entirely — see routes/googleAuth.ts.
//
// Patterns use [a-z]{2,3} for ccTLDs — covers all real country codes (in, uk,
// fi, pl, etc.) without enumerating each variant. Residual risk: 2-letter TLDs
// like .tk could match, but temp-mail services don't impersonate major providers
// at the DNS level. MX-record validation would be the next layer if needed.

// Helper to build provider patterns with ccTLD variants
const ccTLD = (base: string): RegExp =>
  new RegExp(`^${base}\\.(com|[a-z]{2,3}|co\\.[a-z]{2,3}|com\\.[a-z]{2,3})$`, 'i')

const PROVIDER_PATTERNS: RegExp[] = [
  // Google — exact matches only
  /^gmail\.com$/i,
  /^googlemail\.com$/i,

  // Yahoo — regex for variants + exact matches for aliases
  ccTLD('yahoo'),
  /^ymail\.com$/i,
  /^rocketmail\.com$/i,

  // Microsoft (outlook, hotmail, live) — regex for variants + exact matches
  ccTLD('outlook'),
  ccTLD('hotmail'),
  ccTLD('live'),
  /^msn\.com$/i,
  /^passport\.com$/i,

  // Apple — exact matches only
  /^icloud\.com$/i,
  /^me\.com$/i,
  /^mac\.com$/i,

  // AOL — regex for variants + exact match for legacy
  ccTLD('aol'),
  /^compuserve\.com$/i,
]

// ALLOWED_EMAIL_DOMAINS env (passed in by caller) overrides the built-in
// allowlist entirely — used to whitelist staff / staging domains. Caller is
// responsible for basic email-shape validation (the route uses zod's .email()).
export function validateEmail(email: string, allowedDomains?: string[]): boolean {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) return false

  if (allowedDomains && allowedDomains.length > 0) {
    return allowedDomains.some(d => d.toLowerCase() === domain)
  }
  return PROVIDER_PATTERNS.some(p => p.test(domain))
}
