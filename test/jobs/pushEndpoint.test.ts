import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { eq } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { pushSubscriptions, users } from '../../src/db/schema.js'
import { isAllowedPushEndpoint } from '../../src/jobs/pushEndpoint.js'
import { getAllPushSubscriptions, MAX_PUSH_SUBSCRIPTIONS_PER_USER, upsertPushSubscription } from '../../src/jobs/pushStore.js'

// OSS audit 2026-09-28 — push endpoints are browser push services only (no
// user-chosen URLs the server would POST to), capped per user, and the store
// always needs a userId.

describe('isAllowedPushEndpoint', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGx',
    'https://wns2-by3p.notify.windows.com/w/?token=abc',
  ])('allows %s', url => expect(isAllowedPushEndpoint(url)).toBe(true))

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',              // not https
    'https://fcm.googleapis.com:8443/fcm/send/abc',        // explicit port
    'https://evil.example/fcm.googleapis.com',             // host elsewhere
    'https://fcm.googleapis.com.evil.example/x',           // suffix trick
    'https://user:pw@fcm.googleapis.com/x',                // credentials
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/x',
    'not a url',
    `https://fcm.googleapis.com/${'a'.repeat(1100)}`,      // too long
  ])('refuses %s', url => expect(isAllowedPushEndpoint(url)).toBe(false))

  it('PUSH_ENDPOINT_HOSTS adds a push service', () => {
    vi.stubEnv('PUSH_ENDPOINT_HOSTS', 'push.example.org')
    expect(isAllowedPushEndpoint('https://a.push.example.org/x')).toBe(true)
  })
})

describe('push store', () => {
  const U = 'user_push_cap'
  beforeAll(() => { db.insert(users).values({ id: U, email: `${U}@local.closet`, createdAt: Date.now() }).onConflictDoNothing().run() })
  beforeEach(() => { db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, U)).run() })

  it(`keeps at most ${MAX_PUSH_SUBSCRIPTIONS_PER_USER} devices per user, dropping the oldest`, () => {
    for (let i = 0; i < MAX_PUSH_SUBSCRIPTIONS_PER_USER + 3; i++) {
      upsertPushSubscription(`https://fcm.googleapis.com/fcm/send/d${i}`, { auth: 'a', p256dh: 'p' }, U)
    }
    const subs = getAllPushSubscriptions(U)
    expect(subs).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER)
    expect(subs.map(s => s.endpoint)).not.toContain('https://fcm.googleapis.com/fcm/send/d0')
  })

  it('requires a userId', () => {
    expect(() => getAllPushSubscriptions(undefined as unknown as string)).toThrow(/userId is required/)
  })
})

describe('POST /api/push/subscribe', () => {
  it('refuses an endpoint that is not a browser push service', async () => {
    const { default: pushRouter } = await import('../../src/transport/web/routes/push.js')
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => { req.userId = 'user_push_cap'; next() })
    app.use('/api/push', pushRouter)
    const res = await request(app).post('/api/push/subscribe').send({ endpoint: 'https://attacker.example/sink', keys: { auth: 'a', p256dh: 'p' } })
    expect(res.status).toBe(400)
    expect(getAllPushSubscriptions('user_push_cap').map(s => s.endpoint)).not.toContain('https://attacker.example/sink')
  })
})
