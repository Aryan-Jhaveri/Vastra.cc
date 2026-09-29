import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { track } from '../lib/analytics'
import { ChevronLeft, ChevronRight, ChevronDown, X, Trash2, ImagePlus, Plus } from 'lucide-react'
import { useLocation as useRouterLocation, useNavigate, useSearchParams } from 'react-router'
import { AuthImage } from '../components/AuthImage'
import { fetchUserPhotos, uploadUserPhoto, deleteUserPhoto } from '../api/userPhotos'
import { useItemCache } from '../context/ItemCacheContext'
import { generateTryOn, fetchTryonHistory, deleteTryonResult, uploadGarment, fetchWearSuggestions, linkTryonToOutfit } from '../api/tryon'
import type { WearSuggestion } from '../api/tryon'
import { WearSuggestionChips } from '../components/WearSuggestionChips'
import { fetchOutfitsHydrated, uploadOutfitCover } from '../api/outfits'
import { getShare } from '../api/share'
import type { UserPhoto } from '../api/userPhotos'
import type { Item } from '../api/items'
import type { HydratedOutfit } from '../api/outfits'
import type { TryonHistoryItem } from '../api/tryon'
import { PageHeader } from '../components/PageHeader'
import { Button } from '../components/ui/Button'
import { usePageReset } from '../context/PageResetContext'
import { Spinner } from '../components/ui/Spinner'
import { FilterBar } from '../components/FilterBar'
import { CARD_GRID, CARD_AUTO } from '../constants/grid'
import { ItemCard } from '../components/ItemCard'
import { ItemFilterControls, EMPTY_FILTER_STATE, applyItemFilters, isFilterActive } from '../components/ItemFilterControls'
import type { ItemFilterState } from '../components/ItemFilterControls'
import { ChipToggle } from '../components/ui/ChipToggle'
import { OverlayRemoveButton } from '../components/ui/OverlayRemoveButton'
import { TabFade } from '../components/TabFade'
import { StepFade } from '../components/StepFade'
import { SkeletonPhoto, SkeletonItemGrid, SkeletonOutfitList } from '../components/ui/Skeleton'
import { cropToAspectRatio } from '../lib/cropImage'
import { usePasteImage } from '../lib/usePasteImage'
import { OutfitBuilder } from '../modals/OutfitBuilder'
import { OutfitDetail } from '../modals/OutfitDetail'
import { ItemDetail } from '../modals/ItemDetail'
import { nanoid } from 'nanoid'
import { requestWalletRefresh } from '../lib/walletEvents'

type TryOnStep = 'pick-photo' | 'pick-items' | 'result'
type ItemsTab = 'items' | 'outfits' | 'upload'

interface GarmentUpload {
  localId: string
  previewUrl: string
  imageUri: string | null
  uploading: boolean
}

// Shared by the ITEMS / OUTFITS / UPLOAD tab panels so switching tabs keeps a
// stable height and the sticky Generate footer stays pinned to the bottom.
const SELECT_PANEL = 'min-h-[calc(100dvh_-_240px)] flex flex-col'

async function fetchCoverFile(uri: string): Promise<File> {
  const res = await fetch(`/${uri}`)
  if (!res.ok) throw new Error(`Failed to load cover image (${res.status})`)
  const blob = await res.blob()
  return new File([blob], 'cover.jpg', { type: blob.type || 'image/jpeg' })
}

export function TryOn() {
  const routerLocation = useRouterLocation()
  const routerState = routerLocation.state as { itemId?: string; outfitItemIds?: string[]; sourceOutfitId?: string } | null
  const sourceOutfitId = routerState?.sourceOutfitId
  // Items to pre-select when arriving from a detail modal: an outfit's items
  // ("Try On →" in OutfitDetail) or a single item (ItemDetail). Both paths
  // pre-select at first render and skip to pick-items when a photo exists (#356).
  const preselectIds: string[] = routerState?.outfitItemIds?.length
    ? routerState.outfitItemIds
    : routerState?.itemId ? [routerState.itemId] : []
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [step, setStep] = useState<TryOnStep>('pick-photo')

  // Photos
  const [photos, setPhotos] = useState<UserPhoto[]>([])
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null)
  const [loadingPhotos, setLoadingPhotos] = useState(true)
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [deletingPhotoId, setDeletingPhotoId] = useState<string | null>(null)

  // Items + outfits
  const { items, loading: loadingItems, refetch: refetchItems } = useItemCache()
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(
    () => new Set(preselectIds)
  )
  const [itemsTab, setItemsTab] = useState<ItemsTab>('items')
  const [outfits, setOutfits] = useState<HydratedOutfit[]>([])
  const [loadingOutfits, setLoadingOutfits] = useState(false)

  // Item filters (client-side, ITEMS tab only)
  const [itemFilters, setItemFilters] = useState<ItemFilterState>(EMPTY_FILTER_STATE)

  // Outfits filters
  const [outfitSearch, setOutfitSearch] = useState('')
  const [outfitOccasion, setOutfitOccasion] = useState('')
  const [outfitSeason, setOutfitSeason] = useState('')
  const [outfitTags, setOutfitTags] = useState<string[]>([])
  const [outfitTagsOpen, setOutfitTagsOpen] = useState(false)
  const [outfitAiOnly, setOutfitAiOnly] = useState(false)

  // Garments
  const [uploadedGarments, setUploadedGarments] = useState<GarmentUpload[]>([])

  // Result
  const [generating, setGenerating] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [resultUri, setResultUri] = useState<string | null>(null)
  const [resultTryonId, setResultTryonId] = useState<string | null>(null)
  const [userInstruction, setUserInstruction] = useState('')
  const [wearSuggestions, setWearSuggestions] = useState<WearSuggestion[]>([])
  const [error, setError] = useState<string | null>(null)

  // History
  const [history, setHistory] = useState<TryonHistoryItem[]>([])
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null)
  const [previewingHistoryUri, setPreviewingHistoryUri] = useState<string | null>(null)
  const [deletingHistoryId, setDeletingHistoryId] = useState<string | null>(null)
  const [historySelectMode, setHistorySelectMode] = useState(false)
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set())
  const [deletingSelectedHistory, setDeletingSelectedHistory] = useState(false)
  const [doneConfirming, setDoneConfirming] = useState(false)

  // Save-as-outfit
  const [showSaveModal, setShowSaveModal] = useState(false)
  const [savingOutfit, setSavingOutfit] = useState<string | null>(null)  // tryonId being saved
  const [saveCoverUri, setSaveCoverUri] = useState<string | null>(null)   // cover image for save modal
  const [savingItemIds, setSavingItemIds] = useState<string[]>([])
  const [savedOutfitIds, setSavedOutfitIds] = useState<Record<string, string>>({})  // tryonId → outfitId
  const [coverUploadError, setCoverUploadError] = useState<{ tryonId: string; outfitId: string; coverUri: string; message: string } | null>(null)
  const [showEditOutfit, setShowEditOutfit] = useState<HydratedOutfit | null>(null)
  const [showItemDetail, setShowItemDetail] = useState<Item | null>(null)

  const [resultItemsCollapsed, setResultItemsCollapsed] = useState(false)
  const [historyItemsCollapsed, setHistoryItemsCollapsed] = useState(false)

  const { resetKeys } = usePageReset()
  const tryonResetKey = resetKeys.tryon
  const initialResetKey = useRef(tryonResetKey)
  const resetAllState = useCallback(() => {
    setStep('pick-photo')
    setItemsTab('items')
    setSelectedItemIds(new Set())
    setItemFilters(EMPTY_FILTER_STATE)
    setUserInstruction('')
    setWearSuggestions([])
    setError(null)
    setResultUri(null)
    setResultTryonId(null)
    setShowSaveModal(false)
    setCoverUploadError(null)
    setShowEditOutfit(null)
    setShowItemDetail(null)
    setResultItemsCollapsed(false)
    setHistorySelectMode(false)
    setSelectedHistoryIds(new Set())
    setSelectedHistoryId(null)
    setPreviewingHistoryUri(null)
  }, [])
  useEffect(() => {
    if (tryonResetKey === initialResetKey.current) return
    resetAllState()
  }, [tryonResetKey, resetAllState])

  // "Try On" from an Item/OutfitDetail opened inside this page (e.g. View outfit)
  // navigates to /tryon while already on it: no remount, so the mount-time
  // initialisers above never see the new outfit and the previous selection
  // and result stay on screen. Re-apply the router state on each new entry.
  const mountLocationKey = useRef(routerLocation.key)
  useEffect(() => {
    if (routerLocation.key === mountLocationKey.current) return
    if (!preselectIds.length) return
    resetAllState()
    setUploadedGarments([])
    setSelectedItemIds(new Set(preselectIds))
    if (photos.length > 0) setStep('pick-items')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerLocation.key])

  // Load photos on mount; skip to step 2 if items came from router state
  useEffect(() => {
    fetchUserPhotos()
      .then(ps => {
        setPhotos(ps)
        const primary = ps.find(p => p.isPrimary)
        if (primary) setSelectedPhotoId(primary.id)
        else if (ps.length > 0) setSelectedPhotoId(ps[0].id)
        if (preselectIds.length > 0 && ps.length > 0) setStep('pick-items')
      })
      .catch(err => setError(String(err)))
      .finally(() => setLoadingPhotos(false))
  }, [])

  // Pre-load a shared image from the PWA share-target inbox (#134). The file is
  // already saved under the user's tree, so register it as a garment without
  // re-uploading and jump to the Upload tab. No auto-generate — the user presses
  // Generate (parity with Discover's leave-for-the-user model).
  useEffect(() => {
    const inboxId = searchParams.get('inboxId')
    if (!inboxId) return
    const next = new URLSearchParams(searchParams)
    next.delete('inboxId')
    setSearchParams(next, { replace: true })
    void (async () => {
      try {
        const payload = await getShare(inboxId)
        const uri = payload.imageUris[0]
        if (!uri) return
        setUploadedGarments(prev => [...prev, {
          localId: nanoid(),
          previewUrl: `/${uri}`,
          imageUri: uri,
          uploading: false,
        }])
        setItemsTab('upload')
        setStep('pick-items')
      } catch { /* shared image unavailable — ignore */ }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refresh history whenever user is on step 1 (picks up newly generated results)
  useEffect(() => {
    if (step !== 'pick-photo') return
    fetchTryonHistory()
      .then(setHistory)
      .catch(() => { /* non-critical */ })
  }, [step])

  // Load outfits when switching to outfits tab (lazy, once)
  useEffect(() => {
    if (itemsTab !== 'outfits' || outfits.length > 0) return
    setLoadingOutfits(true)
    fetchOutfitsHydrated()
      .then(setOutfits)
      .catch(err => setError(String(err)))
      .finally(() => setLoadingOutfits(false))
  }, [itemsTab])

  // Lazily fetch wear suggestions when result is shown but suggestions not yet loaded
  useEffect(() => {
    if (step !== 'result' || wearSuggestions.length > 0 || selectedItemIds.size === 0) return
    fetchWearSuggestions([...selectedItemIds], sourceOutfitId)
      .then(setWearSuggestions)
      .catch(() => { /* non-critical */ })
  }, [step, resultUri])

  const filteredItems = useMemo(
    () => applyItemFilters(items, itemFilters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, itemFilters.categories.join(','), itemFilters.search, itemFilters.color, itemFilters.season, itemFilters.occasion, itemFilters.brand, itemFilters.types.join(','), itemFilters.material, itemFilters.tags.join(',')],
  )

  const ci = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase())
  const outfitOccasions = useMemo(
    () => [...new Set(
      outfits.map(o => o.occasion?.trim().toLowerCase()).filter(Boolean) as string[]
    )].sort(ci),
    [outfits],
  )
  const outfitAllTags = useMemo(() => {
    const s = new Set<string>()
    outfits.forEach(o => {
      try { (JSON.parse(o.tags || '[]') as string[]).forEach(t => s.add(t.trim().toLowerCase())) } catch { /* ignore */ }
    })
    return [...s].filter(Boolean).sort(ci)
  }, [outfits])

  const filteredOutfits = useMemo(() => {
    const q = outfitSearch.trim().toLowerCase()
    return outfits.filter(o => {
      if (outfitOccasion && o.occasion?.toLowerCase() !== outfitOccasion.toLowerCase()) return false
      if (outfitSeason) {
        let seasons: string[] = []
        try { seasons = JSON.parse(o.season || '[]') as string[] } catch { /* ignore */ }
        if (!seasons.includes(outfitSeason)) return false
      }
      if (outfitTags.length > 0) {
        let tags: string[] = []
        try { tags = JSON.parse(o.tags || '[]') as string[] } catch { /* ignore */ }
        const lower = tags.map(t => t.toLowerCase())
        if (!outfitTags.some(t => lower.includes(t.toLowerCase()))) return false
      }
      if (outfitAiOnly && !o.aiGenerated) return false
      if (q) {
        const nameMatch = o.name?.toLowerCase().includes(q)
        const notesMatch = o.notes?.toLowerCase().includes(q)
        const itemMatch = o.items?.some(i =>
          (i.subcategory ?? i.category)?.toLowerCase().includes(q) ||
          i.brand?.toLowerCase().includes(q)
        )
        if (!nameMatch && !notesMatch && !itemMatch) return false
      }
      return true
    })
  }, [outfits, outfitSearch, outfitOccasion, outfitSeason, outfitTags, outfitAiOnly])

  async function handleDeletePhoto(id: string) {
    setDeletingPhotoId(id)
    try {
      await deleteUserPhoto(id)
      const remaining = photos.filter(p => p.id !== id)
      setPhotos(remaining)
      if (selectedPhotoId === id) setSelectedPhotoId(remaining[0]?.id ?? null)
    } catch (err) {
      setError(String(err))
    } finally {
      setDeletingPhotoId(null)
    }
  }

  async function uploadPhotoFile(file: File) {
    setUploadingPhoto(true)
    try {
      const cropped = await cropToAspectRatio(file, 3, 4)
      const photo = await uploadUserPhoto(cropped)
      setPhotos(prev => [photo, ...prev])
      setSelectedPhotoId(photo.id)
    } catch (err) {
      setError(String(err))
    } finally {
      setUploadingPhoto(false)
    }
  }

  async function handleAddPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    await uploadPhotoFile(file)
    e.target.value = ''
  }

  usePasteImage(files => uploadPhotoFile(files[0]), step === 'pick-photo')

  function toggleItem(id: string) {
    setSelectedItemIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function selectOutfit(outfit: HydratedOutfit) {
    setSelectedItemIds(new Set(outfit.items.map(i => i.id)))
    setItemsTab('items')
  }

  function uploadGarmentFiles(files: File[]) {
    if (!files.length) return

    const placeholders: GarmentUpload[] = files.map(file => ({
      localId: nanoid(),
      previewUrl: URL.createObjectURL(file),
      imageUri: null,
      uploading: true,
    }))
    setUploadedGarments(prev => [...prev, ...placeholders])

    Promise.all(
      files.map(async (file, i) => {
        const localId = placeholders[i].localId
        try {
          const { imageUri } = await uploadGarment(file)
          setUploadedGarments(prev =>
            prev.map(g => g.localId === localId ? { ...g, imageUri, uploading: false } : g)
          )
        } catch {
          setUploadedGarments(prev => prev.filter(g => g.localId !== localId))
        }
      })
    )
  }

  async function handleAddGarments(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    uploadGarmentFiles(files)
  }

  usePasteImage(uploadGarmentFiles, step === 'pick-items' && itemsTab === 'upload')

  function removeGarment(localId: string) {
    setUploadedGarments(prev => prev.filter(g => g.localId !== localId))
  }

  async function handleGenerate() {
    if (!selectedPhotoId || (selectedItemIds.size === 0 && uploadedGarments.length === 0)) return
    track('tryon_started')
    setGenerating(true)
    setError(null)
    setStep('result')
    try {
      const garmentUris = uploadedGarments
        .filter(g => g.imageUri !== null)
        .map(g => g.imageUri!)
      const result = await generateTryOn(
        selectedPhotoId,
        [...selectedItemIds],
        garmentUris.length ? garmentUris : undefined,
        userInstruction.trim() || undefined,
        sourceOutfitId,
      )
      setResultUri(result.resultImageUri)
      setResultTryonId(result.tryonId)
      track('tryon_completed')
      setWearSuggestions(result.wearSuggestions ?? [])
      setHistory(prev => [{
        id: result.tryonId,
        userPhotoId: selectedPhotoId,
        outfitId: null,
        itemIds: JSON.stringify([...selectedItemIds]),
        resultImageUri: result.resultImageUri,
        promptInstruction: userInstruction.trim() || undefined,
        createdAt: Date.now(),
      }, ...prev])
      requestWalletRefresh()
    } catch (err) {
      setError(String(err))
      setStep('pick-items')
    } finally {
      setGenerating(false)
    }
  }

  async function handleRegenerate() {
    if (!selectedPhotoId || (selectedItemIds.size === 0 && uploadedGarments.length === 0)) return
    setRegenerating(true)
    setError(null)
    try {
      const garmentUris = uploadedGarments
        .filter(g => g.imageUri !== null)
        .map(g => g.imageUri!)
      const result = await generateTryOn(
        selectedPhotoId,
        [...selectedItemIds],
        garmentUris.length ? garmentUris : undefined,
        userInstruction.trim() || undefined,
        sourceOutfitId,
      )
      setResultUri(result.resultImageUri)
      setResultTryonId(result.tryonId)
      setWearSuggestions(result.wearSuggestions ?? [])
      setHistory(prev => [{
        id: result.tryonId,
        userPhotoId: selectedPhotoId,
        outfitId: null,
        itemIds: JSON.stringify([...selectedItemIds]),
        resultImageUri: result.resultImageUri,
        promptInstruction: userInstruction.trim() || undefined,
        createdAt: Date.now(),
      }, ...prev])
      requestWalletRefresh()
    } catch (err) {
      setError(String(err))
    } finally {
      setRegenerating(false)
    }
  }

  function tryAgain() {
    track('tryon_discarded')
    setStep('pick-items')
    setResultUri(null)
    setResultTryonId(null)
    setError(null)
  }

  function previewHistory(item: TryonHistoryItem) {
    setSelectedHistoryId(item.id)
    setPreviewingHistoryUri(item.resultImageUri)
  }

  function clearHistoryPreview() {
    setSelectedHistoryId(null)
    setPreviewingHistoryUri(null)
  }

  async function handleDeleteHistory(id: string) {
    setDeletingHistoryId(id)
    try {
      await deleteTryonResult(id)
      setHistory(prev => prev.filter(h => h.id !== id))
      if (selectedHistoryId === id) clearHistoryPreview()
    } catch (err) {
      setError(String(err))
    } finally {
      setDeletingHistoryId(null)
    }
  }

  function toggleHistorySelect(id: string) {
    setSelectedHistoryIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function exitHistorySelectMode() {
    setHistorySelectMode(false)
    setSelectedHistoryIds(new Set())
  }

  async function handleDeleteSelectedHistory() {
    setDeletingSelectedHistory(true)
    try {
      await Promise.all([...selectedHistoryIds].map(id => deleteTryonResult(id)))
      setHistory(prev => prev.filter(h => !selectedHistoryIds.has(h.id)))
      if (selectedHistoryId && selectedHistoryIds.has(selectedHistoryId)) clearHistoryPreview()
      exitHistorySelectMode()
    } catch (err) {
      setError(String(err))
    } finally {
      setDeletingSelectedHistory(false)
    }
  }

  function openSaveModal(tryonId: string, coverUri: string, itemIds: string[]) {
    currentTryonIdRef.current = tryonId
    setSaveCoverUri(coverUri)
    setSavingItemIds(itemIds)
    setShowSaveModal(true)
  }

  async function handleOutfitSaved(outfitId: string) {
    const tryonId = currentTryonIdRef.current
    if (!tryonId) return
    setSavingOutfit(tryonId)
    setCoverUploadError(prev => (prev?.tryonId === tryonId ? null : prev))
    // The outfit now exists — flip the button immediately so a second tap can't
    // create a duplicate, then link and attach the cover independently so one
    // failure can't block the other.
    setSavedOutfitIds(prev => ({ ...prev, [tryonId]: outfitId }))
    setHistory(prev => prev.map(h =>
      h.id === tryonId ? { ...h, outfitId } : h
    ))
    track('tryon_saved')
    try {
      await linkTryonToOutfit(tryonId, outfitId)
    } catch (err) {
      setError(String(err))
    }
    if (saveCoverUri) {
      try {
        await uploadOutfitCover(outfitId, await fetchCoverFile(saveCoverUri))
      } catch (err) {
        setCoverUploadError({ tryonId, outfitId, coverUri: saveCoverUri, message: String(err) })
      }
    }
    setSavingOutfit(null)
  }

  async function retryOutfitCover() {
    if (!coverUploadError) return
    setSavingOutfit(coverUploadError.tryonId)
    try {
      await uploadOutfitCover(coverUploadError.outfitId, await fetchCoverFile(coverUploadError.coverUri))
      setCoverUploadError(null)
    } catch (err) {
      setCoverUploadError({ ...coverUploadError, message: String(err) })
    } finally {
      setSavingOutfit(null)
    }
  }

  const coverRetryNotice = (tryonId: string | null) => {
    if (!coverUploadError || coverUploadError.tryonId !== tryonId) return null
    return (
      <div className="mt-2 border-2 border-error bg-paper px-3 py-2 rounded-base">
        <p className="text-[14px] font-mono text-error uppercase tracking-[0.06em]">Couldn't attach the cover image to your outfit.</p>
        <p className="text-[12px] font-mono text-muted break-all">{coverUploadError.message}</p>
        <Button
          variant="secondary"
          className="w-full mt-2"
          loading={savingOutfit !== null}
          onClick={() => void retryOutfitCover()}
        >
          Retry cover
        </Button>
      </div>
    )
  }

  const currentTryonIdRef = useRef<string | null>(null)

  async function handleUpdateOutfitCover(outfitId: string) {
    if (!resultUri) return
    const tryonId = resultTryonId
    setSavingOutfit(tryonId ?? outfitId)
    try {
      await uploadOutfitCover(outfitId, await fetchCoverFile(resultUri))
      if (tryonId) {
        await linkTryonToOutfit(tryonId, outfitId)
        setSavedOutfitIds(prev => ({ ...prev, [tryonId]: outfitId }))
        setHistory(prev => prev.map(h => h.id === tryonId ? { ...h, outfitId } : h))
      }
      track('tryon_saved')
      navigate('/outfits')
    } catch (err) {
      setError(String(err))
    } finally {
      setSavingOutfit(null)
    }
  }

  const selectedPhoto = photos.find(p => p.id === selectedPhotoId)

  return (
    <div className="flex flex-col gap-4 p-4 pb-24">
      <PageHeader
        title="Try On."
        subtitle={history.length > 0 ? `${history.length} ${history.length === 1 ? 'result' : 'results'}` : undefined}
      />

      {error && (
        <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[14px] font-mono text-ink uppercase tracking-[0.06em] rounded-base">
          {error}
        </div>
      )}

      {/* ── Step 1: Pick reference photo ── */}
      {step === 'pick-photo' && (
        <StepFade>
          <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">
            {previewingHistoryUri ? 'History preview' : 'Your photo'}
          </p>

          {loadingPhotos ? (
            <SkeletonPhoto />
          ) : photos.length === 0 && !previewingHistoryUri ? (
            <label className={`block w-full aspect-[3/4] border-2 border-dashed border-outline flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-ink transition-colors ${uploadingPhoto ? 'opacity-50 pointer-events-none' : ''}`}>
              {uploadingPhoto ? <Spinner size={32} /> : <span className="text-4xl font-bold text-muted leading-none">+</span>}
              <span className="text-[14px] font-mono text-muted uppercase tracking-[0.08em]">
                {uploadingPhoto ? 'Uploading…' : 'Add your photo'}
              </span>
              <span className="text-[14px] font-mono text-muted/50 uppercase tracking-[0.06em]">or Ctrl+V to paste</span>
              <input type="file" accept="image/*" capture="user" className="hidden" onChange={handleAddPhoto} disabled={uploadingPhoto} />
            </label>
          ) : (
            <>
              {/* Big image — user photo or history preview */}
              <div className="relative w-full aspect-[3/4] border-2 border-ink overflow-hidden bg-surface-dim rounded-base">
                {previewingHistoryUri ? (
                  <>
                    <AuthImage src={`/${previewingHistoryUri}`} alt="History result" className="w-full h-full object-contain" lazy fillBackground />
                    <button
                      onClick={clearHistoryPreview}
                      className="absolute top-2 left-2 flex items-center gap-1 border-2 border-ink bg-paper text-ink px-2 py-1 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
                    >
                      <ChevronLeft className="w-3 h-3 shrink-0" /> Back
                    </button>
                    <div className="absolute top-2 right-2">
                      <OverlayRemoveButton
                        onClick={() => selectedHistoryId && void handleDeleteHistory(selectedHistoryId)}
                        disabled={!!(selectedHistoryId && deletingHistoryId === selectedHistoryId)}
                        busy={!!(selectedHistoryId && deletingHistoryId === selectedHistoryId)}
                      />
                    </div>
                  </>
                ) : (
                  <>
                    {selectedPhoto && (
                      <AuthImage src={`/${selectedPhoto.imageUri}`} alt="You" className="w-full h-full object-contain" lazy fillBackground />
                    )}
                    {selectedPhoto && (
                      <div className="absolute top-2 right-2 flex gap-1.5">
                        <OverlayRemoveButton
                          onClick={() => handleDeletePhoto(selectedPhoto.id)}
                          disabled={deletingPhotoId === selectedPhoto.id}
                          busy={deletingPhotoId === selectedPhoto.id}
                        />
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Photo thumbnail strip — hidden while previewing history */}
              {!previewingHistoryUri && (
                <div className="mt-2 flex gap-2 overflow-x-auto scrollbar-hide">
                  {photos.map(photo => (
                    <button
                      key={photo.id}
                      onClick={() => setSelectedPhotoId(photo.id)}
                      className={`shrink-0 w-14 aspect-[3/4] overflow-hidden border-2 transition-all ${
                        selectedPhotoId === photo.id
                          ? 'border-accent ring-[3px] ring-accent ring-offset-[-3px]'
                          : 'border-outline hover:border-ink'
                      }`}
                    >
                      <AuthImage src={`/${photo.imageUri}`} alt="You" className="w-full h-full object-contain" lazy fillBackground />
                    </button>
                  ))}
                  {photos.length < 4 && (
                    <label className={`shrink-0 w-14 aspect-[3/4] flex flex-col items-center justify-center gap-1 border-2 border-dashed border-outline cursor-pointer hover:border-ink transition-colors ${uploadingPhoto ? 'opacity-50 pointer-events-none' : ''}`}>
                      {uploadingPhoto ? <Spinner size={16} /> : <Plus className="w-5 h-5 text-muted" />}
                      <span className="text-[14px] font-mono text-muted uppercase">Add</span>
                      <input type="file" accept="image/*" capture="user" className="hidden" onChange={handleAddPhoto} disabled={uploadingPhoto} />
                    </label>
                  )}
                </div>
              )}
            </>
          )}

          {/* Select Items button */}
          <Button
            onClick={() => { clearHistoryPreview(); setStep('pick-items') }}
            disabled={!selectedPhotoId}
            className="w-full mt-4"
          >
            Select Items <ChevronRight className="w-3.5 h-3.5 inline-block ml-1" />
          </Button>

          {/* History carousel */}
          {history.length > 0 && (
            <div className="mt-4">
              <div className="flex items-center justify-between border-b-2 border-ink pb-1.5 mb-2">
                <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">History</p>
                {historySelectMode ? (
                  <div className="flex gap-2">
                    <button
                      onClick={() => void handleDeleteSelectedHistory()}
                      disabled={selectedHistoryIds.size === 0 || deletingSelectedHistory}
                      className="flex items-center gap-1 border-2 border-error text-error px-2 py-0.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-40 rounded-base"
                    >
                      <Trash2 className="w-3 h-3 shrink-0" />
                      {deletingSelectedHistory ? '…' : `Delete${selectedHistoryIds.size > 0 ? ` (${selectedHistoryIds.size})` : ''}`}
                    </button>
                    <button
                      onClick={exitHistorySelectMode}
                      className="border-2 border-ink px-2 py-0.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setHistorySelectMode(true)}
                    className="text-[14px] font-bold font-mono uppercase tracking-[0.08em] text-muted hover:text-ink transition-colors"
                  >
                    Select
                  </button>
                )}
              </div>
              <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
                {history.map(h => {
                  let sourceIds: string[] = []
                  try { sourceIds = JSON.parse(h.itemIds || '[]') as string[] } catch { /* ignore */ }
                  return (
                  <div key={h.id} className="relative shrink-0 flex flex-col gap-1">
                    <button
                      onClick={() => {
                        if (historySelectMode) { toggleHistorySelect(h.id); return }
                        if (selectedHistoryId === h.id) { clearHistoryPreview(); return }
                        previewHistory(h)
                      }}
                      className={`w-20 h-20 border-2 relative transition-all block rounded-base ${
                        historySelectMode && selectedHistoryIds.has(h.id)
                          ? 'border-transparent animate-border-march'
                          : selectedHistoryId === h.id && !historySelectMode
                          ? 'border-accent ring-[3px] ring-accent ring-offset-[-3px] overflow-hidden'
                          : 'border-outline hover:border-ink overflow-hidden'
                      }`}
                    >
                      <AuthImage src={`/${h.resultImageUri}`} alt="Past result" className="w-full h-full object-contain" lazy fillBackground />
                    </button>
                    {sourceIds.length > 0 && (
                      <div className="flex gap-0.5 justify-center">
                        {sourceIds.slice(0, 3).map(id => {
                          const item = items.find(i => i.id === id)
                          if (!item) return null
                          return (
                            <div key={id} className="w-6 h-6 border border-outline overflow-hidden bg-surface-dim">
                              <AuthImage src={`/${item.imageUri}`} alt="" className="w-full h-full object-contain" lazy fillBackground />
                            </div>
                          )
                        })}
                        {sourceIds.length > 3 && (
                          <span className="text-[8px] font-mono text-muted self-center">+{sourceIds.length - 3}</span>
                        )}
                      </div>
                    )}
                  </div>
                )})}
              </div>
            </div>
          )}

          {/* Selected items section — collapsible dropdown, visible when a history thumbnail is active */}
          {previewingHistoryUri && selectedHistoryId && (() => {
            const hist = history.find(h => h.id === selectedHistoryId)
            if (!hist) return null
            let histItemIds: string[] = []
            try { histItemIds = JSON.parse(hist.itemIds || '[]') as string[] } catch { /* ignore */ }
            const isSaved = savedOutfitIds[hist.id] || hist.outfitId
            return (
              <div>
                <div className="flex items-center justify-between border-b-2 border-ink pb-2">
                  <button
                    onClick={() => setHistoryItemsCollapsed(!historyItemsCollapsed)}
                    className="flex items-center gap-1 text-[14px] font-bold font-mono uppercase tracking-[0.1em]"
                  >
                    {historyItemsCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    Selected items
                  </button>
                </div>
                {!historyItemsCollapsed && (
                  <>
                    <div className={`${CARD_GRID} ${CARD_AUTO} pt-2 animate-grid-in`}>
                      {histItemIds.map(id => {
                        const item = items.find(i => i.id === id)
                        if (!item) return (
                          <div key={id} className="aspect-[3/4] border-2 border-outline border-dashed flex items-center justify-center p-2 bg-surface-dim rounded-base">
                            <span className="text-[10px] font-mono text-muted text-center uppercase tracking-[0.06em]">Item not in closet</span>
                          </div>
                        )
                        return (
                          <ItemCard
                            key={item.id}
                            item={item}
                            onClick={() => { setShowItemDetail(item) }}
                          />
                        )
                      })}
                    </div>
                    {isSaved ? (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          const outfitId = savedOutfitIds[hist.id] || hist.outfitId
                          if (outfitId) fetchOutfitsHydrated().then(outs => {
                            const o = outs.find(x => x.id === outfitId)
                            if (o) setShowEditOutfit(o)
                          })
                        }}
                        className="w-full mt-2"
                      >
                        View outfit
                      </Button>
                    ) : (
                      <Button
                        onClick={() => openSaveModal(hist.id, hist.resultImageUri, histItemIds)}
                        disabled={histItemIds.length === 0}
                        className="w-full mt-2"
                      >
                        Save outfit
                      </Button>
                    )}
                    {coverRetryNotice(hist.id)}
                  </>
                )}
              </div>
            )
          })()}
        </StepFade>
      )}

      {/* ── Step 2: Pick items / outfits / upload ── */}
      {step === 'pick-items' && (
        <StepFade>
          <div className="flex items-center justify-between border-b-2 border-ink pb-2">
            <button onClick={() => setStep('pick-photo')} className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] hover:text-ink"><ChevronLeft className="w-3.5 h-3.5 inline-block mr-1" /> Photo</button>
            <p className="text-[14px] font-mono uppercase tracking-[0.06em]">Select</p>
            <div className="w-12" />
          </div>

          {/* ITEMS / OUTFITS / UPLOAD tabs */}
          <div className="flex mt-2 border-b-2 border-ink">
            {(['items', 'outfits', 'upload'] as ItemsTab[]).map(tab => (
              <button
                key={tab}
                onClick={() => {
                  if (tab !== 'items') setItemFilters(EMPTY_FILTER_STATE)
                  if (tab !== 'outfits') {
                    setOutfitSearch(''); setOutfitOccasion(''); setOutfitSeason('')
                    setOutfitTags([]); setOutfitAiOnly(false); setOutfitTagsOpen(false)
                  }
                  setItemsTab(tab)
                }}
                className={`flex-1 py-2 text-[14px] font-bold font-mono uppercase tracking-[0.08em] transition-colors ${
                  itemsTab === tab ? 'bg-accent text-accent-on' : 'text-muted hover:text-ink'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          {/* ITEMS tab */}
          {itemsTab === 'items' && (
            <TabFade className={SELECT_PANEL}>
              {loadingItems ? (
              <SkeletonItemGrid />
            ) : (
              <>
                {items.length > 0 && (
                  <ItemFilterControls
                    allItems={items}
                    value={itemFilters}
                    onChange={patch => setItemFilters(prev => ({ ...prev, ...patch }))}
                    onClear={() => setItemFilters(prev => ({
                      ...prev,
                      color: '', season: '', occasion: '', brand: '', types: [], material: '', tags: [],
                    }))}
                    showSearch
                  />
                )}
                <div className={`${CARD_GRID} ${CARD_AUTO} animate-grid-in`}>
                  {filteredItems.map(item => (
                    <ItemCard
                      key={item.id}
                      item={item}
                      selectable
                      selected={selectedItemIds.has(item.id)}
                      onClick={() => toggleItem(item.id)}
                    />
                  ))}
                  {filteredItems.length === 0 && isFilterActive(itemFilters) && (
                    <p className="col-span-3 text-center py-8 text-[14px] font-mono text-muted uppercase tracking-[0.06em]">No items match filters.</p>
                  )}
                </div>
              </>
            )
            }
            </TabFade>
          )}

          {/* OUTFITS tab */}
          {itemsTab === 'outfits' && (
            <TabFade className={SELECT_PANEL}>
              {loadingOutfits ? (
              <SkeletonOutfitList />
            ) : outfits.length === 0 ? (
              <p className="text-center py-10 text-[14px] font-mono text-muted uppercase tracking-[0.06em]">No saved outfits</p>
            ) : (
              <div className="flex flex-col gap-3 pt-2">
                <input
                  type="search"
                  placeholder="Search outfits..."
                  value={outfitSearch}
                  onChange={e => setOutfitSearch(e.target.value)}
                  className="w-full mt-2 border-2 border-ink px-3 py-2 text-[14px] font-mono focus:outline-none placeholder:text-muted bg-paper"
                />

                {/* Occasion + Season + AI Only */}
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1">
                    <FilterBar
                      filters={[
                        ...(outfitOccasions.length > 0 ? [{ key: 'occasion', label: 'Occasion', options: outfitOccasions }] : []),
                        { key: 'season', label: 'Season', options: ['fall', 'spring', 'summer', 'winter'] },
                      ]}
                      values={{ occasion: outfitOccasion, season: outfitSeason }}
                      onChange={(key, val) => {
                        if (key === 'occasion') setOutfitOccasion(val)
                        else if (key === 'season') setOutfitSeason(val)
                      }}
                      onClear={() => { setOutfitOccasion(''); setOutfitSeason(''); setOutfitTags([]); setOutfitAiOnly(false) }}
                      activeCount={[outfitOccasion, outfitSeason].filter(Boolean).length + outfitTags.length + (outfitAiOnly ? 1 : 0)}
                    />
                  </div>
                  <button
                    onClick={() => setOutfitAiOnly(v => !v)}
                    className={`shrink-0 self-end px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] border-2 border-ink shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base ${
                      outfitAiOnly ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
                    }`}
                  >
                    AI Only
                  </button>
                </div>

                {/* Tags chip panel */}
                {outfitAllTags.length > 0 && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setOutfitTagsOpen(v => !v)}
                      className="flex items-center gap-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors"
                    >
                      Tags
                      {outfitTags.length > 0 && (
                        <span className="px-1 py-0.5 bg-accent text-accent-on text-[14px] leading-none">
                          {outfitTags.length}
                        </span>
                      )}
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
                        className={`transition-transform duration-200 ${outfitTagsOpen || outfitTags.length > 0 ? 'rotate-180' : ''}`}>
                        <path d="M4 5.5L0.5 2h7L4 5.5z" />
                      </svg>
                    </button>
                    <div className={`grid transition-all duration-200 ease-in-out ${
                      outfitTagsOpen || outfitTags.length > 0 ? 'grid-rows-[1fr] opacity-100 mt-1.5' : 'grid-rows-[0fr] opacity-0'
                    }`}>
                      <div className="overflow-hidden">
                        <ChipToggle options={outfitAllTags} selected={outfitTags} onChange={setOutfitTags} />
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-3">
                  {filteredOutfits.map(outfit => (
                    <button
                      key={outfit.id}
                      onClick={() => selectOutfit(outfit)}
                      className="flex items-center gap-3 border-2 border-ink p-3 hover:bg-surface-dim transition-colors text-left w-full rounded-base"
                    >
                      <div className="shrink-0 w-16 h-16 grid grid-cols-2 gap-[2px] overflow-hidden border border-outline">
                        {outfit.items.slice(0, 4).map(item => (
                          <div key={item.id} className="overflow-hidden bg-surface-dim">
                            <AuthImage src={`/${item.imageUri}`} alt="" className="w-full h-full object-contain" lazy fillBackground />
                          </div>
                        ))}
                      </div>
                      <div className="flex flex-col gap-0.5 min-w-0">
                        <span className="text-[14px] font-bold font-mono truncate">{outfit.name}</span>
                        {outfit.occasion && (
                          <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">{outfit.occasion}</span>
                        )}
                        <span className="text-[14px] font-mono text-muted">{outfit.items.length} items</span>
                      </div>
                    </button>
                  ))}
                  {filteredOutfits.length === 0 && (outfitSearch.trim() || outfitOccasion || outfitSeason || outfitTags.length > 0 || outfitAiOnly) && (
                    <p className="text-center py-8 text-[14px] font-mono text-muted uppercase tracking-[0.06em]">No outfits match filters.</p>
                  )}
                </div>
              </div>
            )
            }
            </TabFade>
          )}

          {/* UPLOAD tab */}
          {itemsTab === 'upload' && (
            <TabFade className={SELECT_PANEL}>
              <label className="flex-1 mt-3 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-outline rounded-base p-6 cursor-pointer hover:border-ink transition-colors">
                <Plus className="w-8 h-8 text-muted" strokeWidth={1.5} />
                <span className="text-[14px] font-mono text-muted uppercase tracking-[0.08em]">Upload garment photos (optional)</span>
                <input type="file" accept="image/*" multiple className="hidden" onChange={handleAddGarments} />
              </label>
              {uploadedGarments.length > 0 && (
                <div className="grid grid-cols-3 gap-[3px] mt-3">
                  {uploadedGarments.map(g => (
                    <div key={g.localId} className="relative aspect-square overflow-hidden border-2 border-ink rounded-base">
                      <img src={g.imageUri ? `/${g.imageUri}` : g.previewUrl} alt="Garment" className="w-full h-full object-contain" />
                      {g.uploading && (
                        <div className="absolute inset-0 bg-paper/70 flex items-center justify-center">
                          <Spinner size={24} />
                        </div>
                      )}
                      {!g.uploading && (
                        <button
                          onClick={() => removeGarment(g.localId)}
                          aria-label="Remove"
                          className="absolute top-1 right-1 w-7 h-7 flex items-center justify-center border-2 border-ink bg-paper text-ink hover:bg-surface-dim rounded-base transition-colors"
                        >
                          <X className="w-3.5 h-3.5" strokeWidth={2.5} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </TabFade>
          )}

          <div className="sticky bottom-0 bg-paper border-t-2 border-ink pt-3 pb-20 -mx-4 px-4 space-y-2">
            {selectedItemIds.size > 0 && itemsTab === 'items' && (
              <div>
                <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em] mb-1.5">{selectedItemIds.size} selected</p>
                <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                  {[...selectedItemIds].map(id => {
                    const item = items.find(i => i.id === id)
                    if (!item) return null
                    return (
                      <div key={id} className="relative shrink-0 w-12 h-[60px]">
                        <div className="w-full h-full border-2 border-ink overflow-hidden rounded-base">
                          <AuthImage src={`/${item.imageUri}`} alt="" className="h-full w-full object-contain" lazy fillBackground />
                        </div>
                        <button
                          onClick={() => toggleItem(id)}
                          aria-label="Remove"
                          className="absolute -top-1 -right-1 w-4 h-4 bg-accent text-accent-on flex items-center justify-center border border-ink rounded-sm"
                        >
                          <X className="w-2.5 h-2.5" strokeWidth={2.5} />
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
            <Button
              onClick={handleGenerate}
              disabled={selectedItemIds.size === 0 && uploadedGarments.length === 0 || uploadedGarments.some(g => g.uploading)}
              className="w-full"
            >
              Generate Preview
              {(selectedItemIds.size > 0 || uploadedGarments.length > 0) && ` (${[
                selectedItemIds.size > 0 && `${selectedItemIds.size} item${selectedItemIds.size !== 1 ? 's' : ''}`,
                uploadedGarments.length > 0 && `${uploadedGarments.length} upload${uploadedGarments.length !== 1 ? 's' : ''}`,
              ].filter(Boolean).join(' · ')})`}
            </Button>
          </div>
        </StepFade>
      )}

      {/* ── Step 4: Result ── */}
      {step === 'result' && (
        <StepFade>
          <div className="flex items-center justify-between border-b-2 border-ink pb-2">
            <button
              onClick={tryAgain}
              disabled={generating}
              className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] hover:text-ink disabled:opacity-30"
            >
              <ChevronLeft className="w-3.5 h-3.5 inline-block mr-1" /> Items
            </button>
            <p className="text-[14px] font-mono uppercase tracking-[0.06em]">Result</p>
            <div className="w-12" />
          </div>

          {generating && (
            <div className="flex flex-col items-center gap-4 py-10">
              <Spinner size={40} />
              <p className="text-[14px] font-mono text-muted uppercase tracking-[0.08em]">Generating your look…</p>
            </div>
          )}

          {resultUri && !generating && (
            <>
              {/* Result image — stays visible with overlay spinner during regeneration */}
              <div className="relative border-2 border-ink overflow-hidden rounded-base">
                <AuthImage src={`/${resultUri!}`} alt="Try-on result" className="w-full object-contain" />
                {regenerating && (
                  <div className="absolute inset-0 bg-paper/70 flex items-center justify-center">
                    <Spinner size={40} />
                  </div>
                )}
                {!regenerating && resultTryonId && (
                  <div className="absolute top-2 right-2">
                    <OverlayRemoveButton
                      onClick={() => void handleDeleteHistory(resultTryonId).then(() => tryAgain())}
                      disabled={deletingHistoryId === resultTryonId}
                      busy={deletingHistoryId === resultTryonId}
                    />
                  </div>
                )}
              </div>

              {/* Selected items — collapsible dropdown */}
              {(selectedItemIds.size > 0 || uploadedGarments.length > 0) && (
                <div>
                  <div className="flex items-center justify-between border-b-2 border-ink pb-2">
                    <button
                      onClick={() => setResultItemsCollapsed(!resultItemsCollapsed)}
                      className="flex items-center gap-1 text-[14px] font-bold font-mono uppercase tracking-[0.1em]"
                    >
                      {resultItemsCollapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                      Selected items
                    </button>
                  </div>
                  {!resultItemsCollapsed && (
                    <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide pt-2">
                      {[...selectedItemIds].map(id => {
                        const item = items.find(i => i.id === id)
                        if (!item) return null
                        return (
                          <div key={id} className="shrink-0 w-12 h-[60px] border-2 border-ink overflow-hidden rounded-base bg-surface-dim">
                      <AuthImage src={`/${item.imageUri}`} alt="" className="h-full w-full object-contain" lazy fillBackground />
                          </div>
                        )
                      })}
                      {uploadedGarments.map(g => (
                        <div key={g.localId} className="shrink-0 w-12 h-[60px] border-2 border-outline border-dashed overflow-hidden rounded-base bg-surface-dim">
                          <img src={g.imageUri ? `/${g.imageUri}` : g.previewUrl} alt="" className="h-full w-full object-contain" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Refine section */}
              <div className="flex flex-col gap-4">
                <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Refine how it's worn</p>
                <textarea
                  value={userInstruction}
                  onChange={e => setUserInstruction(e.target.value)}
                  rows={2}
                  placeholder="e.g. worn as a turban, belted at waist, hood up..."
                  className="w-full border-2 border-ink p-2 font-mono text-[14px] resize-none placeholder:text-muted focus:outline-none"
                />
                <WearSuggestionChips suggestions={wearSuggestions} instruction={userInstruction} onPick={setUserInstruction} />
              </div>

              {/* Regenerate */}
              <div className="flex gap-2 mt-3">
                <Button onClick={handleRegenerate} className="flex-1" disabled={regenerating}>
                  {regenerating ? 'Generating…' : '↺ Regenerate'}
                </Button>
              </div>

              {/* Save outfit */}
              <div className="mt-3">
              {selectedItemIds.size > 0 && (() => {
                const latestTryonId = resultTryonId
                const viewedHistory = latestTryonId ? history.find(h => h.id === latestTryonId) : undefined
                const savedOutfitId = latestTryonId ? savedOutfitIds[latestTryonId] ?? viewedHistory?.outfitId : undefined
                const isSaved = !!savedOutfitId
                return isSaved ? (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        if (savedOutfitId) fetchOutfitsHydrated().then(outs => {
                          const o = outs.find(x => x.id === savedOutfitId)
                          if (o) setShowEditOutfit(o)
                        })
                      }}
                      className="w-full"
                    >
                      View outfit
                    </Button>
                    {coverRetryNotice(latestTryonId)}
                  </>
                ) : sourceOutfitId ? (
                  <Button
                    variant="secondary"
                    loading={savingOutfit !== null}
                    onClick={() => void handleUpdateOutfitCover(sourceOutfitId)}
                    className="w-full"
                  >
                    Update outfit cover
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (latestTryonId && resultUri) openSaveModal(latestTryonId, resultUri, [...selectedItemIds])
                    }}
                    className="w-full"
                  >
                    Save outfit
                  </Button>
                )
              })()}
              </div>
            </>
          )}
        </StepFade>
      )}

      {/* Save-as-outfit modal */}
      {showSaveModal && (
        <OutfitBuilder
          onClose={() => setShowSaveModal(false)}
          onCreated={() => {}}
          defaultItemIds={savingItemIds}
          defaultCoverImageUri={saveCoverUri ?? undefined}
          onSaved={handleOutfitSaved}
        />
      )}

      {/* Edit saved outfit */}
      {showEditOutfit && (
        <OutfitDetail
          outfit={showEditOutfit}
          onClose={() => setShowEditOutfit(null)}
          onChanged={() => setShowEditOutfit(null)}
        />
      )}

      {/* Item detail (from history selected items) */}
      {showItemDetail && (
        <ItemDetail
          item={showItemDetail}
          onClose={() => setShowItemDetail(null)}
          onChanged={() => {}}
        />
      )}
    </div>
  )
}
