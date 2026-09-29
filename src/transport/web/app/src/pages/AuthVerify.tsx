import { useEffect, useState } from 'react'

type ConfirmResult =
  | { ok: true }
  | { ok: false; error: string }

// Module-scoped per-token guard. StrictMode double-mounts AuthVerify in dev,
// and each instance gets its own useRef — so a per-component guard would still
// fire two POSTs. Caching the in-flight promise per token means both mounts
// (and any accidental double-click) await the same single request.
const inFlightConfirm = new Map<string, Promise<ConfirmResult>>()

function confirmTokenOnce(token: string): Promise<ConfirmResult> {
  const existing = inFlightConfirm.get(token)
  if (existing) return existing
  const promise: Promise<ConfirmResult> = (async () => {
    try {
      const res = await fetch('/api/auth/verify-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // remember=true → persistent 6h cookie; the token itself never
        // reaches the response body (#295).
        body: JSON.stringify({ token, remember: true }),
      })
      const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        return { ok: false as const, error: data.error ?? 'Could not sign you in' }
      }
      return { ok: true as const }
    } catch {
      return { ok: false as const, error: 'Network error' }
    }
  })()
  inFlightConfirm.set(token, promise)
  return promise
}

type PreviewState =
  | { kind: 'loading' }
  | { kind: 'valid'; email: string }
  | { kind: 'expired' }
  | { kind: 'used' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string }

type ConfirmState =
  | { kind: 'idle' }
  | { kind: 'confirming' }
  | { kind: 'done' }
  | { kind: 'failed'; message: string }

const COUNTDOWN_SECONDS = 10

export function AuthVerify() {
  const [preview, setPreview] = useState<PreviewState>({ kind: 'loading' })
  const [confirm, setConfirm] = useState<ConfirmState>({ kind: 'idle' })
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS)

  const token = new URLSearchParams(window.location.search).get('token')

  // Step 1 — scanner-safe preview (never consumes the token).
  useEffect(() => {
    if (!token) {
      setPreview({ kind: 'invalid' })
      return
    }
    let cancelled = false
    fetch(`/api/auth/verify-preview?token=${encodeURIComponent(token)}`)
      .then(async r => {
        const data = await r.json().catch(() => ({})) as { valid?: boolean; expired?: boolean; email?: string }
        if (cancelled) return
        if (!r.ok) {
          setPreview({ kind: 'error', message: 'Could not verify link' })
          return
        }
        if (data.valid && data.email) {
          setPreview({ kind: 'valid', email: data.email })
        } else if (data.expired) {
          setPreview({ kind: 'expired' })
        } else {
          setPreview({ kind: 'used' })
        }
      })
      .catch(() => {
        if (!cancelled) setPreview({ kind: 'error', message: 'Network error' })
      })
    return () => { cancelled = true }
  }, [token])

  // Step 2 — countdown after preview returns valid. Confirm fires only once.
  useEffect(() => {
    if (preview.kind !== 'valid') return
    if (countdown <= 0) {
      void runConfirm()
      return
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000)
    return () => clearTimeout(t)
  }, [preview.kind, countdown])

  async function runConfirm() {
    if (!token) return
    setConfirm({ kind: 'confirming' })

    // confirmTokenOnce dedupes by token across StrictMode double-mounts AND
    // accidental double-clicks. Both call sites await the same outcome.
    const result = await confirmTokenOnce(token)
    if (!result.ok) {
      setConfirm({ kind: 'failed', message: result.error })
      return
    }

    // The server set the httpOnly session cookie — Tab B (this tab) pings
    // other tabs via a non-secret localStorage key (storage events fire on
    // OTHER tabs) and same-tab listeners via a window event. No token is
    // ever written to web storage (#295).
    try { localStorage.setItem('closet-session-changed', String(Date.now())) } catch { /* storage unavailable */ }
    window.dispatchEvent(new CustomEvent('vastra:session'))
    setConfirm({ kind: 'done' })

    // Tab B was opened by the email link — try to close it. Browsers only
    // honour window.close() for window.open-spawned tabs, so the fallback
    // 'open Vastra' card below is the recovery path.
    try { window.close() } catch { /* fall through to fallback UI */ }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  if (preview.kind === 'loading') {
    return <Card title="Checking your link…" />
  }

  if (preview.kind === 'invalid' || preview.kind === 'error') {
    return (
      <Card
        title="Something went wrong"
        body={preview.kind === 'error' ? preview.message : 'No sign-in token in the URL.'}
        cta={{ href: '/', label: 'Request a new link' }}
      />
    )
  }

  if (preview.kind === 'expired') {
    return (
      <Card
        title="Link expired"
        body="This sign-in link expired. Request a new one from the login screen."
        cta={{ href: '/', label: 'Request a new link' }}
      />
    )
  }

  if (preview.kind === 'used') {
    return (
      <Card
        title="Link already used"
        body="This sign-in link has already been used. If you're not already signed in, request a fresh one."
        cta={{ href: '/', label: 'Request a new link' }}
      />
    )
  }

  // preview.kind === 'valid'
  if (confirm.kind === 'failed') {
    return (
      <Card
        title="Sign-in failed"
        body={confirm.message}
        cta={{ href: '/', label: 'Request a new link' }}
      />
    )
  }

  if (confirm.kind === 'done') {
    return (
      <Card
        title="You're signed in"
        body={`Signed in as ${preview.email}. You can close this tab.`}
        cta={{ href: '/', label: 'Open Vastra' }}
      />
    )
  }

  if (confirm.kind === 'confirming') {
    return <Card title="Signing you in…" body={`Verifying ${preview.email}`} />
  }

  // Idle — preview valid, waiting for countdown or manual button.
  return (
    <Card
      title="Authorizing…"
      body={`Signing in as ${preview.email}. This tab will close in ${countdown}s.`}
      action={{
        label: 'Authorize now',
        onClick: () => { setCountdown(0); void runConfirm() },
      }}
    />
  )
}

function Card(props: {
  title: string
  body?: string
  cta?: { href: string; label: string }
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-paper p-4">
      <div className="border-2 border-ink w-full max-w-sm p-8 flex flex-col gap-5 rounded-base text-center">
        <h1 className="text-2xl font-bold">{props.title}</h1>
        {props.body && (
          <p className="text-[14px] font-mono text-muted leading-relaxed">{props.body}</p>
        )}
        {props.action && (
          <button
            onClick={props.action.onClick}
            className="w-full bg-accent text-accent-on border-2 border-ink py-2.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:bg-active transition-colors rounded-base"
          >
            {props.action.label}
          </button>
        )}
        {props.cta && (
          <a
            href={props.cta.href}
            className="w-full bg-accent text-accent-on border-2 border-ink py-2.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:bg-active transition-colors rounded-base"
          >
            {props.cta.label}
          </a>
        )}
      </div>
    </div>
  )
}
