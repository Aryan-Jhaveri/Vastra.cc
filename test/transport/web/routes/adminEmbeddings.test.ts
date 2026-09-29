import { describe, expect, it } from 'vitest'
import request from 'supertest'
import express from 'express'
import { requireAdmin } from '../../../../src/transport/web/middleware.js'
import router from '../../../../src/transport/web/routes/adminEmbeddings.js'

// #353 — admin-only; counts only, never vectors or user data.
function appAs(userId: string) {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = userId; next() })
  app.use('/', requireAdmin, router)
  return app
}

describe('/api/admin/embeddings', () => {
  it('403 for a normal user', async () => {
    expect((await request(appAs('user-abc')).get('/status')).status).toBe(403)
    expect((await request(appAs('user-abc')).post('/reembed')).status).toBe(403)
    expect((await request(appAs('user-abc')).post('/prune')).status).toBe(403)
  })

  it('status returns coverage counts and job state', async () => {
    const res = await request(appAs('self')).get('/status')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      text: { modelVersion: expect.any(String), items: { total: expect.any(Number), current: expect.any(Number) } },
      image: { modelVersion: expect.any(String) },
      job: { running: false },
    })
    expect(JSON.stringify(res.body)).not.toMatch(/vector|sourceBlob|userId/)
  })
})
