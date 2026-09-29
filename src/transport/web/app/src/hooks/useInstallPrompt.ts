import { useEffect, useState } from 'react'
import { track } from '../lib/analytics'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let capturedPrompt: BeforeInstallPromptEvent | null = null
let installedFlag = false
const listeners = new Set<() => void>()

function notify() { listeners.forEach(fn => fn()) }

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(display-mode: standalone)').matches
    || (navigator as { standalone?: boolean }).standalone === true
}

export function initInstallPromptCapture(): void {
  if (typeof window === 'undefined') return
  installedFlag = isStandalone()
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault()
    capturedPrompt = e as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    installedFlag = true
    capturedPrompt = null
    notify()
  })
}

export function useInstallPrompt() {
  const [, force] = useState(0)

  useEffect(() => {
    const fn = () => force(n => n + 1)
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }, [])

  async function install() {
    if (!capturedPrompt) return { outcome: 'dismissed' as const }
    await capturedPrompt.prompt()
    const result = await capturedPrompt.userChoice
    if (result.outcome === 'accepted') {
      track('pwa_installed')
      capturedPrompt = null
      installedFlag = true
      notify()
    }
    return result
  }

  return {
    canInstall: capturedPrompt !== null && !installedFlag,
    isInstalled: installedFlag,
    install,
  }
}
