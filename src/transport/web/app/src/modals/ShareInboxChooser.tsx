import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ScanFace, Search, X } from 'lucide-react'

/**
 * Inbound PWA share chooser (#134 Phase 1). Shown when the OS share-target lands
 * the user at `/?share=<id>&kind=inbox`. Offers the two consuming flows.
 *
 * The query string is captured synchronously on first render: the router's
 * `/` → `/home` redirect strips `window.location.search` in an effect, which runs
 * AFTER render, so a useState initializer reliably reads `share`/`kind` first.
 */
export function ShareInboxChooser() {
  const navigate = useNavigate()
  const [params] = useState(() => new URLSearchParams(window.location.search))
  const shareId = params.get('share')
  const kind = params.get('kind')
  const [open, setOpen] = useState(Boolean(shareId) && kind === 'inbox')

  if (!open || !shareId) return null

  function stripUrl() {
    const u = new URL(window.location.href)
    u.searchParams.delete('share')
    u.searchParams.delete('kind')
    u.searchParams.delete('claim')
    window.history.replaceState({}, '', u.pathname + u.search + u.hash)
  }

  function choose(target: string) {
    setOpen(false)
    stripUrl()
    navigate(target)
  }

  function dismiss() {
    setOpen(false)
    stripUrl()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Shared image"
    >
      <div className="w-full max-w-sm border-2 border-ink bg-paper p-6 flex flex-col gap-4 rounded-base">
        <div className="flex items-start justify-between border-b-2 border-ink pb-3">
          <div>
            <p className="text-[14px] font-mono text-muted uppercase tracking-[0.12em] mb-1">Shared image</p>
            <h2 className="text-xl font-bold">What next?</h2>
          </div>
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="border-2 border-ink w-8 h-8 flex items-center justify-center hover:bg-surface-dim rounded-base shrink-0"
          >
            <X className="w-4 h-4" strokeWidth={2.5} />
          </button>
        </div>

        <button
          onClick={() => choose(`/tryon?inboxId=${shareId}`)}
          className="w-full flex items-center gap-3 bg-accent text-accent-on border-2 border-ink py-4 px-4 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:bg-active transition-colors rounded-base"
        >
          <ScanFace className="w-5 h-5 shrink-0" />
          Send to try-on
        </button>

        <button
          onClick={() => choose(`/home?inboxId=${shareId}#discover`)}
          className="w-full flex items-center gap-3 bg-paper text-ink border-2 border-ink py-4 px-4 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:bg-surface-dim transition-colors rounded-base"
        >
          <Search className="w-5 h-5 shrink-0" />
          Find similar items
        </button>
      </div>
    </div>
  )
}
