/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { NetworkFirst, CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'
import { clientsClaim } from 'workbox-core'

declare const self: ServiceWorkerGlobalScope

// New SW activates immediately so the push handler below is live without a
// second visit. `registerType: 'prompt'` still works via the SKIP_WAITING
// message the app's update flow posts.
self.skipWaiting()
clientsClaim()

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

// ── Precaching + routing (ported from the previous workbox config) ────────────

precacheAndRoute(self.__WB_MANIFEST)

// SPA navigation fallback — serve the cached app shell for client-side routes,
// but let top-level /api/* navigations (e.g. the Google OAuth redirect) reach
// the network. Without the denylist, /api/auth/google/start would render the
// blank SPA shell until a hard refresh.
// /auth/verify is also denylisted: magic-link tokens are one-shot, so users
// must never get a stale precached shell that points at outdated JS (which
// can race-confirm or fail-silently). Always hit the network for that path.
const navigationHandler = createHandlerBoundToURL('/index.html')
registerRoute(
  new NavigationRoute(navigationHandler, {
    denylist: [/^\/api\//, /^\/auth\/verify/],
  }),
)

// API reads (excluding auth/settings/push/billing/events) — NetworkFirst.
registerRoute(
  /^\/api\/(?!auth|settings|push|billing|events)/,
  new NetworkFirst({
    cacheName: 'api-cache',
    networkTimeoutSeconds: 5,
    plugins: [new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 300 })],
  }),
)

// Item / outfit images — CacheFirst.
registerRoute(
  /^\/images\//,
  new CacheFirst({
    cacheName: 'image-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 })],
  }),
)

// Google Fonts — CacheFirst.
registerRoute(
  /^https:\/\/fonts\.(googleapis|gstatic)\.com\//,
  new CacheFirst({
    cacheName: 'font-cache',
    plugins: [new ExpirationPlugin({ maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 })],
  }),
)

// ── Push delivery ─────────────────────────────────────────────────────────────

interface PushPayload {
  title?: string
  body?: string
  url?: string
}

self.addEventListener('push', (event) => {
  let data: PushPayload = {}
  try {
    data = event.data ? (event.data.json() as PushPayload) : {}
  } catch {
    data = {}
  }

  const title = data.title || 'Vastra'
  const body = data.body || 'You have a new reminder'
  const url = data.url || '/home#reminders'

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        data: { url },
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-96.png',
        tag: 'vastra-reminder',
      })
      // Nudge any open client to refresh its Reminders view immediately, ahead
      // of the 30s poll. Every push currently corresponds to a job fire.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clients) client.postMessage({ type: 'JOB_FIRED' })
    })(),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = (event.notification.data ?? {}) as { url?: string }
  const targetUrl = data.url || '/home#reminders'

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      for (const client of allClients) {
        // Focus an already-open tab and steer it to the target route.
        await client.focus()
        if ('navigate' in client && client.url !== new URL(targetUrl, self.location.origin).href) {
          try {
            await client.navigate(targetUrl)
          } catch {
            /* navigation can reject on cross-origin; ignore */
          }
        }
        return
      }

      if (self.clients.openWindow) {
        await self.clients.openWindow(targetUrl)
      }
    })(),
  )
})
