import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import ucpProfileRouter from '../../../../src/transport/web/routes/ucpProfile.js'
import { platformProfileUrl, resetPlatformSigningKey, UCP_VERSION } from '../../../../src/commerce/ucp/profile.js'
import { generatePrivateJwk } from '../../../../src/commerce/ucp/signing.js'

function makeApp() {
  const app = express()
  app.use('/.well-known/ucp', ucpProfileRouter)
  return app
}

describe('GET /.well-known/ucp', () => {
  const saved = { ...process.env }

  beforeEach(() => resetPlatformSigningKey())
  afterEach(() => {
    process.env = { ...saved }
    resetPlatformSigningKey()
  })

  it('serves the profile even without UCP_SIGNING_KEY (#324: Global Catalog needs no signing)', async () => {
    delete process.env.UCP_SIGNING_KEY
    const res = await request(makeApp()).get('/.well-known/ucp')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.headers['cache-control']).toContain('max-age=300')
    expect(res.headers['etag']).toBeDefined()
    expect(res.body.ucp.version).toBe(UCP_VERSION)
    expect(res.body.keys).toEqual([])
  })

  it('serves the platform profile with only the public key when signing is configured', async () => {
    const privateJwk = generatePrivateJwk()
    process.env.UCP_SIGNING_KEY = JSON.stringify(privateJwk)

    const res = await request(makeApp()).get('/.well-known/ucp')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toContain('max-age=300')
    expect(res.headers['etag']).toBeDefined()
    expect(res.body.ucp.version).toBe(UCP_VERSION)
    expect(res.body.ucp.services['dev.ucp.shopping'].map((s: { transport: string }) => s.transport)).toEqual(['rest', 'mcp'])
    expect(res.body.ucp.services['dev.ucp.shopping'][1]).toMatchObject({ transport: 'mcp', version: UCP_VERSION })
    // The Global Catalog only serves profiles that declare Shopify's extensions (#324).
    expect(Object.keys(res.body.ucp.capabilities)).toEqual([
      'dev.ucp.shopping.catalog.search',
      'dev.ucp.shopping.catalog.lookup',
      'dev.shopify.catalog',
      'dev.shopify.catalog.global',
    ])
    expect(res.body.ucp.capabilities['dev.shopify.catalog.global'][0]).toMatchObject({
      version: UCP_VERSION,
      extends: ['dev.ucp.shopping.catalog.lookup', 'dev.ucp.shopping.catalog.search'],
    })
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body.ucp.payment_handlers).toEqual({})

    expect(res.body.keys).toHaveLength(1)
    expect(res.body.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', x: privateJwk.x, y: privateJwk.y, alg: 'ES256' })
    expect(JSON.stringify(res.body)).not.toContain(privateJwk.d!)
  })

  it('returns consistent ETag across requests (deterministic body)', async () => {
    delete process.env.UCP_SIGNING_KEY
    const res1 = await request(makeApp()).get('/.well-known/ucp')
    const res2 = await request(makeApp()).get('/.well-known/ucp')
    expect(res1.headers['etag']).toBe(res2.headers['etag'])
  })

  it('serves 304 on If-None-Match match', async () => {
    delete process.env.UCP_SIGNING_KEY
    const res1 = await request(makeApp()).get('/.well-known/ucp')
    const etag = res1.headers['etag']
    const res2 = await request(makeApp()).get('/.well-known/ucp').set('If-None-Match', etag)
    expect(res2.status).toBe(304)
  })
})

describe('platformProfileUrl', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('prefers UCP_PROFILE_URL, then APP_BASE_URL, then vastra.cc', () => {
    process.env.UCP_PROFILE_URL = 'https://tunnel.example/.well-known/ucp'
    expect(platformProfileUrl()).toBe('https://tunnel.example/.well-known/ucp')

    delete process.env.UCP_PROFILE_URL
    process.env.APP_BASE_URL = 'https://staging.vastra.cc'
    expect(platformProfileUrl()).toBe('https://staging.vastra.cc/.well-known/ucp')

    delete process.env.APP_BASE_URL
    expect(platformProfileUrl()).toBe('https://vastra.cc/.well-known/ucp')
  })
})
