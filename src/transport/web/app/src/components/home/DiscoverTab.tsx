import { useState, useRef, useEffect, useCallback } from 'react'
import { track } from '../../lib/analytics'
import { useLocation as useRouterLocation, useNavigate } from 'react-router'
import { ImageIcon, Link2, X } from 'lucide-react'
import { usePasteImage } from '../../lib/usePasteImage'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { SharePreviewCard } from '../SharePreviewCard'
import { PhasedSuggestionLayout } from './PhasedSuggestionLayout'
import { OutfitDetail } from '../../modals/OutfitDetail'
import { useDiscoverStream } from '../../hooks/useDiscoverStream'
import { createOutfit } from '../../api/outfits'
import { getShare } from '../../api/share'
import type { HydratedOutfit, OutfitSuggestion } from '../../api/outfits'
import type { SharePayload } from '../../api/share'

interface LocationData {
  lat: number
  lon: number
  name: string
}

interface Props {
  location: LocationData | null
}

// #370: the text prompt mode was removed; Image and Link remain. The backend
// still accepts mode 'prompt' (weather mode records itself under it).
type DiscoverMode = 'image' | 'shared'

export function DiscoverTab({ location }: Props) {
  const routerLocation = useRouterLocation()
  const navigate = useNavigate()
  const [mode, setMode] = useState<DiscoverMode>('image')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [imageBase64, setImageBase64] = useState<string | null>(null)
  const [shareIdInput, setShareIdInput] = useState('')
  const [sharePreview, setSharePreview] = useState<SharePayload | null>(null)
  const [sharePreviewLoading, setSharePreviewLoading] = useState(false)
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [savingId, setSavingId] = useState<string | null>(null)
  const [outfitDetail, setOutfitDetail] = useState<HydratedOutfit | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const stream = useDiscoverStream('discover')
  const { phase, error, submit, clear, reshuffleItems, reshuffleOutfits } = stream

  useEffect(() => {
    track('discover_opened')
  }, [])

  // Auto-fire if ?share=<id> is in the URL
  useEffect(() => {
    const search = new URLSearchParams(routerLocation.search)
    const shareId = search.get('share') ?? localStorage.getItem('closet-pending-share')
    if (!shareId) return

    localStorage.removeItem('closet-pending-share')
    navigate({ hash: 'discover' }, { replace: true })

    setMode('shared')
    setShareIdInput(shareId)

    setSharePreviewLoading(true)
    getShare(shareId)
      .then(p => { setSharePreview(p); autoSubmitShare(shareId) })
      .catch(() => autoSubmitShare(shareId))
      .finally(() => setSharePreviewLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Pre-load a shared image from the PWA share-target inbox (#134) into Image mode.
  // Distinct from the `?share` (Vastra link) handler above: this is a raw image,
  // and we do NOT auto-submit — the user presses Generate (transparency).
  useEffect(() => {
    const search = new URLSearchParams(routerLocation.search)
    const inboxId = search.get('inboxId')
    if (!inboxId) return

    navigate({ hash: 'discover' }, { replace: true })
    setMode('image')

    void (async () => {
      try {
        const payload = await getShare(inboxId)
        const uri = payload.imageUris[0]
        if (!uri) return
        // Same-origin fetch — the closet-auth cookie authenticates it.
        const res = await fetch('/' + uri)
        if (!res.ok) return
        const blob = await res.blob()
        const file = new File([blob], 'shared.jpg', { type: blob.type || 'image/jpeg' })
        applyImageFile(file)
      } catch { /* shared image unavailable — ignore */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function autoSubmitShare(shareId: string) {
    submit('shared', { shareId, coords: location ? { lat: location.lat, lon: location.lon } : undefined }).catch(() => {})
  }

  function handleModeChange(next: DiscoverMode) {
    if (next === mode) return
    setMode(next)
    clear()
    setImageFile(null)
    setImagePreview(null)
    setImageBase64(null)
    setShareIdInput('')
    setSharePreview(null)
  }

  function handleImageChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    applyImageFile(file)
    e.target.value = ''
  }

  function applyImageFile(file: File) {
    setImageFile(file)
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string
      setImagePreview(dataUrl)
      setImageBase64(dataUrl.split(',')[1] ?? null)
    }
    reader.readAsDataURL(file)
  }

  usePasteImage(files => applyImageFile(files[0]), mode === 'image')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    clear()
    const coords = location ? { lat: location.lat, lon: location.lon } : undefined

    if (mode === 'image') {
      if (!imageFile) return
      await submit('image', { imageFile, coords }).catch(() => {})
    } else {
      const id = shareIdInput.trim()
      if (!id) return
      const match = id.match(/\/share\/([a-zA-Z0-9_-]+)$/) ?? id.match(/^([a-zA-Z0-9_-]{6,24})$/)
      const shareId = match ? (match[1] ?? id) : id
      if (!sharePreview) {
        setSharePreviewLoading(true)
        getShare(shareId)
          .then(p => setSharePreview(p))
          .catch(() => {})
          .finally(() => setSharePreviewLoading(false))
      }
      await submit('shared', { shareId, coords }).catch(() => {})
    }
  }

  async function handleSave(suggestion: OutfitSuggestion) {
    setSavingId(suggestion.name)
    try {
      await createOutfit({
        name: suggestion.name,
        itemIds: suggestion.item_ids,
        occasion: suggestion.occasion,
        aiGenerated: true,
      })
      track('discover_result_saved')
      setSavedIds(prev => new Set([...prev, suggestion.name]))
    } finally {
      setSavingId(null)
    }
  }

  function handleView(suggestion: OutfitSuggestion) {
    setOutfitDetail({
      id: '',
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
    const coords = location ? { lat: location.lat, lon: location.lon } : undefined
    if (mode === 'image' && imageFile) submit('image', { imageFile, coords, isRegenerate: true }).catch(() => {})
    // shared mode has no regenerate affordance (free + auto-triggered)
  }

  function resubmitWithExcludes(excludeIds: { items?: string[]; outfits?: string[] }) {
    const coords = location ? { lat: location.lat, lon: location.lon } : undefined
    if (mode === 'image') {
      if (imageFile) submit('image', { imageFile, coords, excludeIds }).catch(() => {})
    } else {
      submit('shared', { shareId: shareIdInput.trim(), coords, excludeIds }).catch(() => {})
    }
  }

  function handleReshuffleItems() {
    const result = reshuffleItems()
    if (result?.exhausted && result.excludeIds) {
      resubmitWithExcludes(result.excludeIds)
    }
    return result
  }

  function handleReshuffleOutfits() {
    const result = reshuffleOutfits()
    if (result?.exhausted && result.excludeIds) {
      resubmitWithExcludes(result.excludeIds)
    }
    return result
  }

  const canSubmit = mode === 'image' ? imageBase64 !== null : shareIdInput.trim().length > 0

  const isActive = phase === 'shortlisting' || phase === 'generating'

  const modes = [
    { id: 'image' as const, label: 'Image', Icon: ImageIcon },
    { id: 'shared' as const, label: 'Link', Icon: Link2 },
  ]

  return (
    <div className="flex flex-col gap-4">
      {/* Mode segmented control */}
      <div className="flex border-2 border-ink">
        {modes.map(({ id, label, Icon }, i) => (
          <button
            key={id}
            type="button"
            aria-pressed={mode === id}
            onClick={() => handleModeChange(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[14px] font-bold font-mono uppercase tracking-[0.1em] transition-colors ${
              mode === id ? 'bg-accent text-accent-on' : 'text-ink hover:bg-surface-dim'
            } ${i > 0 ? 'border-l-2 border-ink' : ''}`}
          >
            <Icon className="w-3 h-3" />
            {label}
          </button>
        ))}
      </div>

      {/* Input area */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {mode === 'image' && (
          <div className="flex flex-col gap-2">
            {imagePreview ? (
              <div className="relative border-2 border-ink overflow-hidden">
                <img src={imagePreview} alt="inspiration" className="w-full max-h-48 object-contain bg-surface-dim" />
                <button
                  type="button"
                  onClick={() => { setImageFile(null); setImagePreview(null); setImageBase64(null) }}
                  className="absolute top-1.5 right-1.5 bg-paper border-2 border-ink w-6 h-6 flex items-center justify-center hover:bg-surface-dim"
                >
                  <X className="w-3 h-3" strokeWidth={2.5} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-outline-variant py-8 flex flex-col items-center gap-2 text-muted hover:border-ink hover:text-ink transition-colors"
              >
                <ImageIcon className="w-6 h-6" strokeWidth={1.5} />
                <span className="text-[14px] font-mono uppercase tracking-[0.06em]">
                  Drop an inspiration image or tap to pick
                </span>
              </button>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handleImageChange} className="hidden" />
            {imageFile && (
              <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">{imageFile.name}</span>
            )}
          </div>
        )}

        {mode === 'shared' && (
          <div className="flex flex-col gap-2">
            <input
              value={shareIdInput}
              onChange={e => setShareIdInput(e.target.value)}
              placeholder="Paste a Vastra share link or ID"
              className="w-full border-2 border-ink px-3 py-2 text-sm font-mono outline-none focus:bg-surface-dim bg-paper text-ink"
            />
            {sharePreviewLoading && (
              <div className="flex items-center gap-2">
                <Spinner />
                <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">Loading share…</span>
              </div>
            )}
            {sharePreview && <SharePreviewCard payload={sharePreview} />}
          </div>
        )}

        <Button
          type="submit"
          variant="primary"
          loading={isActive}
          disabled={!canSubmit || isActive}
          className="self-start"
        >
          Find outfits in my closet
        </Button>
      </form>

      {/* Error */}
      {error && (
        <p className="text-[14px] font-mono text-error uppercase tracking-[0.06em]">{error}</p>
      )}

      {/* Phased results (visible when not idle) */}
      {phase !== 'idle' && (
        <PhasedSuggestionLayout
          stream={stream}
          onReshuffleItems={handleReshuffleItems}
          onReshuffleOutfits={handleReshuffleOutfits}
          onOutfitClick={setOutfitDetail}
          onSave={handleSave}
          onView={handleView}
          onRegenerate={mode === 'shared' ? undefined : handleRegenerate}
          savingId={savingId}
          savedIds={savedIds}
        />
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
