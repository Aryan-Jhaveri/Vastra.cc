import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import {
  contentDigest,
  coveredComponents,
  generatePrivateJwk,
  jwkThumbprint,
  loadSigningKey,
  signatureBase,
  signRequest,
  verifyRequestSignature,
} from '../../../src/commerce/ucp/signing.js'

const key = loadSigningKey(JSON.stringify(generatePrivateJwk()))
const URL_ = 'https://merchant.example.com/ucp/catalog/search'
const BODY = '{"query":"rain jacket"}'
const HEADERS = {
  'content-type': 'application/json',
  'ucp-agent': 'profile="https://vastra.cc/.well-known/ucp"',
  'idempotency-key': 'idem-1',
}

describe('UCP signing keys', () => {
  it('loads a P-256 private JWK and exposes only public members', () => {
    expect(key.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256', use: 'sig', alg: 'ES256' })
    expect(key.publicJwk).not.toHaveProperty('d')
  })

  it('uses the RFC 7638 thumbprint as kid', () => {
    const { crv, kty, x, y } = key.publicJwk
    const expected = createHash('sha256').update(`{"crv":"${crv}","kty":"${kty}","x":"${x}","y":"${y}"}`).digest('base64url')
    expect(key.kid).toBe(expected)
    expect(jwkThumbprint(key.publicJwk)).toBe(expected)
  })

  it('rejects non-P-256 keys', () => {
    expect(() => loadSigningKey(JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'a', d: 'b' }))).toThrow(/P-256/)
  })
})

describe('contentDigest', () => {
  it('hashes raw body bytes as an RFC 9530 sha-256 byte sequence', () => {
    const expected = createHash('sha256').update(BODY).digest('base64')
    expect(contentDigest(BODY)).toBe(`sha-256=:${expected}:`)
  })
})

describe('coveredComponents', () => {
  it('covers method, authority, path, ucp-agent, idempotency-key and body headers for a POST', () => {
    expect(coveredComponents({ method: 'POST', url: URL_, headers: HEADERS, body: BODY })).toEqual([
      '@method', '@authority', '@path', 'ucp-agent', 'idempotency-key', 'content-digest', 'content-type',
    ])
  })

  it('adds @query only when a query string is present', () => {
    const c = coveredComponents({ method: 'GET', url: 'https://m.example/ucp/orders/1?x=1', headers: {} })
    expect(c).toEqual(['@method', '@authority', '@path', '@query'])
  })
})

describe('signRequest', () => {
  const created = 1_760_000_000
  const signed = signRequest({ method: 'post', url: URL_, headers: HEADERS, body: BODY }, key, created)

  it('emits Signature-Input without alg, with created and keyid', () => {
    expect(signed['signature-input']).toBe(
      `sig1=("@method" "@authority" "@path" "ucp-agent" "idempotency-key" "content-digest" "content-type");created=${created};keyid="${key.kid}"`,
    )
    expect(signed['signature-input']).not.toContain('alg=')
  })

  it('builds the RFC 9421 signature base', () => {
    const params = signed['signature-input'].slice('sig1='.length)
    const components = coveredComponents({ method: 'POST', url: URL_, headers: signed, body: BODY })
    expect(signatureBase({ method: 'post', url: URL_, headers: signed, body: BODY }, components, params)).toBe([
      '"@method": POST',
      '"@authority": merchant.example.com',
      '"@path": /ucp/catalog/search',
      `"ucp-agent": ${HEADERS['ucp-agent']}`,
      '"idempotency-key": idem-1',
      `"content-digest": ${contentDigest(BODY)}`,
      '"content-type": application/json',
      `"@signature-params": ${params}`,
    ].join('\n'))
  })

  it('produces a raw r||s ECDSA signature (64 bytes, not DER)', () => {
    const b64 = signed.signature.match(/^sig1=:(.+):$/)![1]
    expect(Buffer.from(b64, 'base64')).toHaveLength(64)
  })

  it('verifies against the published public JWK', () => {
    expect(verifyRequestSignature({ method: 'POST', url: URL_, headers: signed, body: BODY }, key.publicJwk)).toBe(true)
  })

  it('fails verification when the body is tampered with', () => {
    expect(verifyRequestSignature({ method: 'POST', url: URL_, headers: signed, body: '{"query":"boots"}' }, key.publicJwk)).toBe(false)
  })

  it('fails verification when replayed to another host', () => {
    const other = 'https://evil.example.com/ucp/catalog/search'
    expect(verifyRequestSignature({ method: 'POST', url: other, headers: signed, body: BODY }, key.publicJwk)).toBe(false)
  })

  it('fails verification with a different key', () => {
    const otherKey = loadSigningKey(JSON.stringify(generatePrivateJwk()))
    expect(verifyRequestSignature({ method: 'POST', url: URL_, headers: signed, body: BODY }, otherKey.publicJwk)).toBe(false)
  })
})
