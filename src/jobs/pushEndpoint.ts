// Push endpoints come from the browser's PushManager and always belong to a
// browser vendor's push service. Anything else is a URL a user chose, which
// the server would then POST to (blind SSRF, and web-push buffers responses
// without a cap), so it's refused (OSS audit, 2026-09-28).

const MAX_ENDPOINT_LENGTH = 1024

/** Push services of Chrome/Edge/Opera/Samsung (FCM), Firefox, Safari and Windows. */
const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
]

function extraHosts(): string[] {
  return (process.env.PUSH_ENDPOINT_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH) return false
  let url: URL
  try { url = new URL(endpoint) } catch { return false }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return false
  const host = url.hostname.toLowerCase()
  return [...PUSH_HOST_SUFFIXES, ...extraHosts()].some(s => host === s || host.endsWith(`.${s}`))
}
