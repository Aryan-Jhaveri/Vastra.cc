import { useEffect, useRef } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

export function PWAUpdateBanner() {
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null)

  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r: ServiceWorkerRegistration | undefined) { if (r) registrationRef.current = r },
    onRegisterError(err: unknown) { console.warn('SW register error', err) },
  })

  // Force a full reload when the new SW takes control, so stale HTML/JS is
  // replaced rather than waiting for the next cold start (critical on iOS).
  useEffect(() => {
    const sw = navigator.serviceWorker
    if (!sw) return
    const handler = () => window.location.reload()
    sw.addEventListener('controllerchange', handler)
    return () => sw.removeEventListener('controllerchange', handler)
  }, [])

  // Poll for updates on foreground resume + hourly. iOS PWAs restore from
  // background without a real navigation, so the default on-nav check never
  // fires; this is what surfaces the banner after a deploy.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') registrationRef.current?.update()
    }
    document.addEventListener('visibilitychange', check)
    const id = setInterval(() => registrationRef.current?.update(), 60 * 60 * 1000)
    return () => {
      document.removeEventListener('visibilitychange', check)
      clearInterval(id)
    }
  }, [])

  if (!needRefresh) return null

  return (
    <div className="fixed bottom-20 md:bottom-4 inset-x-0 mx-auto max-w-md z-40 px-4">
      <div className="border-2 border-ink bg-paper px-4 py-3 flex items-center justify-between rounded-base shadow-flat">
        <div className="flex-1 pr-3">
          <p className="text-sm font-bold">Update ready</p>
          <p className="text-[14px] font-mono text-muted">Tap to load the latest version</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={() => setNeedRefresh(false)}
            className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim rounded-base"
          >
            Later
          </button>
          <button
            onClick={() => updateServiceWorker(true)}
            className="border-2 border-ink bg-accent text-accent-on px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] rounded-base"
          >
            Update
          </button>
        </div>
      </div>
    </div>
  )
}
