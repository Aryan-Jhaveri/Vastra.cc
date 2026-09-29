import webpush from 'web-push'
import { getAllPushSubscriptions, deletePushSubscription } from './pushStore.js'
import type { OutfitSuggestion } from '../types/index.js'
import { isAllowedPushEndpoint } from './pushEndpoint.js'

const SEND_TIMEOUT_MS = 10_000

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? ''
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ''
const VAPID_EMAIL = process.env.VAPID_EMAIL ?? 'mailto:admin@closet.app'

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}

export interface PushPayload {
  title: string
  body: string
  url: string
}

/**
 * Fan a single payload out to every push subscription owned by `userId`.
 * Expired subscriptions (404/410) are pruned. Returns the number of sends that
 * succeeded. No-ops (sent: 0) when VAPID keys are not configured or the user has
 * no registered devices. This is the single send path shared by scheduled job
 * notifications and the manual "send test" route.
 */
export async function sendToUserSubs(userId: string, payload: PushPayload): Promise<{ sent: number }> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return { sent: 0 }

  const subs = getAllPushSubscriptions(userId)
  if (!subs.length) return { sent: 0 }

  const serialized = JSON.stringify(payload)

  const results = await Promise.allSettled(
    subs.map(async (sub) => {
      // Rows saved before the allowlist existed: never POST to them, drop them.
      if (!isAllowedPushEndpoint(sub.endpoint)) {
        deletePushSubscription(sub.endpoint, userId)
        return false
      }
      try {
        const keys = JSON.parse(sub.keys) as { auth: string; p256dh: string }
        await webpush.sendNotification({ endpoint: sub.endpoint, keys }, serialized, { timeout: SEND_TIMEOUT_MS })
        return true
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number }).statusCode
        if (statusCode === 410 || statusCode === 404) {
          // subscription expired — clean up (scoped to this user)
          deletePushSubscription(sub.endpoint, userId)
        }
        return false
      }
    }),
  )

  const sent = results.filter((r) => r.status === 'fulfilled' && r.value === true).length
  return { sent }
}

export async function sendJobNotification(jobName: string, suggestions: OutfitSuggestion[], userId: string): Promise<void> {
  const body = suggestions.length
    ? `${suggestions.length} outfit suggestion${suggestions.length > 1 ? 's' : ''} ready — tap to view`
    : 'Your scheduled reminder is ready'

  await sendToUserSubs(userId, { title: jobName, body, url: '/home#reminders' })
}
