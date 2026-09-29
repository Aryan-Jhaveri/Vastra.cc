import { useEffect, useRef, useState } from 'react'

const MAX_POLL_ATTEMPTS = 60
const POLL_INTERVAL_MS = 5000

export function ServerStatusBanner() {
  const [visible, setVisible] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const pollAttemptsRef = useRef(0)
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const verifyingRef = useRef(false)

  useEffect(() => {
    const handleUnavailable = async () => {
      if (visible || dismissed || verifyingRef.current) return

      verifyingRef.current = true
      try {
        const res = await fetch('/api/auth/status', { cache: 'no-store' })
        if (!res.ok) {
          setVisible(true)
        }
      } catch {
        setVisible(true)
      } finally {
        verifyingRef.current = false
      }
    }

    window.addEventListener('server-unavailable', handleUnavailable)
    return () => window.removeEventListener('server-unavailable', handleUnavailable)
  }, [visible, dismissed])

  useEffect(() => {
    if (!visible) return

    const poll = async () => {
      if (pollAttemptsRef.current >= MAX_POLL_ATTEMPTS) {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
        return
      }

      pollAttemptsRef.current += 1

      try {
        const res = await fetch('/api/auth/status', { cache: 'no-store' })
        if (res.ok) {
          setVisible(false)
          setDismissed(false)
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          pollAttemptsRef.current = 0
        }
      } catch {
        // Server still unavailable, keep polling
      }
    }

    pollIntervalRef.current = setInterval(poll, POLL_INTERVAL_MS)

    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [visible])

  const handleReload = async () => {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations()
      for (const reg of regs) {
        await reg.unregister()
      }
    }
    window.location.reload()
  }

  const handleDismiss = () => {
    setDismissed(true)
  }

  if (!visible || dismissed) return null

  return (
    <div className="fixed bottom-20 md:bottom-4 inset-x-0 mx-auto max-w-md z-40 px-4">
      <div className="border-2 border-ink bg-paper px-4 py-3 flex items-center justify-between rounded-base shadow-flat">
        <div className="flex-1 pr-3">
          <p className="text-sm font-bold">App is updating</p>
          <p className="text-[14px] font-mono text-muted">Back in a moment — your work is safe.</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            onClick={handleDismiss}
            className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim rounded-base"
          >
            Dismiss
          </button>
          <button
            onClick={handleReload}
            className="border-2 border-ink bg-accent text-accent-on px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] rounded-base"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  )
}
