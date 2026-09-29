import { useEffect, useRef, useState } from 'react'
import { fetchSettings, saveSettings } from '../api/settings'

export const NAV_MIN = 176       // ~ w-44, current default
export const NAV_MAX_VW = 0.30   // 30% of viewport width
const LS_KEY = 'closet:nav-width'

export function clampNavWidth(px: number): number {
  const max = Math.max(NAV_MIN, Math.floor(window.innerWidth * NAV_MAX_VW))
  return Math.max(NAV_MIN, Math.min(max, Math.round(px)))
}

/**
 * Persisted desktop nav width. Reads localStorage instantly on mount (so the
 * first paint isn't wrong), then reconciles with server settings, then
 * debounce-syncs writes back.
 */
export function useNavWidth() {
  const [width, setWidthState] = useState<number>(() => {
    if (typeof window === 'undefined') return NAV_MIN
    const cached = Number(localStorage.getItem(LS_KEY))
    return cached && Number.isFinite(cached) ? clampNavWidth(cached) : NAV_MIN
  })

  // Pull authoritative value from server once on mount.
  useEffect(() => {
    let cancelled = false
    fetchSettings()
      .then(s => {
        if (cancelled) return
        if (typeof s.navWidth === 'number' && Number.isFinite(s.navWidth)) {
          const clamped = clampNavWidth(s.navWidth)
          setWidthState(clamped)
          localStorage.setItem(LS_KEY, String(clamped))
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Expose current width to the rest of the app (modals, layouts) via CSS var.
  // Tailwind-style consumers can use `md:right-[var(--nav-w,11rem)]`.
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.style.setProperty('--nav-w', `${width}px`)
  }, [width])

  // Debounced sync to server.
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function setWidth(next: number) {
    const clamped = clampNavWidth(next)
    setWidthState(clamped)
    localStorage.setItem(LS_KEY, String(clamped))
    if (syncTimer.current) clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => {
      void saveSettings({ navWidth: clamped }).catch(() => {})
    }, 350)
  }

  return [width, setWidth] as const
}
