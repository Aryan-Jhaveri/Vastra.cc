import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'crypto'

/**
 * RFC 9421 HTTP Message Signatures for UCP requests (#323).
 *
 * UCP baseline is ES256 (ECDSA P-256). Signatures use the raw r||s encoding
 * (RFC 9421 §3.3.1), not DER, and `alg` is NOT a Signature-Input parameter —
 * verifiers derive it from the JWK. See https://ucp.dev/2026-08-25/signatures/
 */

export interface PublicJwk {
  kty: 'EC'
  crv: 'P-256'
  x: string
  y: string
  kid: string
  use: 'sig'
  alg: 'ES256'
}

export interface SigningKey {
  kid: string
  privateKey: KeyObject
  publicJwk: PublicJwk
}

/** RFC 7638 JWK SHA-256 thumbprint — required members in lexicographic order. */
export function jwkThumbprint(jwk: { crv: string; kty: string; x: string; y: string }): string {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  return createHash('sha256').update(canonical).digest('base64url')
}

/** Generate a new ES256 private key as a JWK (store it as UCP_SIGNING_KEY). */
export function generatePrivateJwk(): JsonWebKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return privateKey.export({ format: 'jwk' })
}

export function loadSigningKey(privateJwkJson: string): SigningKey {
  const jwk = JSON.parse(privateJwkJson) as JsonWebKey
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
    throw new Error('UCP signing key must be a P-256 EC private JWK')
  }
  const privateKey = createPrivateKey({ key: jwk, format: 'jwk' })
  const kid = jwkThumbprint({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })
  return {
    kid,
    privateKey,
    publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, use: 'sig', alg: 'ES256' },
  }
}

/** RFC 9530 Content-Digest over the raw body bytes. */
export function contentDigest(body: string | Buffer): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`
}

export interface SignableRequest {
  method: string
  url: string
  /** Lowercase header names → values. Covered headers must be present here. */
  headers: Record<string, string>
  body?: string
}

/** Covered components per the UCP REST signing table, in spec order. */
export function coveredComponents(req: SignableRequest): string[] {
  const { search } = new URL(req.url)
  const components = ['@method', '@authority', '@path']
  if (search) components.push('@query')
  if (req.headers['ucp-agent']) components.push('ucp-agent')
  if (req.headers['idempotency-key']) components.push('idempotency-key')
  if (req.body !== undefined) components.push('content-digest', 'content-type')
  return components
}

export function signatureParams(components: string[], keyid: string, created: number): string {
  return `(${components.map(c => `"${c}"`).join(' ')});created=${created};keyid="${keyid}"`
}

function componentValue(name: string, req: SignableRequest): string {
  const url = new URL(req.url)
  switch (name) {
    case '@method': return req.method.toUpperCase()
    case '@authority': return url.host.toLowerCase()
    case '@path': return url.pathname
    case '@query': return url.search
    default: {
      const value = req.headers[name]
      if (value === undefined) throw new Error(`Covered header "${name}" is missing`)
      return value.trim()
    }
  }
}

/** RFC 9421 §2.5 signature base. */
export function signatureBase(req: SignableRequest, components: string[], params: string): string {
  const lines = components.map(c => `"${c}": ${componentValue(c, req)}`)
  lines.push(`"@signature-params": ${params}`)
  return lines.join('\n')
}

/**
 * Sign a request. Adds `content-digest` to the headers when there is a body,
 * then returns the full header set including Signature-Input and Signature.
 */
export function signRequest(
  req: SignableRequest,
  key: SigningKey,
  created = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const headers = { ...req.headers }
  if (req.body !== undefined) headers['content-digest'] = contentDigest(req.body)
  const signable = { ...req, headers }
  const components = coveredComponents(signable)
  const params = signatureParams(components, key.kid, created)
  const base = signatureBase(signable, components, params)
  const signature = sign('sha256', Buffer.from(base), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
  return {
    ...headers,
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${signature.toString('base64')}:`,
  }
}

/**
 * Verify a `sig1` signature against a public JWK. Used by tests now and by
 * order webhooks later (#326). Does not fetch keys or check `created` freshness.
 */
export function verifyRequestSignature(req: SignableRequest, publicJwk: JsonWebKey): boolean {
  const input = req.headers['signature-input']?.match(/^sig1=(\((.*?)\).*)$/)
  const sig = req.headers.signature?.match(/^sig1=:(.+):$/)
  if (!input || !sig) return false
  if (req.body !== undefined && req.headers['content-digest'] !== contentDigest(req.body)) return false
  const components = [...input[2].matchAll(/"([^"]+)"/g)].map(m => m[1])
  const base = signatureBase(req, components, input[1])
  const publicKey = createPublicKey({ key: publicJwk, format: 'jwk' })
  return verify('sha256', Buffer.from(base), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig[1], 'base64'))
}
