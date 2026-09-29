import { useState } from 'react'
import type { HydratedOutfit } from '../api/outfits'
import { SavedOutfitCard } from './SavedOutfitCard'
import { FilterBar } from './FilterBar'
import { Spinner } from './ui/Spinner'

const SEASONS = ['spring', 'summer', 'fall', 'winter', 'all']

interface OutfitPickerProps {
  outfits: HydratedOutfit[]
  loading: boolean
  selectedIds: string[]
  onToggle: (id: string) => void
  /** Outfit IDs already in some target collection — rendered greyed out and unselectable */
  existingOutfitIds?: string[]
  emptyMessage?: string
}

export function OutfitPicker({
  outfits,
  loading,
  selectedIds,
  onToggle,
  existingOutfitIds = [],
  emptyMessage = 'No saved outfits yet.',
}: OutfitPickerProps) {
  const [selectedOccasion, setSelectedOccasion] = useState('')
  const [selectedSeason, setSelectedSeason] = useState('')
  const [selectedTag, setSelectedTag] = useState('')
  const [aiOnly, setAiOnly] = useState(false)

  const existingSet = new Set(existingOutfitIds)

  const occasions = [...new Set(
    outfits.map(o => o.occasion?.trim().toLowerCase()).filter(Boolean) as string[]
  )].sort()
  const tags = [...new Set(outfits.flatMap(o => {
    try { return (JSON.parse(o.tags || '[]') as string[]).map(t => t.trim().toLowerCase()) } catch { return [] }
  }))].filter(Boolean).sort()

  const filterConfigs = [
    ...(occasions.length > 0 ? [{ key: 'occasion', label: 'Occasion', options: occasions }] : []),
    { key: 'season', label: 'Season', options: SEASONS },
    ...(tags.length > 0 ? [{ key: 'tag', label: 'Tag', options: tags }] : []),
  ]
  const filterValues = { occasion: selectedOccasion, season: selectedSeason, tag: selectedTag }
  const activeFilterCount =
    [selectedOccasion, selectedSeason, selectedTag].filter(Boolean).length + (aiOnly ? 1 : 0)

  function handleFilterChange(key: string, value: string) {
    if (key === 'occasion') setSelectedOccasion(value)
    else if (key === 'season') setSelectedSeason(value)
    else if (key === 'tag') setSelectedTag(value)
  }

  const filtered = outfits.filter(o => {
    if (selectedOccasion && o.occasion?.toLowerCase() !== selectedOccasion.toLowerCase()) return false
    if (selectedSeason) {
      try { if (!(JSON.parse(o.season || '[]') as string[]).includes(selectedSeason)) return false }
      catch { return false }
    }
    if (selectedTag) {
      try {
        const lower = (JSON.parse(o.tags || '[]') as string[]).map(t => t.toLowerCase())
        if (!lower.includes(selectedTag.toLowerCase())) return false
      } catch { return false }
    }
    if (aiOnly && !o.aiGenerated) return false
    return true
  })

  const noOutfitsAtAll = !loading && outfits.length === 0
  const noMatches = !loading && outfits.length > 0 && filtered.length === 0

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Filters */}
      <div className="px-4 pt-3 pb-2 shrink-0 flex flex-wrap items-end gap-2 border-b-2 border-ink">
        <div className="flex-1">
          <FilterBar
            filters={filterConfigs}
            values={filterValues}
            onChange={handleFilterChange}
            onClear={() => {
              setSelectedOccasion('')
              setSelectedSeason('')
              setSelectedTag('')
              setAiOnly(false)
            }}
            activeCount={activeFilterCount}
          />
        </div>
        <button
          onClick={() => setAiOnly(v => !v)}
          className={`shrink-0 self-end px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] border-2 border-ink transition-colors rounded-base ${
            aiOnly ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
          }`}
        >
          AI Only
        </button>
      </div>

      {/* Grid */}
      <div className="overflow-y-auto flex-1 p-4">
        {loading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : noOutfitsAtAll ? (
          <p className="text-[14px] font-mono text-muted uppercase tracking-[0.08em] text-center py-12">
            {emptyMessage}
          </p>
        ) : noMatches ? (
          <p className="text-[14px] font-mono text-muted uppercase tracking-[0.08em] text-center py-12">
            No outfits matching filters.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 animate-grid-in">
            {filtered.map(outfit => {
              const alreadyIn = existingSet.has(outfit.id)
              return (
                <div
                  key={outfit.id}
                  className={`relative ${alreadyIn ? 'opacity-40 pointer-events-none' : ''}`}
                >
                  <SavedOutfitCard
                    outfit={outfit}
                    selectable
                    selected={selectedIds.includes(outfit.id)}
                    onClick={() => onToggle(outfit.id)}
                  />
                  {alreadyIn && (
                    <div className="absolute inset-0 flex items-end justify-center pb-2 pointer-events-none">
                      <span className="text-[14px] font-bold font-mono uppercase tracking-[0.06em] bg-ink text-accent-on px-1.5 py-0.5">
                        Already added
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
