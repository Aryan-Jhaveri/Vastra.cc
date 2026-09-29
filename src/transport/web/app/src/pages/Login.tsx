import { useState, useEffect, useRef, type FormEvent } from 'react'
import { claimShare } from '../api/share'
import { safeNextUrl } from '../lib/safeNextUrl'
import { HostedSignupConsent, signupConsentRequired } from '../hosted'

type Mode = 'idle' | 'link-sent'

interface LoginProps {
  onLogin: () => void
}

const RESEND_COOLDOWN_SEC = 60


export function Login({ onLogin }: LoginProps) {
  const [mode, setMode] = useState<Mode>('idle')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adminFallback, setAdminFallback] = useState(false)
  const [googleEnabled, setGoogleEnabled] = useState(false)
  const [consent, setConsent] = useState(false)
  const [cooldown, setCooldown] = useState(0)
  const [adminPassword, setAdminPassword] = useState('')
  const onLoginRef = useRef(onLogin)
  onLoginRef.current = onLogin

  const isDevBuild = import.meta.env.DEV

  useEffect(() => {
    fetch('/api/auth/status')
      .then(r => r.json())
      .then(d => {
        if (d.adminFallback) setAdminFallback(true)
        if (d.google) setGoogleEnabled(true)
      })
      .catch(() => {})
    const params = new URLSearchParams(window.location.search)
    if (params.get('oauth') === 'error') {
      const REASONS: Record<string, string> = {
        denied: 'Sign-in cancelled.',
        state_expired: 'Sign-in link expired. Try again.',
        state_mismatch: 'That sign-in started in another browser. Try again here.',
        email_unverified: 'Google says your email is not verified. Verify it with Google and retry.',
        signups_closed: 'This Vastra is private. Ask its owner to add your account.',
        exchange_failed: 'Google sign-in failed. Please try again.',
      }
      setError(REASONS[params.get('reason') ?? ''] ?? REASONS.exchange_failed)
    }
    if (params.has('oauth') || params.has('reason')) {
      params.delete('oauth')
      params.delete('reason')
      const qs = params.toString()
      window.history.replaceState(null, '', qs ? `${location.pathname}?${qs}` : location.pathname)
    }

    // Cross-tab signal: AuthVerify (Tab B) completes the magic-link sign-in,
    // which sets the httpOnly session cookie for the whole origin — every tab
    // shares it. Tab B pings via a non-secret localStorage key; browsers fire
    // `storage` on every OTHER tab, so Tab A lands the user without polling.
    const onStorage = (e: StorageEvent) => {
      if (e.key !== 'closet-session-changed') return
      void completeLogin()
    }
    const onSessionPing = () => { void completeLogin() }
    window.addEventListener('storage', onStorage)
    window.addEventListener('vastra:session', onSessionPing as EventListener)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('vastra:session', onSessionPing as EventListener)
    }
  }, [])

  // Resend cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return
    const t = setTimeout(() => setCooldown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [cooldown])

  // Finish a successful auth. If the URL carries a `next` path (set by the PWA
  // share-target login redirect), honour it — claiming any pending anonymous
  // share BEFORE navigating, since the chooser is gated on the row's ownership.
  // Otherwise fall back to the normal in-app authed transition.
  async function completeLogin() {
    const params = new URLSearchParams(window.location.search)
    const next = safeNextUrl(params.get('next'))
    if (next) {
      const shareId = next.searchParams.get('share')
      const claimToken = next.searchParams.get('claim')
      if (shareId && claimToken) {
        await claimShare(shareId, claimToken).catch(() => { /* still land the user */ })
        next.searchParams.delete('claim')
      }
      window.location.assign(next.pathname + next.search + next.hash)
      return
    }
    onLoginRef.current()
  }

  async function sendLink(): Promise<boolean> {
    const res = await fetch('/api/auth/send-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, ...(signupConsentRequired ? { acceptedTermsAt: Date.now() } : {}) }),
    })
    const data = await res.json().catch(() => ({})) as { error?: string }
    if (!res.ok) {
      setError(data.error ?? 'Could not send sign-in link')
      return false
    }
    setCooldown(RESEND_COOLDOWN_SEC)
    return true
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const ok = await sendLink()
      if (ok) setMode('link-sent')
    } catch {
      setError('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  async function resend() {
    if (cooldown > 0 || !email) return
    setLoading(true)
    setError(null)
    try { await sendLink() }
    catch { setError('Something went wrong') }
    finally { setLoading(false) }
  }

  async function submitAdmin() {
    if (!adminPassword) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: adminPassword, remember: false }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        setError(data.error ?? 'Wrong password')
        return
      }
      // The server set the httpOnly session cookie; no token is stored (#295).
      await completeLogin()
    } catch {
      setError('Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-paper p-4">
      <div className="border-2 border-ink w-full max-w-sm p-8 flex flex-col gap-6 rounded-base">
        <div className="border-b-2 border-ink pb-4">
          <p className="text-[14px] font-mono text-muted uppercase tracking-[0.12em] mb-1">
            {mode === 'idle' ? 'Welcome' : 'Check your inbox'}
          </p>
          <h1 className="text-2xl font-bold">Vastra</h1>
        </div>

        {mode === 'idle' && (
          <form onSubmit={submit} className="flex flex-col gap-4">
            {error && (
              <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[14px] font-mono uppercase tracking-[0.06em] rounded-base">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                autoFocus
                required
                placeholder="you@example.com"
                autoComplete="email"
                className="border-2 border-ink px-3 py-2.5 text-sm font-mono outline-none focus:bg-surface-dim"
              />
            </div>

            <HostedSignupConsent checked={consent} onChange={setConsent} />

            <button
              type="submit"
              disabled={loading || (signupConsentRequired && !consent) || !email}
              className="w-full bg-accent text-accent-on border-2 border-ink py-2.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:bg-active disabled:opacity-40 transition-colors rounded-base"
            >
              {loading ? '…' : 'Email me a sign-in link'}
            </button>

            {googleEnabled && (
              <>
                <div className="flex items-center gap-3 py-1">
                  <span className="h-px flex-1 bg-outline-variant" />
                  <span className="text-[12px] font-mono uppercase tracking-[0.12em] text-muted">or</span>
                  <span className="h-px flex-1 bg-outline-variant" />
                </div>
                <a
                  href="/api/auth/google/start"
                  className="w-full bg-paper text-ink border-2 border-ink py-3 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:bg-surface-dim transition-colors rounded-base flex items-center justify-center gap-2.5"
                >
                  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                    <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"/>
                    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
                    <path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z"/>
                    <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962L3.964 7.294C4.672 5.167 6.656 3.58 9 3.58z"/>
                  </svg>
                  Continue with Google
                </a>
              </>
            )}

          </form>
        )}

        {/* Admin escape hatch — dev builds only */}
        {mode === 'idle' && adminFallback && isDevBuild && (
          <div className="border-t-2 border-outline-variant pt-4 mt-2 flex flex-col gap-2">
            <p className="text-[13px] font-mono uppercase tracking-[0.1em] text-muted mb-1">Admin login</p>
            <input
              type="password"
              value={adminPassword}
              onChange={e => setAdminPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submitAdmin() } }}
              placeholder="Admin password"
              autoComplete="current-password"
              className="border-2 border-ink px-3 py-2.5 text-sm font-mono outline-none focus:bg-surface-dim"
            />
            <button
              type="button"
              onClick={() => void submitAdmin()}
              disabled={loading || !adminPassword}
              className="w-full bg-surface-dim text-ink border-2 border-ink py-2.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-ink hover:text-paper disabled:opacity-40 transition-colors rounded-base"
            >
              Admin sign-in
            </button>
          </div>
        )}

        {mode === 'link-sent' && (
          <div className="flex flex-col gap-4">
            {error && (
              <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[14px] font-mono uppercase tracking-[0.06em] rounded-base">
                {error}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <p className="text-[14px] font-mono text-muted leading-relaxed">
                We sent a sign-in link to <span className="font-bold text-ink">{email}</span>.
                Open it on this device to finish signing in — this tab will pick it up automatically.
              </p>
              <p className="text-[13px] font-mono text-muted">
                Didn't see it? Check Spam / Promotions, then try Resend below.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <p className="text-[13px] font-mono uppercase tracking-[0.1em] text-muted">Open your inbox</p>
              <div className="flex gap-2 flex-wrap">
                <a href="https://mail.google.com" target="_blank" rel="noreferrer" className="text-[12px] font-mono border-2 border-ink px-2.5 py-1 rounded-base hover:bg-surface-dim">
                  Gmail
                </a>
                <a href="https://outlook.live.com/mail" target="_blank" rel="noreferrer" className="text-[12px] font-mono border-2 border-ink px-2.5 py-1 rounded-base hover:bg-surface-dim">
                  Outlook
                </a>
                <a href="https://mail.yahoo.com" target="_blank" rel="noreferrer" className="text-[12px] font-mono border-2 border-ink px-2.5 py-1 rounded-base hover:bg-surface-dim">
                  Yahoo
                </a>
                <a href="https://www.icloud.com/mail" target="_blank" rel="noreferrer" className="text-[12px] font-mono border-2 border-ink px-2.5 py-1 rounded-base hover:bg-surface-dim">
                  iCloud
                </a>
                <a href="https://mail.aol.com" target="_blank" rel="noreferrer" className="text-[12px] font-mono border-2 border-ink px-2.5 py-1 rounded-base hover:bg-surface-dim">
                  AOL
                </a>
              </div>
            </div>

            <button
              type="button"
              onClick={resend}
              disabled={loading || cooldown > 0}
              className="w-full bg-surface-dim text-ink border-2 border-ink py-2.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:bg-ink hover:text-paper disabled:opacity-40 transition-colors rounded-base"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : loading ? '…' : 'Resend link'}
            </button>

            <button
              type="button"
              onClick={() => { setMode('idle'); setError(null) }}
              className="text-[13px] font-mono uppercase tracking-[0.08em] text-muted hover:text-ink text-left"
            >
              ← Use a different email
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
