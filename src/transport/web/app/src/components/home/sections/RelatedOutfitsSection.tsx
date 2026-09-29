import { useState } from 'react'
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { SavedOutfitCard } from '../../SavedOutfitCard'
import type { HydratedOutfit } from '../../../api/outfits'

interface Props {
  outfits: HydratedOutfit[] | null
  hasMore: boolean
  phase: string
  source?: string
  onReshuffle: () => { exhausted?: boolean; excludeIds?: { outfits?: string[] } } | undefined
  onOutfitClick?: (outfit: HydratedOutfit) => void
}

export function RelatedOutfitsSection({ outfits, hasMore, phase, source, onReshuffle, onOutfitClick }: Props) {
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      const raw = sessionStorage.getItem('suggest-section-state')
      if (raw) return (JSON.parse(raw) as { related?: boolean }).related ?? false
    } catch {}
    return false
  })

  const setCollapsed = (val: boolean) => {
    try {
      const raw = sessionStorage.getItem('suggest-section-state')
      const state = raw ? JSON.parse(raw) as Record<string, boolean> : {}
      state.related = val
      sessionStorage.setItem('suggest-section-state', JSON.stringify(state))
    } catch {}
    setCollapsedState(val)
  }

  const isLoading = phase === 'shortlisting' || phase === 'generating'

  const header = (
    <button
      onClick={() => setCollapsed(!collapsed)}
      className="flex items-center gap-1 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:text-muted transition-colors"
    >
      {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      Related Outfits
      {source === 'recent' && (
        <span className="text-[11px] font-mono text-muted uppercase tracking-[0.06em] ml-1">Recently saved</span>
      )}
    </button>
  )

  // Loading skeleton
  if (isLoading && (!outfits || outfits.length === 0)) {
    return (
      <div className="pt-3">
        <div className="flex items-center justify-between mb-2 border-b-2 border-ink pb-2">
          {header}
        </div>
        {!collapsed && (
          <div className="grid grid-cols-2 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="border-2 border-ink bg-surface-dim rounded-base animate-pulse">
                <div className="aspect-[3/4] bg-surface" />
                <div className="p-2 space-y-1.5">
                  <div className="h-3 bg-surface w-3/4 rounded" />
                  <div className="h-2.5 bg-surface w-1/2 rounded" />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  // Done + empty
  if (phase === 'done' && (!outfits || outfits.length === 0)) {
    return (
      <div className="pt-3">
        <div className="flex items-center justify-between mb-2 border-b-2 border-ink pb-2">
          {header}
        </div>
        {!collapsed && (
          <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] text-center py-6">
            No matching saved outfits yet — Save an AI suggestion below to seed this section.
          </p>
        )}
      </div>
    )
  }

  if (!outfits || outfits.length === 0) return null

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-2 border-b-2 border-ink pb-2">
        <div className="flex items-center gap-2">
          {header}
          {source === 'recent' && (
            <span className="text-[11px] font-mono text-muted uppercase tracking-[0.06em]">Recently saved</span>
          )}
        </div>
        {hasMore && (
          <button
            onClick={() => onReshuffle()}
            className="border-2 border-ink bg-accent text-accent-on text-[14px] font-bold font-sans uppercase tracking-[0.08em] px-2 py-1 hover:bg-active shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base flex items-center gap-1"
          >
            <RefreshCw className="w-3 h-3" />
            Reshuffle
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="grid grid-cols-2 gap-3 animate-grid-in">
          {outfits.map(outfit => (
            <SavedOutfitCard
              key={outfit.id}
              outfit={outfit}
              onClick={() => onOutfitClick?.(outfit)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
