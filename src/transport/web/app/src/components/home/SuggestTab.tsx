import { useState, useCallback, useEffect } from 'react'
import { track } from '../../lib/analytics'
import { PhasedSuggestionLayout } from './PhasedSuggestionLayout'
import { SuggestOccasionGrid, SELECTED_KEY } from './SuggestOccasionGrid'
import { OutfitDetail } from '../../modals/OutfitDetail'
import { useDiscoverStream } from '../../hooks/useDiscoverStream'
import { createOutfit } from '../../api/outfits'
import type { HydratedOutfit, OutfitSuggestion } from '../../api/outfits'

interface LocationData {
  lat: number
  lon: number
  name: string
}

interface Props {
  location: LocationData | null
}

const SAVED_MAP_KEY = 'suggest-saved-map'

function loadSavedMap(): Record<string, string> {
  try {
    const raw = sessionStorage.getItem(SAVED_MAP_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

export function SuggestTab({ location }: Props) {
  const [savedMap, setSavedMap] = useState<Record<string, string>>(loadSavedMap)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [outfitDetail, setOutfitDetail] = useState<HydratedOutfit | null>(null)
  const [selectedOccasion, setSelectedOccasion] = useState<string | null>(
    () => sessionStorage.getItem(SELECTED_KEY) ?? null,
  )

  const savedIds = new Set(Object.keys(savedMap))

  const stream = useDiscoverStream('suggest')
  const { phase, error, submit, clear, reshuffleItems, reshuffleOutfits } = stream

  useEffect(() => {
    sessionStorage.removeItem(SELECTED_KEY)
  }, [])

  const handleSelectOccasion = useCallback((value: string | null) => {
    setSelectedOccasion(value)
    if (value) {
      sessionStorage.setItem(SELECTED_KEY, value)
    } else {
      sessionStorage.removeItem(SELECTED_KEY)
    }
  }, [])

  const doSubmit = useCallback((payload?: Parameters<typeof submit>[1]) => {
    if (!location) return
    submit('weather', {
      coords: { lat: location.lat, lon: location.lon },
      occasion: selectedOccasion ?? undefined,
      ...payload,
    }).catch(() => {})
  }, [location, selectedOccasion, submit])

  const handleSuggest = useCallback(async () => {
    if (!location) return
    track('suggest_requested')
    setSavedMap({})
    try { sessionStorage.removeItem(SAVED_MAP_KEY) } catch { /* noop */ }
    clear()
    doSubmit()
  }, [location, clear, doSubmit])

  async function handleSave(suggestion: OutfitSuggestion) {
    setSavingId(suggestion.name)
    try {
      const created = await createOutfit({
        name: suggestion.name,
        itemIds: suggestion.item_ids,
        occasion: suggestion.occasion,
        aiGenerated: true,
      })
      track('suggest_saved')
      setSavedMap(prev => {
        const next = { ...prev, [suggestion.name]: created.id }
        try { sessionStorage.setItem(SAVED_MAP_KEY, JSON.stringify(next)) } catch { /* quota */ }
        return next
      })
    } catch {
    } finally {
      setSavingId(null)
    }
  }

  function handleView(suggestion: OutfitSuggestion) {
    const realId = savedMap[suggestion.name] || ''
    setOutfitDetail({
      id: realId,
      name: suggestion.name,
      itemIds: JSON.stringify(suggestion.item_ids),
      occasion: suggestion.occasion,
      season: '[]',
      tags: '[]',
      aiGenerated: 1,
      weatherContext: null,
      notes: null,
      coverImageUri: null,
      timesWorn: 0,
      lastWornAt: null,
      createdAt: Date.now(),
      items: suggestion.items,
    } as HydratedOutfit)
  }

  function handleRegenerate() {
    if (!location) return
    doSubmit({ isRegenerate: true })
  }

  function handleReshuffleItems() {
    track('suggest_dismissed')
    const result = reshuffleItems()
    if (result?.exhausted && result.excludeIds && location) {
      doSubmit({ excludeIds: result.excludeIds })
    }
    return result
  }

  function handleReshuffleOutfits() {
    track('suggest_dismissed')
    const result = reshuffleOutfits()
    if (result?.exhausted && result.excludeIds && location) {
      doSubmit({ excludeIds: result.excludeIds })
    }
    return result
  }

  function handleClearAll() {
    setSavedMap({})
    try { sessionStorage.removeItem(SAVED_MAP_KEY) } catch { /* noop */ }
    clear()
    handleSelectOccasion(null)
  }

  const isActive = phase !== 'idle'

  useEffect(() => {
    if (isActive) track('suggest_viewed')
  }, [isActive])

  return (
    <div className="flex flex-col gap-4">
      {/* Section header */}
      <div className="flex items-center justify-between border-b-2 border-ink pb-2">
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Today's Outfit</span>
        {isActive ? (
          <button
            onClick={handleClearAll}
            className="text-[14px] font-bold font-sans uppercase tracking-[0.08em] border-2 border-error text-error px-3 py-1.5 bg-paper hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
          >
            Clear all
          </button>
        ) : (
          location && (
            <button
              onClick={handleSuggest}
              className="border-2 border-ink bg-accent text-accent-on text-[14px] font-bold font-sans uppercase tracking-[0.08em] px-3 py-1.5 hover:bg-active shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-40 disabled:cursor-not-allowed rounded-base"
            >
              {phase === 'idle' ? 'Suggest' : 'Loading…'}
            </button>
          )
        )}
      </div>

      {!location && (
        <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] text-center py-6">
          Set your location in Settings to get outfit ideas.
        </p>
      )}

      {location && !isActive && (
        <SuggestOccasionGrid selected={selectedOccasion} onSelect={handleSelectOccasion} />
      )}

      {/* Error */}
      {error && (
        <p className="text-[14px] font-mono text-error uppercase tracking-[0.06em]">{error}</p>
      )}

      {/* Phased results */}
      {isActive && (
        <>
          <PhasedSuggestionLayout
            stream={stream}
            onReshuffleItems={handleReshuffleItems}
            onReshuffleOutfits={handleReshuffleOutfits}
            onOutfitClick={setOutfitDetail}
            onSave={handleSave}
            onView={handleView}
            onRegenerate={handleRegenerate}
            savingId={savingId}
            savedIds={savedIds}
          />
          <button
            onClick={handleClearAll}
            className="w-full border-2 border-error text-error text-base font-bold font-sans uppercase tracking-[0.08em] py-3 bg-paper hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
          >
            Clear all
          </button>
        </>
      )}
      {outfitDetail && (
        <OutfitDetail
          outfit={outfitDetail}
          onClose={() => setOutfitDetail(null)}
          onChanged={() => setOutfitDetail(null)}
        />
      )}
    </div>
  )
}