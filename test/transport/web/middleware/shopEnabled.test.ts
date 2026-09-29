import { describe, it, expect, afterEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { requireShopEnabled } from '../../../../src/transport/web/middleware.js'
import { isShopEnabled } from '../../../../src/commerce/shopify/enabled.js'
import ucpProfileRouter from '../../../../src/transport/web/routes/ucpProfile.js'

// #324 — the shop surface is off unless SHOP_ROW_ENABLED=true (self-host
// default). Mirrors the server.ts mounts for /api/shop and /.well-known/ucp.
function app() {
  const a = express()
  a.use('/.well-known/ucp', requireShopEnabled, ucpProfileRouter)
  a.use('/api/shop', requireShopEnabled, (_req, res) => res.json({ ok: true }))
  return a
}

describe('SHOP_ROW_ENABLED gate', () => {
  afterEach(() => { delete process.env.SHOP_ROW_ENABLED })

  it('is off by default: /api/shop and /.well-known/ucp 404', async () => {
    expect(isShopEnabled()).toBe(false)
    expect((await request(app()).get('/api/shop/likes')).status).toBe(404)
    expect((await request(app()).get('/.well-known/ucp')).status).toBe(404)
  })

  it('only the exact string "true" enables it', async () => {
    process.env.SHOP_ROW_ENABLED = '1'
    expect(isShopEnabled()).toBe(false)
    expect((await request(app()).get('/api/shop/likes')).status).toBe(404)
  })

  it('when on, passes through and serves the JSON profile', async () => {
    process.env.SHOP_ROW_ENABLED = 'true'
    expect((await request(app()).get('/api/shop/likes')).status).toBe(200)
    const res = await request(app()).get('/.well-known/ucp')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/application\/json/)
  })

  it('is read per request, so flipping it off takes effect without a restart', async () => {
    const a = app()
    process.env.SHOP_ROW_ENABLED = 'true'
    expect((await request(a).get('/api/shop/likes')).status).toBe(200)
    delete process.env.SHOP_ROW_ENABLED
    expect((await request(a).get('/api/shop/likes')).status).toBe(404)
  })
})
