import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'

// #308 — test/setup.ts binds supertest's server to 127.0.0.1. Unpatched it
// binds dual-stack `::` (local address ::ffff:127.0.0.1), which can share a
// port number with another process's 127.0.0.1 listener on macOS.
describe('supertest ephemeral server', () => {
  it('listens on IPv4 loopback, where supertest sends the request', async () => {
    const app = express()
    app.get('/where', (req, res) => { res.json({ local: req.socket.localAddress }) })
    const res = await request(app).get('/where')
    expect(res.status).toBe(200)
    expect(res.body.local).toBe('127.0.0.1')
  })

  it('still works with await-style and chained expectations', async () => {
    const app = express()
    app.post('/echo', express.json(), (req, res) => { res.status(201).json(req.body) })
    await request(app).post('/echo').send({ a: 1 }).expect(201, { a: 1 })
  })
})
