import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { createOutfit } from '../api/outfits'
import { Button } from '../components/ui/Button'
import { TagEditor } from '../components/ui/TagEditor'
import { OccasionPicker } from '../components/ui/OccasionPicker'
import type { Item } from '../api/items'
import type { Outfit } from '../api/outfits'

const SEASONS = ['spring', 'summer', 'fall', 'winter', 'all']

interface Props {
  items: Item[]
  onClose: () => void
  /** Receives the created outfit (#332: Related shows it with + Collection). */
  onSaved: (outfit: Outfit) => void
}

export function OutfitSaveModal({ items, onClose, onSaved }: Props) {
  const [name, setName] = useState('')
  const [occasion, setOccasion] = useState('')
  const [selectedSeasons, setSelectedSeasons] = useState<string[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleSeason(s: string) {
    setSelectedSeasons(prev =>
      prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]
    )
  }

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)
    try {
      const outfit = await createOutfit({
        name: name.trim(),
        itemIds: items.map(i => i.id),
        occasion: occasion.trim() || undefined,
        season: selectedSeasons.length ? selectedSeasons : undefined,
        tags: tags.length ? tags : undefined,
        notes: notes.trim() || undefined,
      })
      onSaved(outfit)
    } catch (err) {
      setError(String(err))
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 nav-anchor-right z-50 flex items-end sm:items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-paper border-2 border-ink w-full max-w-lg max-h-[90vh] flex flex-col rounded-base" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b-2 border-ink shrink-0">
          <button
            onClick={onClose}
            className="text-ink hover:text-muted flex items-center justify-center"
            aria-label="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">New Outfit</span>
          <div className="w-8" />
        </div>

        <div className="overflow-y-auto flex-1 p-4 flex flex-col gap-4">
          {error && (
            <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[13px] font-mono uppercase tracking-[0.06em] rounded-base">
              {error}
            </div>
          )}

          {/* Selected item strip */}
          <div>
            <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">
              {items.length} items
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {items.map(item => (
                <div key={item.id} className="shrink-0 w-14 h-[72px] border-2 border-ink overflow-hidden rounded-base">
                  <img src={`/${item.imageUri}`} alt={item.subcategory ?? item.category} className="h-full w-full object-contain" />
                </div>
              ))}
            </div>
          </div>

          {/* Name */}
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-mono text-muted uppercase tracking-[0.08em]">Name *</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Weekend Casual"
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
              className="border-2 border-ink px-3 py-2 text-sm font-mono outline-none focus:bg-surface-dim"
            />
          </div>

          <Button onClick={handleSave} loading={saving} className="w-full mt-2">
            Save Outfit
          </Button>
        </div>
      </div>
    </div>
  )
}
