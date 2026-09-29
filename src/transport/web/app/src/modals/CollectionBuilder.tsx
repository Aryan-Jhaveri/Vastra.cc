import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useSavedOutfits } from '../hooks/useSavedOutfits'
import { createCollection, updateCollection } from '../api/collections'
import { addOutfitsToCollection } from '../api/collections'
import { OutfitPicker } from '../components/OutfitPicker'
import { Button } from '../components/ui/Button'
import { TagEditor } from '../components/ui/TagEditor'
import type { Collection } from '../api/collections'

const SEASONS = ['spring', 'summer', 'fall', 'winter', 'all']

interface CollectionBuilderProps {
  onClose: () => void
  onCreated: () => void
  /** Pass to edit an existing collection instead of creating */
  editing?: Collection
  /** Pre-selected outfit IDs (from bulk-add flow) */
  preSelectedIds?: string[]
}

export function CollectionBuilder({ onClose, onCreated, editing, preSelectedIds = [] }: CollectionBuilderProps) {
  const { outfits, loading } = useSavedOutfits()
  const [step, setStep] = useState<1 | 2>(preSelectedIds.length > 0 ? 2 : 1)
  const [selectedIds, setSelectedIds] = useState<string[]>(preSelectedIds)
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [selectedSeasons, setSelectedSeasons] = useState<string[]>(() => {
    try { return JSON.parse(editing?.season ?? '[]') } catch { return [] }
  })
  const [tags, setTags] = useState<string[]>(() => {
    try { return JSON.parse(editing?.tags ?? '[]') } catch { return [] }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleOutfit(id: string) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  function toggleSeason(s: string) {
    setSelectedSeasons(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s])
  }

  async function handleSave() {
    if (!name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)
    try {
      if (editing) {
        await updateCollection(editing.id, {
          name: name.trim(),
          description: description.trim() || null,
          season: selectedSeasons.length ? selectedSeasons : [],
          tags: tags.length ? tags : [],
        })
        if (selectedIds.length > 0) {
          await addOutfitsToCollection(editing.id, selectedIds)
        }
      } else {
        const col = await createCollection({
          name: name.trim(),
          description: description.trim() || undefined,
          season: selectedSeasons.length ? selectedSeasons : undefined,
          tags: tags.length ? tags : undefined,
        })
        if (selectedIds.length > 0) {
          await addOutfitsToCollection(col.id, selectedIds)
        }
      }
      onCreated()
      onClose()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const title = editing ? 'Edit Collection' : 'New Collection'

  return (
    <div className="fixed inset-0 nav-anchor-right z-50 flex justify-center bg-black/50" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-paper border-x-2 border-ink w-full max-w-lg flex flex-col h-full overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b-2 border-ink shrink-0">
          <button
            onClick={step === 1 || preSelectedIds.length > 0 ? onClose : () => setStep(1)}
            className="text-ink hover:text-muted flex items-center justify-center"
            aria-label="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <span className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">
            {title} — {step === 1 ? 'Pick Outfits' : 'Details'}
          </span>
          <div className="w-8" />
        </div>

        {/* Step 1 — outfit picker */}
        {step === 1 && (
          <>
            <OutfitPicker
              outfits={outfits}
              loading={loading}
              selectedIds={selectedIds}
              onToggle={toggleOutfit}
            />
            <div className="p-4 border-t-2 border-ink shrink-0">
              <Button className="w-full" onClick={() => setStep(2)}>
                Next{selectedIds.length > 0 ? ` — ${selectedIds.length} selected` : ''}
              </Button>
              <p className="text-center text-[11px] font-mono text-muted mt-1.5 uppercase tracking-[0.06em]">
                You can add outfits later
              </p>
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

            {/* Selected outfit thumbnails */}
            {selectedIds.length > 0 && (
              <div>
                <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">
                  {selectedIds.length} outfit{selectedIds.length !== 1 ? 's' : ''}
                </p>
                <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                  {selectedIds.map(id => {
                    const outfit = outfits.find(o => o.id === id)
                    if (!outfit) return null
                    const thumb = outfit.coverImageUri
                      ? `/${outfit.coverImageUri}`
                      : outfit.items?.[0] ? `/${outfit.items[0].imageUri}` : null
                    return (
                      <div key={id} className="shrink-0 w-14 h-[72px] border-2 border-ink overflow-hidden rounded-base">
                        {thumb
                          ? <img src={thumb} alt={outfit.name} className="h-full w-full object-contain" />
                          : <div className="h-full w-full bg-surface-dim" />}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-mono text-muted uppercase tracking-[0.08em]">Name *</label>
              <input
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Summer in Lisbon"
                maxLength={100}
                className="border-2 border-ink px-3 py-2 text-sm font-mono outline-none focus:bg-surface-dim"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-mono text-muted uppercase tracking-[0.08em]">Description</label>
              <input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Optional description…"
                maxLength={500}
                className="border-2 border-ink px-3 py-2 text-sm font-mono outline-none focus:bg-surface-dim"
              />
            </div>

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

            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-mono text-muted uppercase tracking-[0.08em]">Tags</label>
              <TagEditor tags={tags} onChange={setTags} placeholder="Add tag, press Enter" created />
            </div>

            <Button onClick={handleSave} loading={saving} className="w-full mt-2">
              {editing ? 'Save Changes' : 'Create Collection'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
