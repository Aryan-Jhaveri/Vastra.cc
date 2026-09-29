import { useState, useEffect } from 'react'
import { apiFetchJSON, apiFetch } from '../api/client'

type PushState = 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed' | 'loading'

function urlBase64ToUint8Array(base64: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const buf = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
  return buf.buffer
}

export function usePushNotifications() {
  const [state, setState] = useState<PushState>('loading')

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setState('unsupported')
      return
    }
    if (Notification.permission === 'denied') {
      setState('denied')
      return
    }
    navigator.serviceWorker.getRegistration('/sw.js').then(reg => {
      if (!reg) { setState('unsubscribed'); return }
      reg.pushManager.getSubscription().then(sub => {
        setState(sub ? 'subscribed' : 'unsubscribed')
      }).catch(() => setState('unsubscribed'))
    }).catch(() => setState('unsubscribed'))
  }, [])

  async function subscribe(): Promise<{ ok: boolean; error?: string }> {
    setState('loading')
    try {
      const { key } = await apiFetchJSON<{ key: string }>('/api/push/vapid-public-key')
      const reg = await navigator.serviceWorker.register('/sw.js')
      await navigator.serviceWorker.ready
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })
      const json = sub.toJSON() as { endpoint: string; keys: { auth: string; p256dh: string } }
      await apiFetch('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
      })
      setState('subscribed')
      return { ok: true }
    } catch (err) {
      console.error('[push] subscribe failed:', err)
      const denied = Notification.permission === 'denied'
      setState(denied ? 'denied' : 'unsubscribed')
      return {
        ok: false,
        error: denied
          ? 'Notifications are blocked. Re-enable them in your browser settings.'
          : err instanceof Error ? err.message : 'Could not enable notifications.',
      }
    }
  }

  async function unsubscribe() {
    setState('loading')
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await apiFetch('/api/push/unsubscribe', {
          method: 'POST',
          body: JSON.stringify({ endpoint: sub.endpoint }),
        })
        await sub.unsubscribe()
      }
      setState('unsubscribed')
    } catch (err) {
      console.error('[push] unsubscribe failed:', err)
      setState('subscribed')
    }
  }

  async function sendTest(): Promise<{ ok: boolean; sent: number; error?: string }> {
    try {
      const res = await apiFetchJSON<{ sent: number }>('/api/push/test', { method: 'POST' })
      return { ok: true, sent: res.sent ?? 0 }
    } catch (err) {
      return { ok: false, sent: 0, error: err instanceof Error ? err.message : 'Failed to send test notification' }
    }
  }

  return { state, subscribe, unsubscribe, sendTest }
}
