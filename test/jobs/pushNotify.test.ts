import { describe, it, expect, vi, beforeEach } from 'vitest'

// pushNotify reads VAPID_* into module-level consts at import time and calls
// web-push.setVapidDetails. We therefore stub env BEFORE a dynamic import per
// test, and mock web-push + the subscription store so this is a pure unit test.

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
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: sendNotificationMock,
  },
}))

vi.mock('../../src/jobs/pushStore.js', () => ({
  getAllPushSubscriptions: vi.fn((userId?: string) =>
    userId ? (subsByUser[userId] ?? []) : Object.values(subsByUser).flat(),
  ),
  deletePushSubscription: vi.fn(),
}))

describe('sendJobNotification — per-user fan-out', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendNotificationMock.mockResolvedValue(undefined)
    process.env.VAPID_PUBLIC_KEY = 'test-public-key'
    process.env.VAPID_PRIVATE_KEY = 'test-private-key'
    vi.resetModules()
  })

  it('only sends to the target user\'s subscriptions (cross-tenant isolation)', async () => {
    const { sendJobNotification } = await import('../../src/jobs/pushNotify.js')
    const { getAllPushSubscriptions } = await import('../../src/jobs/pushStore.js')

    await sendJobNotification('Morning outfit', [], 'user-a')

    expect(getAllPushSubscriptions).toHaveBeenCalledWith('user-a')
    expect(sendNotificationMock).toHaveBeenCalledTimes(2)

    const endpoints = sendNotificationMock.mock.calls.map((c) => (c[0] as { endpoint: string }).endpoint)
    expect(endpoints).toEqual(expect.arrayContaining(['https://fcm.googleapis.com/fcm/send/a1', 'https://fcm.googleapis.com/fcm/send/a2']))
    expect(endpoints).not.toContain('https://fcm.googleapis.com/fcm/send/b1')
  })

  it('sends nothing when the target user has no subscriptions', async () => {
    const { sendJobNotification } = await import('../../src/jobs/pushNotify.js')

    await sendJobNotification('Morning outfit', [], 'user-with-no-devices')

    expect(sendNotificationMock).not.toHaveBeenCalled()
  })

  it('no-ops when VAPID keys are not configured', async () => {
    delete process.env.VAPID_PUBLIC_KEY
    delete process.env.VAPID_PRIVATE_KEY
    vi.resetModules()

    const { sendJobNotification } = await import('../../src/jobs/pushNotify.js')
    await sendJobNotification('Morning outfit', [], 'user-a')

    expect(sendNotificationMock).not.toHaveBeenCalled()
  })
})

describe('sendToUserSubs — hardening (OSS audit)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendNotificationMock.mockResolvedValue(undefined)
    process.env.VAPID_PUBLIC_KEY = 'test-public-key'
    process.env.VAPID_PRIVATE_KEY = 'test-private-key'
    vi.resetModules()
  })

  it('sends with a timeout, and drops (never POSTs to) a saved non-push endpoint', async () => {
    const keys = JSON.stringify({ auth: 'auth-x', p256dh: 'p256-y' })
    subsByUser['user-old'] = [
      { id: 'o1', userId: 'user-old', endpoint: 'https://attacker.example/sink', keys, createdAt: 0 },
      { id: 'o2', userId: 'user-old', endpoint: 'https://fcm.googleapis.com/fcm/send/o2', keys, createdAt: 0 },
    ]
    const { sendToUserSubs } = await import('../../src/jobs/pushNotify.js')
    const { deletePushSubscription } = await import('../../src/jobs/pushStore.js')
    const { sent } = await sendToUserSubs('user-old', { title: 't', body: 'b', url: '/' })
    expect(sent).toBe(1)
    expect(sendNotificationMock).toHaveBeenCalledTimes(1)
    expect(sendNotificationMock.mock.calls[0][2]).toEqual({ timeout: 10_000 })
    expect(deletePushSubscription).toHaveBeenCalledWith('https://attacker.example/sink', 'user-old')
  })
})
