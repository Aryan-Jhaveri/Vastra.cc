import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useItemCache } from '../context/ItemCacheContext'
import { createOutfit } from '../api/outfits'
import { AuthImage } from '../components/AuthImage'
import { ItemCard } from '../components/ItemCard'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'
import { TagEditor } from '../components/ui/TagEditor'
import { OccasionPicker } from '../components/ui/OccasionPicker'

const SEASONS = ['spring', 'summer', 'fall', 'winter', 'all']

interface OutfitBuilderProps {
  onClose: () => void
  onCreated: () => void
  defaultItemIds?: string[]
  defaultCoverImageUri?: string
  defaultName?: string
  onSaved?: (outfitId: string) => void
}

export function OutfitBuilder({ onClose, onCreated, defaultItemIds, defaultCoverImageUri, defaultName, onSaved }: OutfitBuilderProps) {
  const { items, loading } = useItemCache()
  const isPreset = defaultItemIds !== undefined
  const [step, setStep] = useState<1 | 2>(isPreset ? 2 : 1)
  const [selectedIds, setSelectedIds] = useState<string[]>(defaultItemIds ?? [])
  const [name, setName] = useState(defaultName ?? '')
  const [occasion, setOccasion] = useState('')
  const [selectedSeasons, setSelectedSeasons] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleItem(id: string) {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  function toggleSeason(s: string) {
    setSelectedSeasons(prev =>
      prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
    )
  }

  async function handleCreate() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)
    try {
      const outfit = await createOutfit({
        name: name.trim(),
        itemIds: selectedIds,
        occasion: occasion.trim() || undefined,
        season: selectedSeasons.length ? selectedSeasons : undefined,
        tags: tags.length ? tags : undefined,
        notes: notes.trim() || undefined,
      })
      onSaved?.(outfit.id)
      onCreated()
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 nav-anchor-right z-50 flex justify-center bg-black/50" onClick={onClose}>
      <div className="bg-paper border-x-2 border-ink w-full max-w-lg flex flex-col h-full overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b-2 border-ink shrink-0">
          <button
            onClick={step === 1 || isPreset ? onClose : () => setStep(1)}
            className="text-ink hover:text-muted flex items-center justify-center"
            aria-label="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">
            {isPreset ? 'Save as Outfit' : `New Outfit — ${step === 1 ? 'Pick Items' : 'Details'}`}
          </span>
          <div className="w-8" />
        </div>

        {/* Step 1 — item picker */}
        {step === 1 && (
          <>
            <div className="overflow-y-auto flex-1 p-4">
              {loading ? (
                <div className="flex justify-center py-8"><Spinner /></div>
              ) : items.length === 0 ? (
                <p className="text-[13px] font-mono text-muted text-center py-8">No items in your closet yet.</p>
              ) : (
                <div className="grid grid-cols-3 gap-2 animate-grid-in">
                  {items.map(item => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      selectable
                      selected={selectedIds.includes(item.id)}
                      onClick={() => toggleItem(item.id)}
                    />
                  ))}
                </div>
              )}
            </div>
            <div className="p-4 border-t-2 border-ink shrink-0">
              <Button
                className="w-full"
                disabled={selectedIds.length < 2}
                onClick={() => setStep(2)}
              >
                Next — {selectedIds.length} selected
              </Button>
              {selectedIds.length < 2 && (
                <p className="text-center text-[11px] font-mono text-muted mt-1.5 uppercase tracking-[0.06em]">
                  Select at least 2 items
                </p>
              )}
            </div>
          </>
        )}

        {/* Step 2 — details */}
        {step === 2 && (
          <div className="overflow-y-auto flex-1 p-4 flex flex-col gap-4">
            {error && (
              <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[13px] font-mono uppercase tracking-[0.06em] rounded-base">
                {error}
              </div>
            )}

            {/* Selected item strip */}
            <div>
              <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">
                {selectedIds.length} items
              </p>
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                {selectedIds.map(id => {
                  const item = items.find(i => i.id === id)
                  if (!item) return null
                  return (
                    <div key={id} className="shrink-0 w-14 h-[72px] border-2 border-ink overflow-hidden rounded-base">
                      <img src={`/${item.imageUri}`} alt={item.subcategory ?? item.category} className="h-full w-full object-contain" />
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Cover preview (from tryon result) */}
            {defaultCoverImageUri && (
              <div>
                <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Cover</p>
                <div className="w-full aspect-[3/4] border-2 border-ink overflow-hidden bg-surface-dim rounded-base">
                  <AuthImage src={`/${defaultCoverImageUri}`} alt="Outfit cover" className="w-full h-full object-contain" />
                </div>
              </div>
            )}

            {/* Name */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-mono text-muted uppercase tracking-[0.08em]">Name *</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Weekend Casual"
                maxLength={100}
                className="border-2 border-ink px-3 py-2 text-sm font-mono outline-none focus:bg-surface-dim"
              />
            </div>

            {/* Occasion */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-mono text-muted uppercase tracking-[0.08em]">Occasion</label>
              <OccasionPicker value={occasion} onChange={setOccasion} />
            </div>

            {/* Season */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-mono text-muted uppercase tracking-[0.08em]">Season</label>
              <div className="flex gap-1.5 flex-wrap">
                {SEASONS.map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => toggleSeason(s)}
                    className={`px-3 py-1.5 text-[12px] font-bold font-sans uppercase tracking-[0.08em] border-2 border-ink shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] capitalize rounded-base ${
                      selectedSeasons.includes(s) ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Tags */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-mono text-muted uppercase tracking-[0.08em]">Tags</label>
              <TagEditor tags={tags} onChange={setTags} placeholder="Add tag, press Enter" created />
            </div>

            {/* Notes */}
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-mono text-muted uppercase tracking-[0.08em]">Notes</label>
              <input
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Optional notes…"
                maxLength={500}
                className="border-2 border-ink px-3 py-2 text-sm font-mono outline-none focus:bg-surface-dim"
              />
            </div>

            <Button onClick={handleCreate} loading={saving} className="w-full mt-2">
              Save Outfit
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
