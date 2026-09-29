import { useState, useEffect, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft, Pencil, Plus, X, ImagePlus, Trash2 } from 'lucide-react'
import { track } from '../lib/analytics'
import { deleteItem, updateItem, scanTag, replaceItemImage, fetchItem, fetchItemImages, uploadItemImage, deleteItemImage, setItemImagePrimary } from '../api/items'
import { usePasteImage } from '../lib/usePasteImage'
import { useMountAnimation } from '../lib/animations'
import { normalizeColor } from '../lib/normalizeColor'
import type { Item, ItemImage } from '../api/items'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'
import { ChipToggle } from '../components/ui/ChipToggle'
import { InlineField } from '../components/ui/InlineField'
import { TagEditor, REMOVE_BUTTON } from '../components/ui/TagEditor'
import { CreatedFacets } from '../components/ui/CreatedFacets'
import { AuthImage } from '../components/AuthImage'
import { MakePrettySheet } from '../components/MakePrettySheet'
import { ShareButton } from '../components/ShareButton'
import { ItemRelated } from '../components/related/ItemRelated'
import { ItemShopSection } from '../components/related/ItemShopSection'
import { useShopEnabled } from '../hooks/useShopEnabled'
import { useRelatedEnabled } from '../hooks/useRelatedEnabled'
import { OCCASIONS } from '../constants/occasions'

const PRESET_COLORS = [
  'black', 'white', 'gray', 'charcoal', 'cream', 'beige', 'ivory', 'off-white',
  'brown', 'tan', 'camel', 'khaki',
]

interface ItemDetailProps {
  item: Item
  onClose: () => void
  onChanged: () => void
}

function parseJSON<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

const SEASONS = ['spring', 'summer', 'fall', 'winter', 'all']

export function ItemDetail({ item: initialItem, onClose, onChanged }: ItemDetailProps) {
  const navigate = useNavigate()
  const [item, setItem] = useState<Item>(initialItem)
  const [scanningTag, setScanningTag] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showMakePretty, setShowMakePretty] = useState(false)
  const relatedEnabled = useRelatedEnabled()
  const shopEnabled = useShopEnabled()
  // #332 — a related item opened from this card stacks on top of it.
  const [relatedItem, setRelatedItem] = useState<Item | null>(null)
  const [replacingImage, setReplacingImage] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const [editingSeason, setEditingSeason] = useState(false)
  const [editingColor, setEditingColor] = useState(false)
  const [editingOccasion, setEditingOccasion] = useState(false)
  const [colorInput, setColorInput] = useState('')
  const [occasionInput, setOccasionInput] = useState('')
  const [careInput, setCareInput] = useState('')

  const [images, setImages] = useState<ItemImage[]>([])
  const [activeImageUri, setActiveImageUri] = useState(initialItem.imageUri)
  const [uploadingImage, setUploadingImage] = useState(false)
  const addImageRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchItemImages(initialItem.id).then(imgs => {
      setImages(imgs)
      const primary = imgs.find(i => i.isPrimary)
      if (primary) setActiveImageUri(primary.imageUri)
    }).catch(() => {})
  }, [initialItem.id])

  useEffect(() => {
    fetchItem(initialItem.id).then(full => setItem(full)).catch(() => {})
  }, [initialItem.id])

  useEffect(() => {
    track('item_opened', { itemId: item.id })
  }, [item.id])

  // Paste-from-clipboard adds a related view (iOS sticker workflow).
  usePasteImage(files => void handleAddImage(files[0]))

  async function handleAddImage(file: File) {
    setUploadingImage(true)
    try {
      const img = await uploadItemImage(item.id, file)
      setImages(prev => [...prev, img])
    } catch (err) { setError(String(err)) }
    finally { setUploadingImage(false) }
  }

  async function handleDeleteImage(imgId: string) {
    const img = images.find(i => i.id === imgId)
    if (!img) return
    try {
      await deleteItemImage(item.id, imgId)
      const updated = images.filter(i => i.id !== imgId)
      setImages(updated)
      if (activeImageUri === img.imageUri) {
        const primary = updated.find(i => i.isPrimary) ?? updated[0]
        if (primary) setActiveImageUri(primary.imageUri)
      }
    } catch (err) { setError(String(err)) }
  }

  async function handleSetPrimary(imgId: string) {
    try {
      await setItemImagePrimary(item.id, imgId)
      const img = images.find(i => i.id === imgId)
      if (img) {
        setImages(prev => prev.map(i => ({ ...i, isPrimary: i.id === imgId ? 1 : 0 })))
        setItem(prev => ({ ...prev, imageUri: img.imageUri }))
        setActiveImageUri(img.imageUri)
        onChanged()
      }
    } catch (err) { setError(String(err)) }
  }

  const currentSeasons = parseJSON<string[]>(item.season, [])
  const currentColors = parseJSON<string[]>(item.colors, [])
  const currentOccasions = parseJSON<string[]>(item.occasion, [])
  const currentTags = parseJSON<string[]>(item.tags, [])
  const currentCare = parseJSON<string[]>(item.careInstructions, [])

  const OCCASIONS_SET = useMemo(() => new Set(OCCASIONS.map(o => o.toLowerCase())), [])

  async function patchItem(patch: Partial<Item>) {
    try {
      const updated = await updateItem(item.id, patch)
      setItem(updated)
      track('item_edited', { itemId: item.id })
      onChanged()
    } catch (err) { setError(String(err)) }
  }

  async function addOccasion(raw: string) {
    const o = raw.trim().toLowerCase()
    if (!o || currentOccasions.includes(o)) { setOccasionInput(''); return }
    await patchItem({ occasion: [...currentOccasions, o] as unknown as string })
    setOccasionInput('')
  }

  async function removeOccasion(o: string) {
    await patchItem({ occasion: currentOccasions.filter(x => x !== o) as unknown as string })
  }

  async function addColor(raw: string) {
    const c = normalizeColor(raw)
    if (!c || currentColors.includes(c)) { setColorInput(''); return }
    await patchItem({ colors: [...currentColors, c] as unknown as string })
    setColorInput('')
  }

  async function removeColor(c: string) {
    await patchItem({ colors: currentColors.filter(x => x !== c) as unknown as string })
  }

  async function addCare(raw: string) {
    const c = raw.trim()
    if (!c || currentCare.includes(c)) { setCareInput(''); return }
    await patchItem({ careInstructions: [...currentCare, c] as unknown as string })
    setCareInput('')
  }

  async function removeCare(c: string) {
    await patchItem({ careInstructions: currentCare.filter(x => x !== c) as unknown as string })
  }

  async function handleDelete() {
    setDeleting(true)
    try { await deleteItem(item.id); track('item_deleted', { itemId: item.id }); onClose(); onChanged() }
    catch (err) { setError(String(err)); setDeleting(false) }
  }

  async function handleScanTag(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setScanningTag(true)
    setError(null)
    try {
      const { item: updated, tagData } = await scanTag(item.id, file)
      setItem(updated)
      const fieldsExtracted = Object.entries(tagData)
        .filter(([, v]) => Array.isArray(v) ? v.length > 0 : !!v)
        .map(([k]) => k)
      track('item_tag_scanned', { itemId: item.id, fieldsExtracted })
    } catch (err) {
      setError(String(err))
    } finally {
      setScanningTag(false)
    }
  }

  async function handleReplaceImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setReplacingImage(true)
    setError(null)
    try {
      const updated = await replaceItemImage(item.id, file)
      setItem(updated)
      setActiveImageUri(updated.imageUri)
      const imgs = await fetchItemImages(item.id)
      setImages(imgs)
      onChanged()
    } catch (err) {
      setError(String(err))
    } finally {
      setReplacingImage(false)
      e.target.value = ''
    }
  }

  const modalBackdropRef = useRef<HTMLDivElement>(null)
  const modalPanelRef = useRef<HTMLDivElement>(null)
  useMountAnimation(modalBackdropRef, [{ opacity: '0' }, { opacity: '1' }])
  useMountAnimation(modalPanelRef, [
    { opacity: '0', transform: 'scale(0.96) translateY(12px)' },
    { opacity: '1', transform: 'scale(1) translateY(0)' },
  ])

  return (
    <div ref={modalBackdropRef} className="fixed inset-0 nav-anchor-right z-50 flex justify-center bg-black/50" onClick={onClose}>
      <div ref={modalPanelRef} className="bg-paper border-x-2 border-ink w-full max-w-lg flex flex-col h-full overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b-2 border-ink flex-none">
          <button onClick={onClose} className="text-ink hover:text-muted flex items-center justify-center" aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
          <span className="text-[12px] font-bold font-mono uppercase tracking-[0.08em] capitalize">
            {item.subcategory ?? item.category}
          </span>
          <div className="w-8" />
        </div>

        <div className="flex flex-col gap-4 p-4 flex-1 overflow-y-auto min-w-0">
          {error && (
            <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[13px] font-mono uppercase tracking-[0.06em] rounded-base break-words">
              {error}
            </div>
          )}

          {/* Garment image + multi-view gallery */}
          <div className="flex flex-col gap-2">
            {(() => {
              // Strip shows every non-source image (including the cover), so the
              // user always has a tap-target to return to the cover after previewing.
              const stripImages = images.filter(img => img.role !== 'source')
              // Cap counted against non-cover views — the cover is implicit, doesn't count.
              const nonCoverViews = stripImages.filter(img => img.imageUri !== item.imageUri)
              const canAdd = nonCoverViews.length < 4
              const isCover = activeImageUri === item.imageUri
              const activeView = isCover ? null : images.find(i => i.imageUri === activeImageUri) ?? null
              return (
                <>
                  <div className="relative h-72 w-full shrink-0 border-2 border-ink bg-surface-dim overflow-hidden rounded-base">
                    <AuthImage
                      src={`/${activeImageUri}`}
                      alt={item.subcategory ?? item.category}
                      className="h-full w-full object-contain"
                    />
                    {replacingImage && (
                      <div className="absolute inset-0 bg-paper/60 flex items-center justify-center">
                        <Spinner size={28} />
                      </div>
                    )}
                    {isCover ? (
                      // Primary image — Change replaces it from gallery
                      <div className="absolute bottom-2 right-2">
                        <label className={`cursor-pointer flex items-center gap-1 border-2 border-ink bg-paper text-ink px-2 py-1 text-[11px] font-bold font-mono uppercase tracking-[0.06em] shadow-flat-xs active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base ${replacingImage ? 'opacity-50 pointer-events-none' : ''}`}>
                          <ImagePlus className="w-3 h-3 shrink-0" strokeWidth={2} /><span className="leading-none">{replacingImage ? '…' : 'Change'}</span>
                          <input ref={imageInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleReplaceImage} />
                        </label>
                      </div>
                    ) : activeView ? (
                      // Previewing a related view — promote-or-delete actions
                      <div className="absolute bottom-2 right-2 flex gap-1.5">
                        <button
                          onClick={() => handleSetPrimary(activeView.id)}
                          className="flex items-center gap-1 border-2 border-ink bg-paper text-ink px-2 py-1 text-[11px] font-bold font-mono uppercase tracking-[0.06em] shadow-flat-xs active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
                        >
                          Set as Cover
                        </button>
                        <button
                          onClick={async () => {
                            await handleDeleteImage(activeView.id)
                            setActiveImageUri(item.imageUri)
                          }}
                          className="flex items-center gap-1 border-2 border-error bg-paper text-error px-2 py-1 text-[11px] font-bold font-mono uppercase tracking-[0.06em] shadow-flat-xs active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
                        >
                          <Trash2 className="w-3 h-3 shrink-0" strokeWidth={2} /><span className="leading-none">Delete</span>
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {/* Strip — every image (cover + related views). Click previews
                      in the main viewport above. */}
                  <div className="flex gap-1.5 overflow-x-auto pb-1">
                    {stripImages.map(img => (
                      <button
                        key={img.id}
                        type="button"
                        onClick={() => setActiveImageUri(img.imageUri)}
                        className={`relative flex-none w-10 h-10 border-2 bg-surface-dim overflow-hidden ${activeImageUri === img.imageUri ? 'border-ink' : 'border-ink/30 hover:border-ink/60'} transition-colors`}
                        title={img.imageUri === item.imageUri ? 'Cover' : 'Related view'}
                      >
                        <AuthImage src={`/${img.imageUri}`} alt="" className="w-full h-full object-contain" />
                        {img.imageUri === item.imageUri && (
                          <span className="absolute bottom-0 left-0 bg-ink text-paper text-[11px] font-mono px-0.5 uppercase">Cover</span>
                        )}
                        {img.role === 'generated' && img.imageUri !== item.imageUri && (
                          <span className="absolute top-0 right-0 bg-ink text-paper text-[11px] font-mono px-0.5 uppercase">AI</span>
                        )}
                      </button>
                    ))}
                    {canAdd && (
                      <button
                        className="flex-none w-10 h-10 border-2 border-dashed border-ink/40 bg-surface-dim flex items-center justify-center text-ink/50 hover:border-ink hover:text-ink transition-colors disabled:opacity-50"
                        onClick={() => addImageRef.current?.click()}
                        disabled={uploadingImage}
                        title="Add a related view (or paste an image)"
                      >
                        {uploadingImage ? <Spinner size={12} /> : <Plus className="w-3 h-3" />}
                      </button>
                    )}
                    {nonCoverViews.length === 0 && !uploadingImage && (
                      <span className="text-[11px] font-mono text-muted self-center pl-1 tracking-[0.06em]">
                        add or paste related views
                      </span>
                    )}
                  </div>
                </>
              )
            })()}
            {/* File input lives outside the conditional so the ref is always valid */}
            <input
              ref={addImageRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) void handleAddImage(f)
                e.target.value = ''
              }}
            />
          </div>
          
          <InlineField
            label="Category"
            value={item.category}
            onSave={async (next) => {
              if (!next.trim() || next.trim() === item.category) return
              await patchItem({ category: next.trim() })
            }}
            placeholder="e.g. tops"
          />

          <InlineField
            label="Type"
            value={item.subcategory}
            onSave={async (next) => {
              if (next.trim() === (item.subcategory ?? '')) return
              await patchItem({ subcategory: next.trim() || null })
            }}
            placeholder="e.g. t-shirt"
          />

          {item.wearContext && (
            <div>
              <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Wear Note</p>
              <p className="text-[13px] font-mono text-muted italic">{item.wearContext}</p>
            </div>
          )}

          {/* Color */}
          <div>
            <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Color</p>
            {editingColor ? (
              <div className="flex flex-col gap-2">
                {currentColors.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {currentColors.map(c => (
                      <span key={c} className="flex items-center gap-1 border-2 border-ink px-2 py-0.5 text-[12px] font-mono uppercase tracking-[0.06em] rounded-base">
                        {c}
                        <button onClick={() => removeColor(c)} className="text-muted hover:text-ink flex items-center"><X className="w-3 h-3" strokeWidth={2.5} /></button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  value={colorInput}
                  onChange={e => setColorInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); void addColor(colorInput) } }}
                  onBlur={() => { if (colorInput.trim()) void addColor(colorInput) }}
                  placeholder="Add color, press Enter"
                  className="w-full border-2 border-ink px-3 py-1.5 text-[12px] font-mono outline-none focus:bg-surface-dim placeholder:text-muted placeholder:normal-case"
                />
                {PRESET_COLORS.filter(c => !currentColors.includes(c)).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {PRESET_COLORS.filter(c => !currentColors.includes(c)).map(c => (
                      <button key={c} onClick={() => void addColor(c)}
                        className="flex items-center gap-1 border border-dashed border-outline px-2 py-0.5 text-[11px] font-mono text-muted uppercase tracking-[0.04em] hover:border-ink hover:text-ink">
                        <Plus className="w-2.5 h-2.5 shrink-0" strokeWidth={2.5} />{c}
                      </button>
                    ))}
                  </div>
                )}
                <button onClick={() => setEditingColor(false)} className="text-[11px] font-mono text-muted uppercase tracking-[0.06em] hover:text-ink self-start">Done</button>
              </div>
            ) : (
              <button onClick={() => setEditingColor(true)} className="flex items-center gap-2 group">
                <span className="text-sm font-mono capitalize">
                  {currentColors.length > 0 ? currentColors.join(', ') : <span className="text-muted">—</span>}
                </span>
                <Pencil className="w-3 h-3 text-muted group-hover:text-ink" />
              </button>
            )}
          </div>

          <div>
            <InlineField
              label="Material"
              value={item.material}
              onSave={async (next) => {
                if (next.trim() === (item.material ?? '')) return
                await patchItem({ material: next.trim() || null })
              }}
              placeholder="e.g. cotton"
            />
            {item.materialSource === 'ocr' && (
              <p className="text-[11px] font-mono text-muted uppercase tracking-[0.06em] mt-1">from label</p>
            )}
          </div>

          <InlineField
            label="Brand"
            value={item.brand}
            onSave={async (next) => {
              if (next.trim() === (item.brand ?? '')) return
              await patchItem({ brand: next.trim() || null })
            }}
            placeholder="e.g. Nike"
          />

          <InlineField
            label="Size"
            value={item.size}
            onSave={async (next) => {
              if (next.trim() === (item.size ?? '')) return
              await patchItem({ size: next.trim() || null })
            }}
            placeholder="e.g. M"
          />

          {/* Season */}
          <div>
            <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Season</p>
            {editingSeason ? (
              <div>
                <ChipToggle
                  options={SEASONS}
                  selected={currentSeasons}
                  onChange={async (next) => {
                    try {
                      const updated = await updateItem(item.id, { season: next as unknown as string })
                      setItem(o => ({ ...o, ...updated }))
                      onChanged()
                    } catch (err) { setError(String(err)) }
                  }}
                />
                <button onClick={() => setEditingSeason(false)} className="mt-2 text-[11px] font-mono text-muted uppercase tracking-[0.06em] hover:text-ink">Done</button>
              </div>
            ) : (
              <button onClick={() => setEditingSeason(true)} className="flex items-center gap-2 group">
                <span className="text-sm font-mono capitalize">
                  {currentSeasons.length > 0 ? currentSeasons.join(', ') : <span className="text-muted">—</span>}
                </span>
                <Pencil className="w-3 h-3 text-muted group-hover:text-ink" />
              </button>
            )}
          </div>

          {/* Occasion */}
          <div>
            <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Occasion</p>
            {editingOccasion ? (
              <div className="flex flex-col gap-2">
                {currentOccasions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {currentOccasions.map(o => (
                      <span key={o} className="flex items-center gap-1 border-2 border-ink px-2 py-0.5 text-[12px] font-mono uppercase tracking-[0.06em] rounded-base">
                        {o}
                        <button type="button" aria-label={`Remove ${o}`} onMouseDown={e => e.preventDefault()} onClick={() => removeOccasion(o)} className={REMOVE_BUTTON}><X className="w-3 h-3" strokeWidth={2.5} /></button>
                      </span>
                    ))}
                  </div>
                )}
                <input
                  value={occasionInput}
                  onChange={e => setOccasionInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); void addOccasion(occasionInput) } }}
                  onBlur={() => { if (occasionInput.trim()) void addOccasion(occasionInput) }}
                  placeholder="Add occasion, press Enter"
                  className="w-full border-2 border-ink px-3 py-1.5 text-[12px] font-mono outline-none focus:bg-surface-dim placeholder:text-muted placeholder:normal-case"
                />
                {OCCASIONS.filter(o => !currentOccasions.includes(o)).length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {OCCASIONS.filter(o => !currentOccasions.includes(o)).map(o => (
                      <button key={o} onClick={() => void addOccasion(o)}
                        className="flex items-center gap-1 border border-dashed border-outline px-2 py-0.5 text-[11px] font-mono text-muted uppercase tracking-[0.04em] hover:border-ink hover:text-ink">
                        <Plus className="w-2.5 h-2.5 shrink-0" strokeWidth={2.5} />{o}
                      </button>
                    ))}
                  </div>
                )}
                <CreatedFacets
                  kind="occasion"
                  current={currentOccasions}
                  exclude={OCCASIONS_SET}
                  onAdd={o => void addOccasion(o)}
                  onDeleted={gone => {
                    // Removed on the server already; mirror it here.
                    setItem(prev => ({ ...prev, occasion: JSON.stringify(parseJSON<string[]>(prev.occasion, []).filter(o => !gone.includes(o))) }))
                    onChanged()
                  }}
                />
                <button onClick={() => setEditingOccasion(false)} className="text-[11px] font-mono text-muted uppercase tracking-[0.06em] hover:text-ink self-start">Done</button>
              </div>
            ) : (
              <button onClick={() => setEditingOccasion(true)} className="flex items-center gap-2 group">
                <span className="text-sm font-mono capitalize">
                  {currentOccasions.length > 0 ? currentOccasions.join(', ') : <span className="text-muted">—</span>}
                </span>
                <Pencil className="w-3 h-3 text-muted group-hover:text-ink" />
              </button>
            )}
          </div>

          {/* Tags */}
          <div>
            <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Tags</p>
            <TagEditor
              tags={currentTags}
              created
              onChange={async (next) => {
                try {
                  const updated = await updateItem(item.id, { tags: next as unknown as string })
                  setItem(updated)
                  onChanged()
                } catch (err) { setError(String(err)) }
              }}
            />
          </div>

          {/* Description */}
          <div>
            <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Description</p>
            <textarea
              rows={3}
              value={item.aiDescription ?? ''}
              onChange={e => setItem(prev => ({ ...prev, aiDescription: e.target.value }))}
              onBlur={async e => {
                const next = e.target.value.trim() || null
                if (next === (initialItem.aiDescription ?? null)) return
                await patchItem({ aiDescription: next as unknown as string })
              }}
              placeholder="Describe this item..."
              className="w-full border-2 border-ink px-3 py-2 text-[13px] font-mono resize-none outline-none focus:bg-surface-dim placeholder:text-muted placeholder:normal-case"
            />
          </div>

          {/* Care label photo */}
          <div>
            <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">
              Care Label
            </p>
            {item.tagImageUri ? (
              <div className="flex items-start gap-3">
                <div className="relative w-16 h-20 shrink-0 overflow-hidden border-2 border-ink rounded-base">
                  <AuthImage src={`/${item.tagImageUri}`} alt="Care label" className="absolute inset-0 h-full w-full object-contain" />
                </div>
                <div className="flex-1 flex flex-col gap-1">
                  <div className="flex flex-wrap gap-1">
                    <label className={`border border-outline px-2 py-0.5 text-[11px] font-mono text-muted uppercase tracking-[0.06em] cursor-pointer hover:border-ink hover:text-ink transition-colors ${scanningTag ? 'opacity-50 pointer-events-none' : ''}`}>
                      {scanningTag ? 'Scanning…' : 'Re-scan'}
                      <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleScanTag} disabled={scanningTag} />
                    </label>
                    <button
                      onClick={() => void patchItem({ tagImageUri: null as unknown as string })}
                      className="border border-outline px-2 py-0.5 text-[11px] font-mono text-muted uppercase tracking-[0.06em] hover:border-error hover:text-error transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <label className={`flex items-center gap-3 border-2 border-dashed border-outline p-3 cursor-pointer hover:border-ink transition-colors ${scanningTag ? 'opacity-50 pointer-events-none' : ''}`}>
                {scanningTag
                  ? <Spinner size={20} />
                  : <div className="w-8 h-8 border-2 border-outline flex items-center justify-center text-muted"><Plus className="w-5 h-5" strokeWidth={2.5} /></div>
                }
                <div>
                  <p className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">
                    {scanningTag ? 'Scanning label…' : 'Add Care Label Photo'}
                  </p>
                  <p className="text-[11px] font-mono text-muted mt-0.5">AI will extract material & care info</p>
                </div>
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={handleScanTag} disabled={scanningTag} />
              </label>
            )}
          </div>

          {/* Care instructions — always editable, even when a label image is set
              (so a bad/inapplicable scan doesn't lock the user out of edits) */}
          <div>
            <p className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] border-b-2 border-ink pb-1.5 mb-2">Care Instructions</p>
            {currentCare.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {currentCare.map((c, i) => (
                  <span key={i} className="flex items-center gap-1 border-2 border-ink px-2 py-0.5 text-[12px] font-mono tracking-[0.04em] rounded-base">
                    <span className="flex-1">{c}</span>
                    <button onClick={() => removeCare(c)} className="text-muted hover:text-ink flex items-center"><X className="w-3 h-3" strokeWidth={2.5} /></button>
                  </span>
                ))}
              </div>
            )}
            <input
              value={careInput}
              onChange={e => setCareInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void addCare(careInput) } }}
              onBlur={() => { if (careInput.trim()) void addCare(careInput) }}
              placeholder="Add instruction, press Enter"
              className="w-full border-2 border-ink px-3 py-1.5 text-[12px] font-mono outline-none focus:bg-surface-dim placeholder:text-muted placeholder:normal-case"
            />
          </div>

          {relatedEnabled && <ItemRelated anchor={item} onOpenItem={setRelatedItem} onChanged={onChanged} />}
          {shopEnabled && <ItemShopSection itemId={item.id} />}

          <div
            data-testid="itemdetail-actions"
            className="flex flex-col gap-2 border-t-2 border-ink pt-4 mt-2"
          >
            {(() => {
              const hasReferences = images.some(i => i.role !== 'generated')
              return (
                <div className="flex flex-col gap-0.5">
                  <button
                    onClick={() => setShowMakePretty(true)}
                    disabled={!hasReferences}
                    className="w-full border-2 border-ink bg-paper text-ink hover:bg-surface-dim px-3 py-2 text-[12px] font-bold font-mono uppercase tracking-[0.06em] shadow-flat-xs active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-paper"
                  >
                    Generate Thumbnail
                  </button>
                  {!hasReferences && (
                    <p className="text-[11px] font-mono text-muted uppercase tracking-[0.06em] text-center">
                      Add a photo first
                    </p>
                  )}
                </div>
              )
            })()}

            <ShareButton
              source="manual"
              sourceRef={item.id}
              description={[item.subcategory ?? item.category, item.brand, currentColors[0], item.material].filter(Boolean).join(' · ')}
              imageUris={[item.imageUri]}
              className="w-full justify-center"
            />

            <Button
              variant="primary"
              onClick={() => { onClose(); navigate('/tryon', { state: { itemId: item.id } }) }}
              className="w-full"
            >
              Try On
            </Button>

            {confirmDelete ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => setConfirmDelete(false)} className="flex-1 min-w-0">Keep it</Button>
                <Button variant="secondary" onClick={handleDelete} loading={deleting} className="flex-1 min-w-0 !border-error !text-error hover:!bg-error-container">Delete</Button>
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
      {relatedItem && (
        <ItemDetail item={relatedItem} onClose={() => setRelatedItem(null)} onChanged={onChanged} />
      )}
      <MakePrettySheet
        itemId={item.id}
        imageUri={activeImageUri}
        label={item.subcategory ?? item.category}
        open={showMakePretty}
        onClose={() => setShowMakePretty(false)}
        onUsed={(newUri) => {
          setActiveImageUri(newUri)
          setItem(prev => ({ ...prev, imageUri: newUri }))
          setImages(prev => prev.map(i => ({ ...i, isPrimary: i.imageUri === newUri ? 1 : 0 })))
          onChanged()
        }}
        onGenerated={() => {
          fetchItemImages(item.id).then(setImages).catch(() => {})
        }}
      />
    </div>
  )
}
