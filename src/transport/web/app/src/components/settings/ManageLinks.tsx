import { useEffect, useState, useCallback } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { fetchMyShares, deleteShare, type MyShareItem } from '../../api/share'

export function ManageLinksSection() {
  const [shares, setShares] = useState<MyShareItem[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setShares(await fetchMyShares())
    } catch {
      setError('Could not load links')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!expanded) return
    void refresh()
  }, [expanded, refresh])

  async function handleRevoke(id: string) {
    setRevokingId(id)
    try {
      await deleteShare(id)
      setShares(prev => prev.filter(s => s.id !== id))
    } catch {
      setError('Could not revoke link')
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="mb-6">
      <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">Links</p>
      <p className="text-[13px] font-mono text-muted mt-2 mb-3 leading-relaxed">
        Share links let others view your outfits and inspiration without an account.
      </p>

      <button
        onClick={() => setExpanded(e => !e)}
        className="border-b border-outline-variant py-3 flex items-center justify-between w-full text-left hover:bg-surface-dim transition-colors"
      >
        <p className="text-sm font-medium">Manage Links</p>
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-muted" />
          : <ChevronRight className="w-3.5 h-3.5 text-muted" />}
      </button>

      {expanded && (
        <div className="py-2 flex flex-col gap-2">
          {loading && <p className="text-[14px] font-mono text-muted py-2">Loading…</p>}
          {error && <p className="text-[13px] font-mono text-error py-2">{error}</p>}
          {!loading && !error && shares.length === 0 && (
            <p className="text-[14px] font-mono text-muted py-2">No active share links.</p>
          )}
          {shares.map(s => (
            <div key={s.id} className="border border-outline-variant px-3 py-2 flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5 min-w-0">
                <p className="text-[14px] font-mono truncate">{s.description}</p>
                <p className="text-[14px] font-mono text-muted">
                  {s.openCount} view{s.openCount !== 1 ? 's' : ''} ·{' '}
                  {s.expiresAt ? `expires ${new Date(s.expiresAt).toLocaleDateString()}` : 'no expiry'}
                </p>
              </div>
              <button
                onClick={() => { void handleRevoke(s.id) }}
                disabled={revokingId === s.id}
                className="text-[14px] font-bold font-mono uppercase tracking-[0.06em] text-error hover:opacity-70 disabled:opacity-40 flex-shrink-0"
              >
                {revokingId === s.id ? '…' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
