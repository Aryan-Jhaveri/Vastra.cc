import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

// routes/push.ts and jobs/pushNotify.ts both read VAPID_* into module-level
// consts at import time, so we set env BEFORE a dynamic import per app build.
// web-push + the subscription store are mocked to keep this a pure unit test.

const { sendNotificationMock, subsByUser } = vi.hoisted(() => {
  const keys = JSON.stringify({ auth: 'auth-x', p256dh: 'p256-y' })
  return {
    sendNotificationMock: vi.fn(),
    subsByUser: {
      'user-a': [
        { id: 'a1', userId: 'user-a', endpoint: 'https://fcm.googleapis.com/fcm/send/a1', keys, createdAt: 0 },
        { id: 'a2', userId: 'user-a', endpoint: 'https://fcm.googleapis.com/fcm/send/a2', keys, createdAt: 0 },
      ],
      'user-b': [
        { id: 'b1', userId: 'user-b', endpoint: 'https://fcm.googleapis.com/fcm/send/b1', keys, createdAt: 0 },
      ],
    } as Record<string, Array<{ id: string; userId: string; endpoint: string; keys: string; createdAt: number }>>,
  }
})

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: sendNotificationMock },
}))

vi.mock('../../../../src/jobs/pushStore.js', () => ({
  getAllPushSubscriptions: vi.fn((userId?: string) =>
    userId ? (subsByUser[userId] ?? []) : Object.values(subsByUser).flat(),
  ),
  deletePushSubscription: vi.fn(),
  upsertPushSubscription: vi.fn(),
}))

async function makeApp(userId: string, withVapid = true) {
  if (withVapid) {
    process.env.VAPID_PUBLIC_KEY = 'test-public-key'
    process.env.VAPID_PRIVATE_KEY = 'test-private-key'
  } else {
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
  }
  vi.resetModules()
  const { default: pushRouter } = await import('../../../../src/transport/web/routes/push.js')
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.userId = userId
    next()
  })
  app.use('/', pushRouter)
  return app
}

describe('POST /api/push/test', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendNotificationMock.mockResolvedValue(undefined)
  })

  it('sends only to the authenticated user\'s subscriptions', async () => {
    const res = await request(await makeApp('user-a')).post('/test')

    expect(res.status).toBe(200)
    expect(res.body.sent).toBe(2)
    expect(sendNotificationMock).toHaveBeenCalledTimes(2)

    const endpoints = sendNotificationMock.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint)
    expect(endpoints).toEqual(expect.arrayContaining(['https://fcm.googleapis.com/fcm/send/a1', 'https://fcm.googleapis.com/fcm/send/a2']))
    expect(endpoints).not.toContain('https://fcm.googleapis.com/fcm/send/b1')
  })

  it('does not leak across tenants — user-b only notifies their own device', async () => {
    const res = await request(await makeApp('user-b')).post('/test')

    expect(res.status).toBe(200)
    expect(res.body.sent).toBe(1)
    expect(sendNotificationMock).toHaveBeenCalledTimes(1)
    expect((sendNotificationMock.mock.calls[0][0] as { endpoint: string }).endpoint).toBe('https://fcm.googleapis.com/fcm/send/b1')
  })

  it('returns 503 and sends nothing when VAPID is not configured', async () => {
    const res = await request(await makeApp('user-a', false)).post('/test')

    expect(res.status).toBe(503)
    expect(res.body.sent).toBe(0)
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })
})
