import { useState } from 'react'
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { Spinner } from '../../ui/Spinner'
import { OutfitCard } from '../../OutfitCard'
import type { OutfitSuggestion } from '../../../api/outfits'

interface Props {
  suggestions: OutfitSuggestion[] | null
  phase: string
  retrievalMode: 'generated' | 'retrieved' | null
  contextDescription: string | null
  onSave?: (suggestion: OutfitSuggestion) => void
  onView?: (suggestion: OutfitSuggestion) => void
  onRegenerate?: () => void
  savingId?: string | null
  savedIds?: Set<string>
}

export function AIRecommendationsSection({
  suggestions,
  phase,
  retrievalMode,
  contextDescription,
  onSave,
  onView,
  onRegenerate,
  savingId,
  savedIds,
}: Props) {
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      const raw = sessionStorage.getItem('suggest-section-state')
      if (raw) return (JSON.parse(raw) as { ai?: boolean }).ai ?? false
    } catch {}
    return false
  })

  function setCollapsed(val: boolean) {
    try {
      const raw = sessionStorage.getItem('suggest-section-state')
      const state = raw ? JSON.parse(raw) as Record<string, boolean> : {}
      state.ai = val
      sessionStorage.setItem('suggest-section-state', JSON.stringify(state))
    } catch {}
    setCollapsedState(val)
  }

  const header = (
    <button
      onClick={() => setCollapsed(!collapsed)}
      className="flex items-center gap-1 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:text-muted transition-colors"
    >
      {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      AI Recommendations
    </button>
  )

  // Loading skeleton
  if (phase === 'shortlisting' || phase === 'generating') {
    return (
      <div className="pt-3">
        <div className="flex items-center justify-between mb-2 border-b-2 border-ink pb-2">
          {header}
        </div>
        {!collapsed && (
          <div className="flex items-center justify-center gap-2 py-8">
            <Spinner />
            <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">
              {phase === 'shortlisting' ? 'Preparing…' : 'Generating outfit ideas…'}
            </span>
          </div>
        )}
      </div>
    )
  }

  if (!suggestions || suggestions.length === 0) {
    if (phase === 'done') {
      return (
        <div className="pt-3">
          <div className="flex items-center justify-between mb-2 border-b-2 border-ink pb-2">
            {header}
          </div>
          {!collapsed && (
            <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] text-center py-6">
              No matching outfits found. Try adding more items.
            </p>
          )}
        </div>
      )
    }
    return null
  }

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-2 border-b-2 border-ink pb-2">
        <div className="flex items-center gap-2">
          {header}
          {retrievalMode === 'retrieved' && (
            <span className="text-[12px] font-mono text-accent uppercase tracking-[0.06em]">From saved</span>
          )}
        </div>
        {onRegenerate && (
          <button
            onClick={onRegenerate}
            className="border-2 border-ink bg-accent text-accent-on text-[14px] font-bold font-sans uppercase tracking-[0.08em] px-2 py-1 hover:bg-active shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" />
            Regenerate
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          {contextDescription && (
            <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] mb-2 truncate">
              Matching: {contextDescription}
            </p>
          )}

          <div className="flex flex-col gap-3">
            {suggestions.map((s, i) => (
              <OutfitCard
                key={`${s.item_ids.join(',')}-${i}`}
                suggestion={{ ...s, name: s.name || `Outfit #${String(i + 1).padStart(2, '0')}` }}
                saved={savedIds?.has(s.name)}
                onSave={savedIds?.has(s.name) ? undefined : onSave ? () => onSave(s) : undefined}
                onView={onView ? () => onView(s) : undefined}
                saving={savingId === s.name}
                showShare
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
