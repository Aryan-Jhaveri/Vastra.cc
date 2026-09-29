import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { trustProxySetting } from '../../../src/transport/web/trustProxy.js'

// OSS audit 2026-09-28 — X-Forwarded-For is only believed from proxies we
// actually run behind, so a directly-connecting client can't pick its req.ip.

function trustFn(setting: boolean | number | string) {
  const app = express()
  app.set('trust proxy', setting)
  return app.get('trust proxy fn') as (addr: string, hop: number) => boolean
}

describe('trustProxySetting', () => {
  it('Render / hosted: exactly one hop', () => {
    expect(trustProxySetting({ RENDER: 'true' })).toBe(1)
    expect(trustProxySetting({ HOSTED_MODE: 'true' } as NodeJS.ProcessEnv)).toBe(1)
  })

  it('self-host default trusts local/private proxies only, never a public client', () => {
    const fn = trustFn(trustProxySetting({} as NodeJS.ProcessEnv))
    expect(fn('127.0.0.1', 0)).toBe(true)          // reverse proxy / quick tunnel on this box
    expect(fn('172.18.0.5', 0)).toBe(true)         // cloudflared / Caddy container
    expect(fn('203.0.113.9', 0)).toBe(false)       // internet client hitting the published port
  })

  it('explicit values', () => {
    expect(trustProxySetting({ TRUST_PROXY: 'false' })).toBe(false)
    expect(trustProxySetting({ TRUST_PROXY: '2' })).toBe(2)
    expect(trustProxySetting({ TRUST_PROXY: 'true' })).toBe(1)
    expect(trustProxySetting({ TRUST_PROXY: '10.0.0.1' })).toBe('10.0.0.1')
  })

  it('with TRUST_PROXY=false a forged X-Forwarded-For does not change req.ip', async () => {
    const app = express()
    app.set('trust proxy', trustProxySetting({ TRUST_PROXY: 'false' }))
    app.get('/ip', (req, res) => { res.json({ ip: req.ip }) })
    const res = await request(app).get('/ip').set('X-Forwarded-For', '1.2.3.4')
    expect(res.body.ip).not.toBe('1.2.3.4')
  })
})
