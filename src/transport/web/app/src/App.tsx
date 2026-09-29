import { useState, useEffect, useRef, useCallback } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router'
import { useNavWidth } from './hooks/useNavWidth'
import { Home as HomeIcon, Shirt, Layers, ScanFace, Settings as SettingsIcon, type LucideProps } from 'lucide-react'
import { purgeLegacyTokenStorage } from './api/client'
import { applyLocalThemePreference } from './lib/theme'
import { syncThemeFromAccount } from './lib/themeSync'
import { HostedGlobalUI, hostedPublicPage, hostedRoutes } from './hosted'
import { PWAUpdateBanner } from './components/PWAUpdateBanner'
import { ServerStatusBanner } from './components/ServerStatusBanner'
import { ItemCacheProvider } from './context/ItemCacheContext'
import { PageResetProvider, usePageReset } from './context/PageResetContext'
import { initAnalytics, track } from './lib/analytics'
import { Home } from './pages/Home'
import { Closet } from './pages/Closet'
import { Outfits } from './pages/Outfits'
import { TryOn } from './pages/TryOn'
import { Settings } from './pages/Settings'
import { Jobs } from './pages/Jobs'
import { Login } from './pages/Login'
import { Onboarding } from './pages/Onboarding'
import { WelcomeWalkthrough } from './pages/WelcomeWalkthrough'
import { ShareLanding } from './pages/ShareLanding'
import { Spinner } from './components/ui/Spinner'
import { PageTransition } from './components/PageTransition'
import { ShareInboxChooser } from './modals/ShareInboxChooser'
import { AuthVerify } from './pages/AuthVerify'
import { SettingsGuide } from './pages/SettingsGuide'
import { SettingsSizes } from './pages/SettingsSizes'
import { SettingsInstance } from './pages/SettingsInstance'
import { About } from './pages/About'
import { LikedItems } from './pages/LikedItems'

function RoutePageViewTracker() {
  const location = useLocation()
  const ref = useRef<{ pathname: string; t: number }>({ pathname: '', t: Date.now() })

  useEffect(() => {
    const prev = ref.current
    const durationMs = prev.pathname !== '' ? Date.now() - prev.t : undefined
    if (prev.pathname !== location.pathname) {
      track('page_view', { from: prev.pathname || undefined, to: location.pathname }, { durationMs })
    }
    ref.current = { pathname: location.pathname, t: Date.now() }
  }, [location.pathname])

  return null
}

type NavItem = { to: string; label: string; Icon: React.FC<LucideProps> }

const NAV_ITEMS: NavItem[] = [
  { to: '/home',     label: 'Home',     Icon: HomeIcon },
  { to: '/closet',   label: 'Closet',   Icon: Shirt },
  { to: '/outfits',  label: 'Outfits',  Icon: Layers },
  { to: '/tryon',    label: 'Try On',   Icon: ScanFace },
  { to: '/settings', label: 'Settings', Icon: SettingsIcon },
]

const ROUTE_TO_PAGE_KEY: Record<string, string> = {
  '/home': 'home',
  '/closet': 'closet',
  '/outfits': 'outfits',
  '/tryon': 'tryon',
  '/settings': 'settings',
}

function BottomNav() {
  const { triggerReset } = usePageReset()
  const location = useLocation()

  const handleTabClick = useCallback((to: string) => (e: React.MouseEvent) => {
    const pageKey = ROUTE_TO_PAGE_KEY[to]
    if (pageKey && location.pathname === to) {
      e.preventDefault()
      triggerReset(pageKey)
    }
  }, [location.pathname, triggerReset])
  function pressIn(e: React.PointerEvent<HTMLDivElement>) {
    const icon = e.currentTarget.querySelector('svg') as SVGElement | null
    if (!icon) return
    ;(icon as any).__pressed = true
    icon.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.85)' }], { duration: 60, fill: 'forwards' })
  }
  function pressOut(e: React.PointerEvent<HTMLDivElement>) {
    const icon = e.currentTarget.querySelector('svg') as SVGElement | null
    if (!icon || !(icon as any).__pressed) return
    ;(icon as any).__pressed = false
    icon.animate([{ transform: 'scale(0.85)' }, { transform: 'scale(1)' }], { duration: 150, easing: 'ease-out', fill: 'forwards' })
  }

  return (
    <nav
      id="bottom-nav"
      className="fixed bottom-0 inset-x-0 bg-paper border-t-[3px] border-ink flex md:hidden will-change-transform z-30"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)', transform: 'translateZ(0)' }}
    >
      {NAV_ITEMS.map(({ to, label, Icon }) => (
        <NavLink key={to} to={to} className="flex-1" onClick={handleTabClick(to)}>
          {({ isActive }) => (
            <div
              className="flex flex-col items-center gap-1 py-3 transition-colors select-none"
              style={isActive ? { background: 'var(--color-accent)' } : undefined}
              onPointerDown={pressIn}
              onPointerUp={pressOut}
              onPointerLeave={pressOut}
            >
              <div className="relative">
                <Icon
                  className="w-[22px] h-[22px] pointer-events-none"
                  style={{ color: isActive ? 'var(--color-accent-on)' : 'var(--color-ink)' }}
                  strokeWidth={isActive ? 2.5 : 2}
                />
              </div>
              <span
                className="text-[12px] font-bold font-mono uppercase tracking-[0.07em] pointer-events-none"
                style={{ color: isActive ? 'var(--color-accent-on)' : 'var(--color-ink)' }}
              >
                {label}
              </span>
            </div>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

function DesktopMenu() {
  const mainItems = NAV_ITEMS.filter(i => i.to !== '/settings')
  const settingsItem = NAV_ITEMS.find(i => i.to === '/settings')!
  const [width, setWidth] = useNavWidth()
  const draggingRef = useRef(false)
  const { triggerReset } = usePageReset()
  const location = useLocation()

  const handleTabClick = useCallback((to: string) => (e: React.MouseEvent) => {
    const pageKey = ROUTE_TO_PAGE_KEY[to]
    if (pageKey && location.pathname === to) {
      e.preventDefault()
      triggerReset(pageKey)
    }
  }, [location.pathname, triggerReset])

  function pressIn(e: React.PointerEvent<HTMLDivElement>) {
    const icon = e.currentTarget.querySelector('svg') as SVGElement | null
    if (!icon) return
    ;(icon as any).__pressed = true
    icon.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.85)' }], { duration: 60, fill: 'forwards' })
  }
  function pressOut(e: React.PointerEvent<HTMLDivElement>) {
    const icon = e.currentTarget.querySelector('svg') as SVGElement | null
    if (!icon || !(icon as any).__pressed) return
    ;(icon as any).__pressed = false
    icon.animate([{ transform: 'scale(0.85)' }, { transform: 'scale(1)' }], { duration: 150, easing: 'ease-out', fill: 'forwards' })
  }

  function onResizeStart(e: React.PointerEvent) {
    e.preventDefault()
    draggingRef.current = true
    const onMove = (ev: PointerEvent) => {
      if (!draggingRef.current) return
      // The nav is anchored to the right edge — wider = drag handle moves left.
      setWidth(window.innerWidth - ev.clientX)
    }
    const onUp = () => {
      draggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Scale typography + icons with width. 1.0 at 176px, cap at 1.6 (~280px+).
  const scale = Math.min(1.6, Math.max(1, width / 176))
  const iconSize = Math.round(16 * scale)
  const labelPx = Math.round(10 * scale)
  const brandPx = Math.round(22 * scale)
  const rowPaddingY = Math.round(12 * scale)

  return (
    <nav
      className="hidden md:flex shrink-0 border-l-[3px] border-ink sticky top-0 h-screen flex-col bg-paper relative z-30"
      style={{ width }}
    >
      {/* Drag handle — sits on the left edge */}
      <div
        onPointerDown={onResizeStart}
        title="Drag to resize"
        className="absolute left-0 top-0 h-full w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-ink/20 active:bg-ink/40 transition-colors z-10"
      />
      {/* Brand header */}
      <div className="border-b-[3px] border-ink px-5 shrink-0" style={{ paddingTop: rowPaddingY * 1.6, paddingBottom: rowPaddingY * 1.6 }}>
        <span className="font-bold font-mono tracking-tight text-ink leading-none" style={{ fontSize: brandPx }}>Vastra</span>
      </div>

      {/* Main nav — grows to fill */}
      <div className="flex-1 flex flex-col overflow-y-hidden">
        {mainItems.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} onClick={handleTabClick(to)}>
            {({ isActive }) => (
              <div
                className="flex items-center gap-3 px-5 border-b border-outline-variant transition-colors hover:bg-surface-dim select-none"
                onPointerDown={pressIn}
                onPointerUp={pressOut}
                onPointerLeave={pressOut}
                style={{
                  paddingTop: rowPaddingY,
                  paddingBottom: rowPaddingY,
                  ...(isActive
                    ? { background: 'var(--color-accent)', color: 'var(--color-accent-on)' }
                    : { color: 'var(--color-ink)' }),
                }}
              >
                <Icon className="shrink-0" style={{ width: iconSize, height: iconSize }} strokeWidth={isActive ? 2.5 : 2} />
                <span className="font-bold font-mono uppercase tracking-[0.1em]" style={{ fontSize: labelPx }}>{label}</span>
              </div>
            )}
          </NavLink>
        ))}
      </div>

      {/* Settings pinned to bottom */}
      <NavLink to={settingsItem.to} onClick={handleTabClick(settingsItem.to)}>
        {({ isActive }) => (
          <div
            className="flex items-center gap-3 px-5 border-t-[3px] border-ink shrink-0 transition-colors hover:bg-surface-dim select-none"
            onPointerDown={pressIn}
            onPointerUp={pressOut}
            onPointerLeave={pressOut}
            style={{
              paddingTop: rowPaddingY,
              paddingBottom: rowPaddingY,
              ...(isActive
                ? { background: 'var(--color-accent)', color: 'var(--color-accent-on)' }
                : { color: 'var(--color-ink)' }),
            }}
          >
            <settingsItem.Icon className="shrink-0" style={{ width: iconSize, height: iconSize }} strokeWidth={isActive ? 2.5 : 2} />
            <span className="font-bold font-mono uppercase tracking-[0.1em]" style={{ fontSize: labelPx }}>{settingsItem.label}</span>
          </div>
        )}
      </NavLink>
    </nav>
  )
}

type AuthState = 'loading' | 'login' | 'walkthrough' | 'onboarding' | 'authed'

export function App() {
  // Public hosted pages (the legal pages) must be reachable by unauthenticated
  // users. The auth gate below only mounts a router for authed/onboarding
  // states, so they are short-circuited here (before any hooks) into their own
  // minimal router. All links to them open in a new tab → a full document load
  // → this runs.
  const publicPage = typeof window !== 'undefined' ? hostedPublicPage(window.location.pathname) : null
  if (publicPage) return publicPage

  // /auth/verify must work for signed-out users — they land here directly from
  // the magic-link email. Short-circuited above the auth gate the same way
  // /legal/* is, so the route stays reachable without a session.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/auth/verify')) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/auth/verify" element={<AuthVerify />} />
          <Route path="*" element={<Navigate to="/auth/verify" replace />} />
        </Routes>
      </BrowserRouter>
    )
  }

  const [authState, setAuthState] = useState<AuthState>('loading')

useEffect(() => {
    initAnalytics()

    async function checkAuth() {
      // Upgrades from the pre-#295 build may still hold a session token in
      // web storage — the httpOnly cookie is the only credential now, so
      // any leftover token keys are dropped.
      purgeLegacyTokenStorage()

      // Cookie-only auth: the httpOnly `closet-auth` cookie rides this request
      // automatically. No token is read from web storage.
      try {
        const me = await fetch('/api/auth/me')
        if (!me.ok) {
          setAuthState('login')
          return
        }
        const themeSync = syncThemeFromAccount()
        const res = await fetch('/api/items?limit=1')
        if (res.ok) {
          const data = await res.json() as { total: number }
          await themeSync
          const needsWalkthrough =
            (data.total ?? 1) === 0 &&
            localStorage.getItem('closet_walkedthrough') !== 'true'
          if (needsWalkthrough) { setAuthState('walkthrough'); return }
          const needsOnboarding =
            (data.total ?? 1) === 0 &&
            localStorage.getItem('closet_onboarded') !== 'true'
            setAuthState(needsOnboarding ? 'onboarding' : 'authed')
          if (!needsOnboarding && (window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone)) {
            track('pwa_launched')
          }
          return
        }
      } catch { /* fall through */ }

      setAuthState('login')
    }
    void checkAuth()
  }, [])

  useEffect(() => {
    applyLocalThemePreference()
  }, [])

  // Called when a sign-in completes via the Login screen (password, Google
  // redirect, OR the magic-link cross-tab signal). The session lives in the
  // httpOnly cookie set by the server; this only decides which shell to mount.
  async function handleLogin() {
    await syncThemeFromAccount()
    try {
      const me = await fetch('/api/auth/me')
      if (!me.ok) {
        setAuthState('login')
        return
      }
      const res = await fetch('/api/items?limit=1')
      if (res.ok) {
        const data = await res.json() as { total: number }
        // Empty closet + first-ever sign-in → run the Lottie walkthrough,
        // then the onboarding flow. Returning users (or anyone with items)
        // go straight to /home.
        if ((data.total ?? 1) === 0 && localStorage.getItem('closet_walkedthrough') !== 'true') {
          setAuthState('walkthrough')
          return
        }
        if ((data.total ?? 1) === 0 && localStorage.getItem('closet_onboarded') !== 'true') {
          setAuthState('onboarding')
          return
        }
      }
    } catch { /* fall through to authed */ }
    setAuthState('authed')
  }

  if (authState === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-paper">
        <Spinner />
      </div>
    )
  }

  if (authState === 'login') {
    return <Login onLogin={() => { void handleLogin() }} />
  }

  if (authState === 'onboarding') {
    return (
      <BrowserRouter>
        <Onboarding onComplete={() => setAuthState('authed')} />
      </BrowserRouter>
    )
  }

  if (authState === 'walkthrough') {
    return (
      <BrowserRouter>
        <WelcomeWalkthrough onComplete={() => {
          localStorage.setItem('closet_walkedthrough', 'true')
          setAuthState('onboarding')
        }} />
      </BrowserRouter>
    )
  }

  return (
    <BrowserRouter>
      <RoutePageViewTracker />
      <ItemCacheProvider>
        <PageResetProvider>
        <div id="app-shell" className="md:flex md:flex-row-reverse md:min-h-screen overflow-y-auto md:overflow-visible">
        {/* Sidebar — in document flow on desktop, centered correctly */}
        <DesktopMenu />

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div id="main-column" className="max-w-lg mx-auto pb-20 md:pb-0">
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/onboarding" element={<Onboarding />} />
              <Route path="/settings/onboarding" element={<Onboarding />} />
              <Route path="/welcome" element={<WelcomeWalkthrough onComplete={() => window.location.assign('/onboarding')} />} />
              <Route path="/home" element={<PageTransition><Home /></PageTransition>} />
              <Route path="/closet" element={<PageTransition><Closet /></PageTransition>} />
              <Route path="/closet/liked" element={<PageTransition><LikedItems backTo="/closet" /></PageTransition>} />
              <Route path="/outfits" element={<PageTransition><Outfits /></PageTransition>} />
              <Route path="/tryon" element={<PageTransition><TryOn /></PageTransition>} />
              <Route path="/jobs" element={<PageTransition><Jobs /></PageTransition>} />
              <Route path="/settings" element={<PageTransition><Settings onLogout={() => setAuthState('login')} /></PageTransition>} />
              <Route path="/settings/guide" element={<PageTransition><SettingsGuide /></PageTransition>} />
              <Route path="/settings/sizes" element={<PageTransition><SettingsSizes /></PageTransition>} />
              <Route path="/settings/instance" element={<PageTransition><SettingsInstance /></PageTransition>} />
              <Route path="/settings/liked" element={<PageTransition><LikedItems backTo="/settings" /></PageTransition>} />
              <Route path="/about" element={<PageTransition><About /></PageTransition>} />
              <Route path="/share/:id" element={<PageTransition><ShareLanding /></PageTransition>} />
              {hostedRoutes.map(({ path, Component }) => (
                <Route key={path} path={path} element={<PageTransition><Component /></PageTransition>} />
              ))}
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </div>
        </div>
      </div>
        <BottomNav />
        <PWAUpdateBanner />
        <ServerStatusBanner />
        <HostedGlobalUI />
        <ShareInboxChooser />
        </PageResetProvider>
      </ItemCacheProvider>
    </BrowserRouter>
  )
}
