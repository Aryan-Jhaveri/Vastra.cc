import { useEffect, useState, useCallback } from 'react'
import { Copy, Check, Plus, Loader2, ChevronRight, ChevronDown } from 'lucide-react'
import {
  listTokens,
  createToken,
  revokeToken,
  type ApiTokenView,
  type ApiTokenScope,
} from '../../api/tokens'

const SCOPE_OPTIONS: { value: ApiTokenScope; label: string; hint: string }[] = [
  { value: 'read', label: 'Read', hint: 'List items, outfits, weather (always on)' },
  { value: 'write', label: 'Write', hint: 'Create / edit items and outfits' },
  { value: 'ai', label: 'AI', hint: 'Categorize, suggest, try-on — costs tokens' },
]

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function ConnectionsSection() {
  const [tokens, setTokens] = useState<ApiTokenView[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<Set<ApiTokenScope>>(new Set(['read']))
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [created, setCreated] = useState<{ plaintext: string; token: ApiTokenView } | null>(null)
  const [copied, setCopied] = useState(false)

  const [revokingId, setRevokingId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setTokens(await listTokens())
    } catch {
      setError('Could not load tokens')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!expanded) return
    void refresh()
  }, [expanded, refresh])

  function toggleScope(s: ApiTokenScope) {
    setScopes(prev => {
      const next = new Set(prev)
      if (s === 'read') return next // read is always on
      if (next.has(s)) {
        next.delete(s)
      } else {
        next.add(s)
      }
      return next
    })
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setCreating(true)
    setCreateError(null)
    try {
      const res = await createToken(trimmed, [...scopes])
      setCreated(res)
      setName('')
      setScopes(new Set(['read']))
      if (expanded) await refresh()
      else setExpanded(true)
    } catch (err) {
      setCreateError((err as Error).message || 'Could not create token')
    } finally {
      setCreating(false)
    }
  }

  async function handleRevoke(id: string) {
    setRevokingId(id)
    try {
      await revokeToken(id)
      setTokens(prev => prev.filter(t => t.id !== id))
    } catch {
      setError('Could not revoke token')
    } finally {
      setRevokingId(null)
    }
  }

  async function handleCopy() {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.plaintext)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable */ }
  }

  return (
    <div className="mb-6">
      <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant">Connections</p>
      <p className="text-[13px] font-mono text-muted mt-2 mb-3 leading-relaxed">
        Personal API tokens let non-browser clients (Claude Desktop, Home Assistant, scripts) act as your account with a scoped key.
      </p>

      {created && (
        <div className="mb-3 border-2 border-ink bg-surface-dim p-3 rounded-base">
          <p className="text-[13px] font-bold font-mono uppercase tracking-[0.06em] text-ink mb-1">
            Copy your token — you won’t see it again
          </p>
          <div className="flex items-center gap-2 mt-2">
            <code className="flex-1 break-all text-[12px] font-mono bg-paper border border-outline-variant px-2 py-1.5 rounded-base">
              {created.plaintext}
            </code>
            <button
              onClick={handleCopy}
              className="border-2 border-ink px-3 py-1.5 text-[13px] font-bold font-mono uppercase tracking-[0.06em] hover:bg-accent hover:text-accent-on transition-colors rounded-base flex items-center gap-1.5 shrink-0"
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <button
            onClick={() => setCreated(null)}
            className="mt-2 text-[13px] font-bold font-mono uppercase tracking-[0.06em] text-muted hover:text-ink"
          >
            Done
          </button>
        </div>
      )}

      <form onSubmit={handleCreate} className="border-b border-outline-variant pb-3 mb-2">
        <label className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted">Name</label>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="e.g. Home Assistant"
          maxLength={128}
          className="mt-1 w-full border-2 border-ink px-3 py-2 text-sm font-mono outline-none bg-paper text-ink focus:bg-surface-dim"
        />
        <div className="mt-3 flex flex-col gap-1.5">
          {SCOPE_OPTIONS.map(opt => {
            const checked = scopes.has(opt.value)
            const locked = opt.value === 'read'
            return (
              <label key={opt.value} className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked}
                  onChange={() => toggleScope(opt.value)}
                  className="mt-0.5 accent-[color:var(--color-accent)]"
                />
                <div>
                  <p className="text-sm font-medium">
                    {opt.label}
                    {locked && <span className="text-[12px] font-mono text-muted ml-1.5">(default)</span>}
                  </p>
                  <p className="text-[12px] font-mono text-muted">{opt.hint}</p>
                </div>
              </label>
            )
          })}
        </div>
        {createError && <p className="text-[13px] font-mono text-error mt-2">{createError}</p>}
        <button
          type="submit"
          disabled={creating || !name.trim()}
          className="mt-3 border-2 border-ink px-4 py-2 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-accent hover:text-accent-on transition-colors disabled:opacity-40 flex items-center gap-1.5 rounded-base"
        >
          {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Create token
        </button>
      </form>

      <button
        onClick={() => setExpanded(e => !e)}
        className="border-b border-outline-variant py-3 flex items-center justify-between w-full text-left hover:bg-surface-dim transition-colors"
      >
        <p className="text-sm font-medium">Manage tokens</p>
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-muted" />
          : <ChevronRight className="w-3.5 h-3.5 text-muted" />}
      </button>

      {expanded && (
        <div className="py-2 flex flex-col gap-2">
          {loading && <p className="text-[13px] font-mono text-muted py-2">Loading…</p>}
          {error && <p className="text-[13px] font-mono text-error py-2">{error}</p>}
          {!loading && !error && tokens.length === 0 && (
            <p className="text-[13px] font-mono text-muted py-2">No active tokens.</p>
          )}
          {tokens.map(t => (
            <div key={t.id} className="border border-outline-variant px-3 py-2 flex items-start justify-between gap-3">
              <div className="flex flex-col gap-0.5 min-w-0">
                <p className="text-sm font-medium truncate">{t.name}</p>
                <p className="text-[13px] font-mono text-muted">
                  <code>{t.prefix}…</code> · {t.scopes.join(', ')}
                </p>
                <p className="text-[12px] font-mono text-muted">
                  Created {fmtTime(t.createdAt)} · Last used {fmtTime(t.lastUsedAt)}
                </p>
              </div>
              <button
                onClick={() => void handleRevoke(t.id)}
                disabled={revokingId === t.id}
                className="text-[13px] font-bold font-mono uppercase tracking-[0.06em] text-error hover:opacity-70 disabled:opacity-40 flex-shrink-0"
              >
                {revokingId === t.id ? '…' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
