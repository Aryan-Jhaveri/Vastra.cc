import { useEffect, useRef, useState } from 'react'
import { Plus, Sparkles, Trash2 } from 'lucide-react'
import { AuthImage } from '../components/AuthImage'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'
import { MakePrettySheet } from '../components/MakePrettySheet'
import {
  fetchItemImages,
  uploadItemImage,
  deleteItemImage,
  setItemImagePrimary,
  type ItemImage,
} from '../api/items'

export interface ExtrasItem {
  id: string
  imageUri: string
  label: string
}

interface AddRelatedViewsStepProps {
  items: ExtrasItem[]
  onDone: () => void
}

const MAX_VIEWS = 4

export function AddRelatedViewsStep({ items, onDone }: AddRelatedViewsStepProps) {
  const [byItem, setByItem] = useState<Record<string, ItemImage[]>>({})
  const [primaryUri, setPrimaryUri] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map(i => [i.id, i.imageUri])),
  )
  const [uploadingId, setUploadingId] = useState<string | null>(null)
  const [makePrettyId, setMakePrettyId] = useState<string | null>(null)
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      const entries = await Promise.all(
        items.map(async i => [i.id, await fetchItemImages(i.id).catch(() => [])] as const),
      )
      if (!cancelled) setByItem(Object.fromEntries(entries))
    }
    void load()
    return () => { cancelled = true }
  }, [items])

  function visibleViews(itemId: string): ItemImage[] {
    return (byItem[itemId] ?? []).filter(img => img.role !== 'source')
  }

  async function handleAdd(itemId: string, file: File) {
    setUploadingId(itemId)
    try {
      const img = await uploadItemImage(itemId, file)
      setByItem(prev => ({ ...prev, [itemId]: [...(prev[itemId] ?? []), img] }))
    } finally {
      setUploadingId(null)
    }
  }

  async function handleDelete(itemId: string, imgId: string) {
    try {
      await deleteItemImage(itemId, imgId)
      setByItem(prev => ({ ...prev, [itemId]: (prev[itemId] ?? []).filter(i => i.id !== imgId) }))
    } catch { /* surface in console */ }
  }

  async function handleSetPrimary(itemId: string, img: ItemImage) {
    try {
      await setItemImagePrimary(itemId, img.id)
      setByItem(prev => ({
        ...prev,
        [itemId]: (prev[itemId] ?? []).map(i => ({ ...i, isPrimary: i.id === img.id ? 1 : 0 })),
      }))
      setPrimaryUri(prev => ({ ...prev, [itemId]: img.imageUri }))
    } catch { /* surface in console */ }
  }

  const activeMakePrettyItem = makePrettyId ? items.find(i => i.id === makePrettyId) : null

  function refreshItemImages(itemId: string) {
    void fetchItemImages(itemId).then(imgs =>
      setByItem(prev => ({ ...prev, [itemId]: imgs })),
    )
  }

  return (
    <div className="flex flex-col gap-3 p-4 flex-1 overflow-y-auto">
      <div className="border-2 border-ink p-3 bg-surface-dim rounded-base">
        <p className="text-[13px] font-bold font-sans uppercase tracking-widest text-ink">polish (optional)</p>
        <p className="text-[12px] font-mono text-muted leading-relaxed mt-0.5">
          Add extra views or generate a cover photo. You can always do this later from each item.
        </p>
      </div>

      {items.map(item => {
        const views = visibleViews(item.id)
        const canAdd = views.length < MAX_VIEWS
        const activeUri = primaryUri[item.id] ?? item.imageUri
        return (
          <div key={item.id} className="border-2 border-ink bg-paper rounded-base">
            <div className="flex gap-3 p-3">
              <div className="w-20 h-20 shrink-0 border border-outline-variant bg-surface-dim overflow-hidden flex items-center justify-center">
                <AuthImage src={`/${activeUri}`} alt={item.label} className="w-full h-full object-contain" />
              </div>
              <div className="flex flex-col flex-1 gap-2 min-w-0">
                <p className="text-[13px] font-mono uppercase tracking-[0.08em] truncate">{item.label}</p>
                <div className="flex gap-1.5 overflow-x-auto">
                  {views.map(img => (
                    <div
                      key={img.id}
                      className={`relative flex-none w-12 h-12 border-2 bg-surface-dim cursor-pointer overflow-hidden rounded-base ${activeUri === img.imageUri ? 'border-ink' : 'border-outline-variant'}`}
                      onClick={() => void handleSetPrimary(item.id, img)}
                    >
                      <AuthImage src={`/${img.imageUri}`} alt="" className="w-full h-full object-contain" />
                      {img.role === 'generated' && (
                          <span className="absolute top-0 right-0 bg-ink text-accent-on text-[11px] font-mono px-0.5 uppercase">AI</span>
                      )}
                      {views.length > 1 && (
                        <button
                          onClick={e => { e.stopPropagation(); void handleDelete(item.id, img.id) }}
                          className="absolute bottom-0 right-0 bg-ink/40 hover:bg-ink/70 text-white p-0.5"
                          aria-label="Delete view"
                        >
                          <Trash2 className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </div>
                  ))}
                  {canAdd && (
                    <button
                      onClick={() => fileInputs.current[item.id]?.click()}
                      disabled={uploadingId === item.id}
                      className="flex-none w-12 h-12 border-2 border-dashed border-outline bg-surface-dim flex items-center justify-center text-muted hover:border-ink hover:text-ink transition-colors disabled:opacity-50"
                      aria-label="Add view"
                    >
                      {uploadingId === item.id ? <Spinner size={12} /> : <Plus className="w-4 h-4" />}
                    </button>
                  )}
                  <input
                    ref={el => { fileInputs.current[item.id] = el }}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={e => { if (e.target.files?.[0]) void handleAdd(item.id, e.target.files[0]) }}
                  />
                </div>
              </div>
            </div>
            <div className="border-t-2 border-ink px-3 py-2">
              <button
                onClick={() => setMakePrettyId(item.id)}
                className="w-full flex items-center justify-center gap-2 bg-surface-dim hover:bg-surface px-3 py-2 text-[12px] font-sans uppercase tracking-[0.08em] transition-colors"
              >
                <Sparkles className="w-3 h-3" />
                Generate Cover Photo
              </button>
            </div>
          </div>
        )
      })}

      <div className="flex flex-col gap-2 mt-2 sticky bottom-0 bg-paper border-t-2 border-ink pt-3 pb-4 rounded-base">
        <Button className="w-full" onClick={onDone}>Done</Button>
      </div>

      {activeMakePrettyItem && (
        <MakePrettySheet
          itemId={activeMakePrettyItem.id}
          imageUri={primaryUri[activeMakePrettyItem.id] ?? activeMakePrettyItem.imageUri}
          label={activeMakePrettyItem.label}
          open={true}
          onClose={() => setMakePrettyId(null)}
          onUsed={newUri => {
            setPrimaryUri(prev => ({ ...prev, [activeMakePrettyItem.id]: newUri }))
            refreshItemImages(activeMakePrettyItem.id)
          }}
          onGenerated={() => refreshItemImages(activeMakePrettyItem.id)}
        />
      )}
    </div>
  )
}
