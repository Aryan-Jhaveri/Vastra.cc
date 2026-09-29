import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, ChevronRight, Plus, X, Trash2, ImagePlus } from 'lucide-react'
import { AuthImage } from '../components/AuthImage'
import { OutfitMosaic } from '../components/OutfitMosaic'
import { updateOutfit, uploadOutfitCover, removeOutfitCover, deleteOutfit } from '../api/outfits'
import { usePasteImage } from '../lib/usePasteImage'
import { useMountAnimation } from '../lib/animations'
import type { HydratedOutfit } from '../api/outfits'
import { fetchSettings } from '../api/settings'
import type { AppSettings } from '../api/settings'
import { Button } from '../components/ui/Button'
import { ShareButton } from '../components/ShareButton'
import { Spinner } from '../components/ui/Spinner'
import { ChipToggle } from '../components/ui/ChipToggle'
import { InlineField } from '../components/ui/InlineField'
import { TagEditor } from '../components/ui/TagEditor'
import { JobModal } from './JobModal'
import { AddToCollectionSheet } from './AddToCollectionSheet'
import { ItemDetail } from './ItemDetail'
import { ItemPickerSheet } from './ItemPickerSheet'
import { updateOutfitItems } from '../api/outfits'
import type { Item } from '../api/items'
import { OutfitRelated } from '../components/related/OutfitRelated'
import { useRelatedEnabled } from '../hooks/useRelatedEnabled'
import { OccasionPicker } from '../components/ui/OccasionPicker'

const SEASONS = ['spring', 'summer', 'fall', 'winter', 'all']

interface OutfitDetailProps {
  outfit: HydratedOutfit
  onClose: () => void
  onChanged: () => void
}

export function OutfitDetail({ outfit: initialOutfit, onClose, onChanged }: OutfitDetailProps) {
  const navigate = useNavigate()
  const [outfit, setOutfit] = useState<HydratedOutfit>(initialOutfit)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [removingCover, setRemovingCover] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [addToCollectionOpen, setAddToCollectionOpen] = useState(false)
  const relatedEnabled = useRelatedEnabled()
  // #332 — a related outfit opened from this card stacks on top of it.
  const [relatedOutfit, setRelatedOutfit] = useState<HydratedOutfit | null>(null)
  const [selectedItem, setSelectedItem] = useState<Item | null>(null)
  const [addItemsOpen, setAddItemsOpen] = useState(false)
  const [settings, setSettings] = useState<AppSettings>({})
  const coverInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchSettings().then(setSettings).catch(() => {})
  }, [])

  const currentSeasons: string[] = (() => { try { return JSON.parse(outfit.season || '[]') } catch { return [] } })()
  const currentTags: string[] = (() => { try { return JSON.parse(outfit.tags || '[]') } catch { return [] } })()

  async function patchOutfit(data: Parameters<typeof updateOutfit>[1]) {
    try {
      const updated = await updateOutfit(outfit.id, data)
      setOutfit(o => ({ ...o, ...updated }))
      onChanged()
    } catch (err) { setError(String(err)) }
  }

  async function doUploadCover(file: File) {
    setUploadingCover(true)
    setError(null)
    try {
      const updated = await uploadOutfitCover(outfit.id, file)
      setOutfit(o => ({ ...o, ...updated }))
      onChanged()
    } catch (err) { setError(String(err)) }
    finally { setUploadingCover(false) }
  }

  async function handleCoverUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await doUploadCover(file)
  }

  usePasteImage(files => void doUploadCover(files[0]))

  async function handleRemoveCover() {
    setRemovingCover(true)
    setError(null)
    try {
      const updated = await removeOutfitCover(outfit.id)
      setOutfit(o => ({ ...o, ...updated }))
      onChanged()
    } catch (err) { setError(String(err)) }
    finally { setRemovingCover(false) }
  }

  async function handleDelete() {
    setDeleting(true)
    try { await deleteOutfit(outfit.id); onClose(); onChanged() }
    catch (err) { setError(String(err)); setDeleting(false) }
  }

  const modalBackdropRef = useRef<HTMLDivElement>(null)
  const modalPanelRef = useRef<HTMLDivElement>(null)
  useMountAnimation(modalBackdropRef, [{ opacity: '0' }, { opacity: '1' }])
  useMountAnimation(modalPanelRef, [
    { opacity: '0', transform: 'scale(0.96) translateY(12px)' },
    { opacity: '1', transform: 'scale(1) translateY(0)' },
  ])

  return (
    <>
      <div ref={modalBackdropRef} className="fixed inset-0 nav-anchor-right z-50 flex justify-center bg-black/50" onClick={onClose}>
        <div ref={modalPanelRef} className="bg-paper border-x-2 border-ink w-full max-w-lg flex flex-col h-full overflow-hidden" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b-2 border-ink flex-none">
            <button onClick={onClose} className="text-ink hover:text-muted flex items-center justify-center" aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
            <span className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">Outfit</span>
            <div className="w-8" />
          </div>

          <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto">
            {error && (
              <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[13px] font-mono uppercase tracking-[0.06em] rounded-base">
                {error}
              </div>
            )}

            {/* Cover photo */}
            <div>
              <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">
                Cover Photo
              </p>
              {outfit.coverImageUri ? (
                <div className="relative overflow-hidden border-2 border-ink rounded-base">
                  <AuthImage src={`/${outfit.coverImageUri}`} alt="Cover" className="w-full h-auto max-h-[70vh] object-contain block" />
                  <div className="absolute bottom-2 right-2 flex gap-1.5">
                    <button
                      onClick={handleRemoveCover}
                      disabled={removingCover || uploadingCover}
                      className="flex items-center gap-1 border-2 border-error bg-paper text-error px-2 py-1 text-[11px] font-bold font-mono uppercase tracking-[0.06em] shadow-flat-xs active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base disabled:opacity-50"
                    >
                      <Trash2 className="w-3 h-3 shrink-0" strokeWidth={2} /><span className="leading-none">{removingCover ? '…' : 'Remove'}</span>
                    </button>
                    <label className={`cursor-pointer flex items-center gap-1 border-2 border-ink bg-paper text-ink px-2 py-1 text-[11px] font-bold font-mono uppercase tracking-[0.06em] shadow-flat-xs active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base ${uploadingCover || removingCover ? 'opacity-50 pointer-events-none' : ''}`}>
                      <ImagePlus className="w-3 h-3 shrink-0" strokeWidth={2} /><span className="leading-none">{uploadingCover ? '…' : 'Change'}</span>
                      <input ref={coverInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleCoverUpload} />
                    </label>
                  </div>
                </div>
              ) : outfit.items.length > 0 ? (
                <label className={`relative block border-2 border-ink rounded-base overflow-hidden cursor-pointer hover:bg-hover transition-colors ${uploadingCover ? 'opacity-50 pointer-events-none' : ''}`}>
                  <div className="aspect-[3/4]">
                    <OutfitMosaic items={outfit.items} />
                  </div>
                  <div className="absolute bottom-2 right-2 flex items-center gap-1 border-2 border-ink bg-paper text-ink px-2 py-1 text-[11px] font-bold font-mono uppercase tracking-[0.06em] shadow-flat-xs rounded-base pointer-events-none">
                    <ImagePlus className="w-3 h-3 shrink-0" strokeWidth={2} /><span className="leading-none">{uploadingCover ? 'Uploading…' : 'Add Cover'}</span>
                  </div>
                  <input ref={coverInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleCoverUpload} />
                </label>
              ) : (
                <label className={`flex items-center gap-3 border-2 border-dashed border-outline p-3 cursor-pointer hover:border-ink transition-colors ${uploadingCover ? 'opacity-50 pointer-events-none' : ''}`}>
                  {uploadingCover ? <Spinner size={20} /> : <div className="w-8 h-8 border-2 border-outline flex items-center justify-center text-muted"><Plus className="w-5 h-5" strokeWidth={2.5} /></div>}
                  <p className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">
                    {uploadingCover ? 'Uploading…' : 'Add Cover Photo'}
                  </p>
                  <input ref={coverInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleCoverUpload} />
                </label>
              )}
            </div>

            <InlineField
              label="Name"
              value={outfit.name}
              onSave={async (next) => {
                if (!next.trim() || next.trim() === outfit.name) return
                await patchOutfit({ name: next.trim() })
              }}
              maxLength={100}
              valueClassName="font-bold text-base"
            />

            {/* Occasion */}
            <div>
              <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Occasion</p>
              <OccasionPicker
                value={outfit.occasion}
                onChange={async (next) => {
                  try {
                    const updated = await updateOutfit(outfit.id, { occasion: next })
                    setOutfit(o => ({ ...o, ...updated }))
                    onChanged()
                  } catch (err) { setError(String(err)) }
                }}
              />
            </div>

            {/* Season */}
            <div>
              <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Season</p>
              <ChipToggle
                options={SEASONS}
                selected={currentSeasons}
                onChange={async (next) => {
                  try {
                    const updated = await updateOutfit(outfit.id, { season: next })
                    setOutfit(o => ({ ...o, ...updated }))
                    onChanged()
                  } catch (err) { setError(String(err)) }
                }}
              />
            </div>

            {/* Tags */}
            <div>
              <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Tags</p>
              <TagEditor
                created
                tags={currentTags}
                onChange={async (next) => {
                  try {
                    const updated = await updateOutfit(outfit.id, { tags: next })
                    setOutfit(o => ({ ...o, ...updated }))
                    onChanged()
                  } catch (err) { setError(String(err)) }
                }}
              />
            </div>

            <InlineField
              label="Notes"
              value={outfit.notes}
              onSave={async (next) => {
                if (next === (outfit.notes ?? '')) return
                await patchOutfit({ notes: next || undefined })
              }}
              placeholder="Add notes about this outfit…"
              multiline
              alwaysOpen
              maxLength={500}
              valueClassName="text-[13px] font-mono text-muted"
            />

            {/* Item strip */}
            <div>
              <div className="flex items-center justify-between border-b-2 border-ink pb-1.5 mb-2">
                <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em]">
                  Items ({outfit.items.length})
                </p>
                <button
                  onClick={() => setAddItemsOpen(true)}
                  className="text-[12px] font-bold font-mono uppercase tracking-[0.08em] border-2 border-ink px-2 py-0.5 hover:bg-surface-dim transition-colors flex items-center gap-1 rounded-base"
                >
                  <Plus className="w-3 h-3" strokeWidth={2.5} /> Add
                </button>
              </div>
              <div className="flex gap-2 overflow-x-auto pt-2 px-2 pb-1 -mx-2 scrollbar-hide">
                {outfit.items.map(item => (
                  <div key={item.id} className="relative shrink-0">
                    <button
                      onClick={() => setSelectedItem(item as Item)}
                      className="w-16 h-20 border-2 border-ink overflow-hidden hover:opacity-80 transition-opacity block rounded-base"
                    >
                      <AuthImage
                        src={`/${item.imageUri}`}
                        alt={item.subcategory ?? item.category}
                        className="h-full w-full object-contain"
                      />
                    </button>
                    <button
                      onClick={async () => {
                        const newIds = outfit.items.filter(i => i.id !== item.id).map(i => i.id)
                        try {
                          const updated = await updateOutfitItems(outfit.id, newIds)
                          setOutfit(o => ({ ...o, ...updated, items: outfit.items.filter(i => i.id !== item.id) }))
                          onChanged()
                        } catch { /* ignore */ }
                      }}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-accent text-accent-on flex items-center justify-center hover:bg-active z-10"
                      aria-label="Remove item"
                    >
                      <X className="w-2.5 h-2.5" strokeWidth={2.5} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {relatedEnabled && <OutfitRelated anchorId={outfit.id} onOpenOutfit={setRelatedOutfit} />}

            {/* Actions */}
            <div className="flex flex-col gap-2 border-t-2 border-ink pt-3">
              <ShareButton
                source="outfit"
                sourceRef={outfit.id}
                description={`${outfit.name}${outfit.occasion ? ` — ${outfit.occasion}` : ''}${outfit.notes ? `. ${outfit.notes}` : ''}`}
                imageUris={outfit.items.map(i => i.imageUri)}
                className="w-full justify-center"
              />
              <Button
                onClick={() => {
                  onClose()
                  navigate('/tryon', { state: { outfitItemIds: outfit.items.map(i => i.id), sourceOutfitId: outfit.id } })
                }}
                variant="secondary"
                className="w-full"
              >
                Try On <ChevronRight className="w-4 h-4 inline-block ml-1" />
              </Button>
              <Button
                onClick={() => setAddToCollectionOpen(true)}
                variant="secondary"
                className="w-full"
              >
                Add to Collection
              </Button>
              <Button
                onClick={() => setScheduleModalOpen(true)}
                variant="secondary"
                className="w-full"
              >
                Schedule
              </Button>
              {confirmDelete ? (
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setConfirmDelete(false)} className="flex-1">Keep it</Button>
                  <Button variant="secondary" onClick={handleDelete} loading={deleting} className="flex-1 !border-error !text-error hover:!bg-error-container">Delete</Button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="w-full text-[12px] font-mono text-muted uppercase tracking-[0.08em] py-2 hover:text-ink"
                >
                  Delete
                </button>
              )}

              <Button variant="ghost" onClick={onClose} className="w-full">
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </div>

      {scheduleModalOpen && (
        <JobModal
          initialValues={{
            name: `Wear ${outfit.name}`,
            type: 'outfit_reminder',
            params: {
              outfitId: outfit.id,
            },
          }}
          onClose={() => setScheduleModalOpen(false)}
          onSaved={() => setScheduleModalOpen(false)}
        />
      )}

      {relatedOutfit && (
        <OutfitDetail outfit={relatedOutfit} onClose={() => setRelatedOutfit(null)} onChanged={onChanged} />
      )}
      {addToCollectionOpen && (
        <AddToCollectionSheet
          outfitIds={[outfit.id]}
          onClose={() => setAddToCollectionOpen(false)}
          onAdded={() => { setAddToCollectionOpen(false); onChanged() }}
        />
      )}

      {addItemsOpen && (
        <ItemPickerSheet
          existingItemIds={outfit.items.map(i => i.id)}
          onClose={() => setAddItemsOpen(false)}
          onAdd={async (newIds, newItems) => {
            const merged = [...outfit.items.map(i => i.id), ...newIds]
            const updated = await updateOutfitItems(outfit.id, merged)
            setOutfit(o => ({ ...o, ...updated, items: [...o.items, ...newItems] }))
            onChanged()
          }}
        />
      )}

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
          onChanged={() => setSelectedItem(null)}
        />
      )}
    </>
  )
}
