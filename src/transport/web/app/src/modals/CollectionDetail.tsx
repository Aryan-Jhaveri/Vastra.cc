import { useState, useRef, useEffect } from 'react'
import { ArrowLeft, Plus, X, Trash2, ImagePlus } from 'lucide-react'
import { AuthImage } from '../components/AuthImage'
import {
  fetchCollection, updateCollection, uploadCollectionCover, removeCollectionCover,
  deleteCollection, removeOutfitFromCollection,
} from '../api/collections'
import { usePasteImage } from '../lib/usePasteImage'
import { useMountAnimation } from '../lib/animations'
import type { HydratedCollection } from '../api/collections'
import { SavedOutfitCard } from '../components/SavedOutfitCard'
import { OutfitDetail } from './OutfitDetail'
import { CollectionRelated } from '../components/related/CollectionRelated'
import { useRelatedEnabled } from '../hooks/useRelatedEnabled'
import { OutfitPickerSheet } from './OutfitPickerSheet'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'
import { TagEditor } from '../components/ui/TagEditor'
import { InlineField } from '../components/ui/InlineField'
import type { HydratedOutfit } from '../api/outfits'

interface CollectionDetailProps {
  collectionId: string
  onClose: () => void
  onChanged: () => void
}

export function CollectionDetail({ collectionId, onClose, onChanged }: CollectionDetailProps) {
  const [collection, setCollection] = useState<HydratedCollection | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploadingCover, setUploadingCover] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [selectedTag, setSelectedTag] = useState('')
  const [outfitDetail, setOutfitDetail] = useState<HydratedOutfit | null>(null)
  const relatedEnabled = useRelatedEnabled()
  const [addSheetOpen, setAddSheetOpen] = useState(false)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const modalBackdropRef = useRef<HTMLDivElement>(null)
  const modalPanelRef = useRef<HTMLDivElement>(null)
  useMountAnimation(modalBackdropRef, [{ opacity: '0' }, { opacity: '1' }])
  useMountAnimation(modalPanelRef, [
    { opacity: '0', transform: 'scale(0.96) translateY(12px)' },
    { opacity: '1', transform: 'scale(1) translateY(0)' },
  ])

  async function load() {
    try {
      const col = await fetchCollection(collectionId)
      setCollection(col)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [collectionId])


  async function doUploadCover(file: File) {
    if (!collection) return
    setUploadingCover(true)
    try {
      const updated = await uploadCollectionCover(collection.id, file)
      setCollection(c => c ? { ...c, ...updated } : c)
      onChanged()
    } catch (err) { setError(String(err)) }
    finally { setUploadingCover(false) }
  }

  async function handleCoverUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await doUploadCover(file)
  }

  usePasteImage(files => void doUploadCover(files[0]), !!collection)

  async function handleRemoveCover() {
    if (!collection) return
    try {
      const updated = await removeCollectionCover(collection.id)
      setCollection(c => c ? { ...c, ...updated } : c)
      onChanged()
    } catch (err) { setError(String(err)) }
  }

  async function handleRemoveOutfit(outfitId: string) {
    if (!collection) return
    try {
      await removeOutfitFromCollection(collection.id, outfitId)
      setCollection(c => c ? { ...c, outfits: c.outfits.filter(o => o.id !== outfitId) } : c)
      onChanged()
    } catch (err) { setError(String(err)) }
  }

  async function handleDelete() {
    if (!collection) return
    setDeleting(true)
    try {
      await deleteCollection(collection.id)
      onClose()
      onChanged()
    } catch (err) { setError(String(err)); setDeleting(false) }
  }

  if (loading) {
    return (
      <div className="fixed inset-0 nav-anchor-right z-50 flex items-center justify-center bg-black/50">
        <Spinner />
      </div>
    )
  }

  if (!collection) return null

  return (
    <>
      <div ref={modalBackdropRef} className="fixed inset-0 nav-anchor-right z-50 flex justify-center bg-black/50" onClick={onClose}>
        <div ref={modalPanelRef} className="bg-paper border-x-2 border-ink w-full max-w-lg flex flex-col h-full overflow-hidden" onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b-2 border-ink flex-none">
            <button onClick={onClose} className="text-ink hover:text-muted flex items-center justify-center" aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
            <span className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">Collection</span>
            <div className="w-8" />
          </div>

          <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto">
            {error && (
              <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[13px] font-mono uppercase tracking-[0.06em] rounded-base">{error}</div>
            )}

            {/* Cover photo */}
            <div>
              <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Cover Photo</p>
              {collection.coverImageUri ? (
                <div className="relative overflow-hidden border-2 border-ink rounded-base">
                  <AuthImage src={`/${collection.coverImageUri}`} alt="Cover" className="w-full h-auto max-h-[40vh] object-contain block" />
                  <div className="absolute bottom-2 right-2 flex gap-1.5">
                    <button onClick={handleRemoveCover} className="flex items-center gap-1 border-2 border-error bg-paper text-error px-2 py-1 text-[11px] font-bold font-mono uppercase tracking-[0.06em] shadow-flat-xs active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base">
                      <Trash2 className="w-3 h-3 shrink-0" strokeWidth={2} /><span className="leading-none">Remove</span>
                    </button>
                    <label className="cursor-pointer flex items-center gap-1 border-2 border-ink bg-paper text-ink px-2 py-1 text-[11px] font-bold font-mono uppercase tracking-[0.06em] shadow-flat-xs active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base">
                      <ImagePlus className="w-3 h-3 shrink-0" strokeWidth={2} /><span className="leading-none">{uploadingCover ? '…' : 'Change'}</span>
                      <input ref={coverInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleCoverUpload} />
                    </label>
                  </div>
                </div>
              ) : (
                <label className="flex items-center gap-3 border-2 border-dashed border-outline p-3 cursor-pointer hover:border-ink transition-colors">
                  {uploadingCover ? <Spinner size={20} /> : <div className="w-8 h-8 border-2 border-outline flex items-center justify-center text-muted"><Plus className="w-5 h-5" strokeWidth={2.5} /></div>}
                  <p className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">{uploadingCover ? 'Uploading…' : 'Add Cover Photo'}</p>
                  <input ref={coverInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleCoverUpload} />
                </label>
              )}
            </div>

            <InlineField
              label="Name"
              value={collection.name}
              onSave={async next => {
                const name = next.trim()
                if (!name || name === collection.name) return
                const updated = await updateCollection(collection.id, { name })
                setCollection(c => c ? { ...c, ...updated } : c)
                onChanged()
              }}
              maxLength={100}
              valueClassName="text-base font-bold font-mono"
            />

            {/* Tags */}
            <div>
              <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Tags</p>
              <TagEditor
                created
                tags={(() => { try { return JSON.parse(collection.tags || '[]') } catch { return [] } })()}
                onChange={async (next) => {
                  try {
                    const updated = await updateCollection(collection.id, { tags: next })
                    setCollection(c => c ? { ...c, ...updated } : c)
                    onChanged()
                  } catch (err) { setError(String(err)) }
                }}
              />
            </div>

            {/* Outfits grid */}
            <div>
              <div className="flex items-center justify-between border-b-2 border-ink pb-1.5 mb-2">
                <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em]">
                  Outfits ({collection.outfits.length})
                </p>
                <button
                  onClick={() => setAddSheetOpen(true)}
                  className="text-[11px] font-bold font-sans uppercase tracking-[0.06em] border-2 border-ink px-2 py-0.5 hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] flex items-center gap-1 rounded-base"
                >
                  <Plus className="w-3 h-3" strokeWidth={2.5} /> Add
                </button>
              </div>

              {/* Tag filter chips */}
              {(() => {
                const allTags = [...new Set(collection.outfits.flatMap(o => {
                  try { return JSON.parse(o.tags || '[]') as string[] } catch { return [] }
                }))].sort()
                if (allTags.length === 0) return null
                return (
                  <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-hide">
                    <button
                      onClick={() => setSelectedTag('')}
                      className={`shrink-0 px-3 py-1 text-[12px] font-bold font-sans uppercase tracking-[0.08em] border-2 border-ink shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base ${
                        selectedTag === '' ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
                      }`}
                    >
                      All
                    </button>
                    {allTags.map(tag => (
                      <button
                        key={tag}
                        onClick={() => setSelectedTag(t => t === tag ? '' : tag)}
                        className={`shrink-0 px-3 py-1 text-[12px] font-bold font-sans uppercase tracking-[0.08em] border-2 border-ink shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] capitalize rounded-base ${
                          selectedTag === tag ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
                        }`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )
              })()}

              {collection.outfits.length === 0 ? (
                <p className="text-[13px] font-mono text-muted uppercase tracking-[0.06em] py-4 text-center">
                  No outfits yet. Tap <Plus className="w-3 h-3" strokeWidth={2.5} /> Add to get started.
                </p>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {collection.outfits
                    .filter(o => {
                      if (!selectedTag) return true
                      try { return (JSON.parse(o.tags || '[]') as string[]).includes(selectedTag) } catch { return false }
                    })
                    .map(outfit => (
                      <div key={outfit.id} className="relative">
                        <SavedOutfitCard outfit={outfit} onClick={() => setOutfitDetail(outfit)} />
                        <button
                          onClick={() => void handleRemoveOutfit(outfit.id)}
                          className="absolute top-1 right-1 w-5 h-5 bg-accent text-accent-on flex items-center justify-center hover:bg-active z-10"
                          title="Remove from collection"
                        >
                          <X className="w-3 h-3" strokeWidth={2.5} />
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>

            {relatedEnabled && (
              <CollectionRelated collectionId={collectionId} onOpenOutfit={setOutfitDetail} onAdded={() => { void load(); onChanged() }} />
            )}

            {/* Delete */}
            <div className="flex flex-col gap-2 border-t-2 border-ink pt-3">
              {confirmDelete ? (
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => setConfirmDelete(false)} className="flex-1">Keep it</Button>
                  <Button variant="secondary" onClick={handleDelete} loading={deleting} className="flex-1 !border-error !text-error hover:!bg-error-container">Delete</Button>
                </div>
              ) : (
                <button onClick={() => setConfirmDelete(true)} className="w-full text-[12px] font-mono text-muted uppercase tracking-[0.08em] py-2 hover:text-ink">
                  Delete Collection
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {outfitDetail && (
        <OutfitDetail
          outfit={outfitDetail}
          onClose={() => setOutfitDetail(null)}
          onChanged={() => void load()}
        />
      )}

      {addSheetOpen && (
        <OutfitPickerSheet
          collectionId={collection.id}
          existingOutfitIds={collection.outfits.map(o => o.id)}
          onClose={() => setAddSheetOpen(false)}
          onAdded={() => { void load(); onChanged() }}
        />
      )}
    </>
  )
}
