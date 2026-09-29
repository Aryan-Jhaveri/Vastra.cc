import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { X, Plus } from 'lucide-react'
import { useSavedOutfits } from '../hooks/useSavedOutfits'
import { useCollections } from '../hooks/useCollections'
import { useInView } from '../hooks/useInView'
import { SavedOutfitCard } from '../components/SavedOutfitCard'
import { CollectionCard } from '../components/CollectionCard'
import { OutfitDetail } from '../modals/OutfitDetail'
import { CollectionDetail } from '../modals/CollectionDetail'
import { CollectionBuilder } from '../modals/CollectionBuilder'
import { AddToCollectionSheet } from '../modals/AddToCollectionSheet'
import { FilterBar } from '../components/FilterBar'
import { TabFade } from '../components/TabFade'
import { VastraLoader } from '../components/ui/VastraLoader'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import { ChipToggle } from '../components/ui/ChipToggle'
import { PageHeader } from '../components/PageHeader'
import { RevealCard } from '../components/RevealCard'
import { deleteOutfit } from '../api/outfits'
import { outfitMatchesSearch } from '../lib/search'
import { track } from '../lib/analytics'
import { usePageReset } from '../context/PageResetContext'
import { CARD_GRID } from '../constants/grid'
import type { HydratedOutfit } from '../api/outfits'

const SEASONS = ['fall', 'spring', 'summer', 'winter']
const WINDOW_SIZE = 12

type Tab = 'outfits' | 'collections'

export function Outfits() {
  const [tab, setTab] = useState<Tab>('outfits')

  // ── Outfits tab state ──────────────────────────────────────────────────────
  const { outfits, loading, error, refetch } = useSavedOutfits()
  const location = useLocation()
  const navigate = useNavigate()
  const [selectedOccasion, setSelectedOccasion] = useState('')
  const [selectedSeason, setSelectedSeason] = useState('')
  const [selectedTags, setSelectedTags] = useState<string[]>([])
  const [tagsOpen, setTagsOpen] = useState(false)
  const [aiOnly, setAiOnly] = useState(false)
  const [detail, setDetail] = useState<HydratedOutfit | null>(null)
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout>>()

  // Deep-link: "View outfit" from the Reminders tab navigates here with
  // { state: { openOutfitId } }. Open that outfit's detail once outfits load,
  // then clear the state so back/refresh doesn't reopen it.
  useEffect(() => {
    const openId = (location.state as { openOutfitId?: string } | null)?.openOutfitId
    if (!openId || outfits.length === 0) return
    const match = outfits.find(o => o.id === openId)
    if (match) {
      setTab('outfits')
      setDetail(match)
    }
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, outfits, navigate])

  const [searchQuery, setSearchQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(WINDOW_SIZE)
  const [visibleColCount, setVisibleColCount] = useState(WINDOW_SIZE)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [bulkAddToCollectionOpen, setBulkAddToCollectionOpen] = useState(false)

  // ── Collections tab state ──────────────────────────────────────────────────
  const { collections, loading: colLoading, error: colError, refetch: refetchCollections } = useCollections()
  const showOutfitLoading = useDelayedLoading(loading)
  const showColLoading = useDelayedLoading(colLoading)
  const [collectionDetail, setCollectionDetail] = useState<string | null>(null)
  const [collectionBuilderOpen, setCollectionBuilderOpen] = useState(false)
  const [selectedColTag, setSelectedColTag] = useState('')
  const [colSelectMode, setColSelectMode] = useState(false)
  const [selectedColIds, setSelectedColIds] = useState<Set<string>>(new Set())
  const [deletingCols, setDeletingCols] = useState(false)

  const { resetKeys } = usePageReset()
  const outfitsResetKey = resetKeys.outfits
  const initialResetKey = useRef(outfitsResetKey)
  const resetAllState = useCallback(() => {
    setTab('outfits')
    setSelectedOccasion('')
    setSelectedSeason('')
    setSelectedTags([])
    setTagsOpen(false)
    setAiOnly(false)
    setSearchQuery('')
    setSelectMode(false)
    setSelectedIds(new Set())
    setDeleting(false)
    setBulkAddToCollectionOpen(false)
    setDetail(null)
    setCollectionDetail(null)
    setCollectionBuilderOpen(false)
    setSelectedColTag('')
    setColSelectMode(false)
    setSelectedColIds(new Set())
    setDeletingCols(false)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, [])
  useEffect(() => {
    if (outfitsResetKey === initialResetKey.current) return
    resetAllState()
  }, [outfitsResetKey, resetAllState])

  function toggleColSelect(id: string) {
    setSelectedColIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function exitColSelectMode() {
    setColSelectMode(false)
    setSelectedColIds(new Set())
  }

  const prevColSelSizeRef = useRef(0)
  useEffect(() => {
    if (colSelectMode && selectedColIds.size === 0 && prevColSelSizeRef.current > 0) {
      setColSelectMode(false)
    }
    prevColSelSizeRef.current = selectedColIds.size
  }, [colSelectMode, selectedColIds.size])

  async function deleteSelectedCollections() {
    if (selectedColIds.size === 0) return
    setDeletingCols(true)
    await Promise.all([...selectedColIds].map(id => import('../api/collections').then(m => m.deleteCollection(id))))
    exitColSelectMode()
    void refetchCollections()
    setDeletingCols(false)
  }

  // ── Derived filter values ──────────────────────────────────────────────────
  const ci = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase())
  const occasions = [...new Set(
    outfits.map(o => o.occasion?.trim().toLowerCase()).filter(Boolean) as string[]
  )].sort(ci)
  const outfitTags = [...new Set(outfits.flatMap(o => {
    try { return (JSON.parse(o.tags || '[]') as string[]).map(t => t.trim().toLowerCase()) } catch { return [] }
  }))].filter(Boolean).sort(ci)

  const filterValues = { occasion: selectedOccasion, season: selectedSeason }
  const activeFilterCount = [selectedOccasion, selectedSeason].filter(Boolean).length + selectedTags.length + (aiOnly ? 1 : 0)

  function handleFilterChange(key: string, value: string) {
    if (key === 'occasion') setSelectedOccasion(value)
    else if (key === 'season') setSelectedSeason(value)
    clearTimeout(filterDebounceRef.current)
    filterDebounceRef.current = setTimeout(() => track('filter_applied'), 800)
  }

  function clearFilters() {
    setSelectedOccasion('')
    setSelectedSeason('')
    setSelectedTags([])
    setAiOnly(false)
    setSearchQuery('')
  }

  useEffect(() => { setVisibleCount(WINDOW_SIZE) }, [selectedOccasion, selectedSeason, selectedTags, aiOnly, searchQuery])
  useEffect(() => { setVisibleColCount(WINDOW_SIZE) }, [selectedColTag])

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function exitSelectMode() {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const prevOutfitSelSizeRef = useRef(0)
  useEffect(() => {
    if (selectMode && selectedIds.size === 0 && prevOutfitSelSizeRef.current > 0) {
      setSelectMode(false)
    }
    prevOutfitSelSizeRef.current = selectedIds.size
  }, [selectMode, selectedIds.size])

  async function deleteSelected() {
    if (selectedIds.size === 0) return
    setDeleting(true)
    await Promise.all([...selectedIds].map(id => deleteOutfit(id)))
    exitSelectMode()
    void refetch()
    setDeleting(false)
  }

  const filterConfigs = [
    ...(occasions.length > 0 ? [{ key: 'occasion', label: 'Occasion', options: occasions }] : []),
    { key: 'season', label: 'Season', options: SEASONS },
  ]

  const filtered = outfits.filter(o => {
    if (selectedOccasion && o.occasion?.toLowerCase() !== selectedOccasion.toLowerCase()) return false
    if (selectedSeason) {
      let seasons: string[] = []
      try { seasons = JSON.parse(o.season || '[]') as string[] } catch { /* ignore */ }
      if (!seasons.includes(selectedSeason)) return false
    }
    if (selectedTags.length > 0) {
      let tags: string[] = []
      try { tags = JSON.parse(o.tags || '[]') as string[] } catch { /* ignore */ }
      const lower = tags.map(t => t.toLowerCase())
      if (!selectedTags.some(t => lower.includes(t.toLowerCase()))) return false
    }
    if (aiOnly && !o.aiGenerated) return false
    if (!outfitMatchesSearch(o, searchQuery)) return false
    return true
  })

  const selectedOutfits = useMemo(
    () => outfits.filter(o => selectedIds.has(o.id)),
    [outfits, selectedIds],
  )

  return (
    <div className="flex flex-col pb-24">
      <div className="sticky top-0 z-20 bg-paper px-4 pt-4 pb-3 flex flex-col gap-5">
      <PageHeader
        title="Outfits."
        subtitle={
          tab === 'outfits'
            ? (selectMode
                ? (selectedIds.size > 0 ? `${selectedIds.size} selected` : 'select outfits')
                : `${outfits.length} ${outfits.length === 1 ? 'outfit' : 'outfits'}`)
            : (colSelectMode
                ? (selectedColIds.size > 0 ? `${selectedColIds.size} selected` : 'select collections')
                : `${collections.length} ${collections.length === 1 ? 'collection' : 'collections'}`)
        }
        right={
          <>
            {tab === 'outfits' && (
              selectMode ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => setBulkAddToCollectionOpen(true)}
                    disabled={selectedIds.size === 0}
                    className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-30 flex items-center gap-1.5 rounded-base"
                  >
                    <Plus className="w-3 h-3 shrink-0" strokeWidth={2.5} /> <span className="hidden sm:inline">Collection</span>
                  </button>
                  <button
                    onClick={() => void deleteSelected()}
                    disabled={selectedIds.size === 0 || deleting}
                    className="bg-accent text-accent-on border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-30 hover:bg-active rounded-base"
                  >
                    {deleting ? '...' : 'Delete'}
                  </button>
                  <button
                    onClick={exitSelectMode}
                    className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setSelectMode(true)}
                  className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
                >
                  Select
                </button>
              )
            )}
            {tab === 'collections' && (
              colSelectMode ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => void deleteSelectedCollections()}
                    disabled={selectedColIds.size === 0 || deletingCols}
                    className="bg-accent text-accent-on border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-30 hover:bg-active rounded-base"
                  >
                    {deletingCols ? '...' : 'Delete'}
                  </button>
                  <button
                    onClick={exitColSelectMode}
                    className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => setColSelectMode(true)}
                    className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
                  >
                    Select
                  </button>
                  <button
                    onClick={() => setCollectionBuilderOpen(true)}
                    className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] flex items-center gap-1.5 rounded-base"
                  >
                    <Plus className="w-3 h-3 shrink-0" strokeWidth={2.5} /> New
                  </button>
                </div>
              )
            )}
          </>
        }
      />

      {/* Tab toggle */}
      <div className="flex border-2 border-ink rounded-base">
        {(['outfits', 'collections'] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] transition-colors ${
              tab === t ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Selected outfits carousel — pinned with the header (out of TabFade) */}
      {tab === 'outfits' && selectMode && (
        <div className="border-2 border-ink p-2 rounded-base">
          {selectedOutfits.length === 0 ? (
            <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">Tap outfits below to select</p>
          ) : (
            <div className="flex gap-2 overflow-x-auto py-1.5">
              {selectedOutfits.map(o => {
                const thumb = o.coverImageUri
                  ? `/${o.coverImageUri}`
                  : o.items?.[0] ? `/${o.items[0].imageUri}` : null
                return (
                  <div key={o.id} className="relative shrink-0">
                    {thumb
                      ? <img src={thumb} alt={o.name} className="w-14 h-14 object-cover border border-ink" />
                      : <div className="w-14 h-14 bg-surface-dim border border-ink" />}
                    <button onClick={() => toggleSelect(o.id)} className="absolute -top-1 -right-1 w-4 h-4 bg-accent text-accent-on flex items-center justify-center">
                      <X className="w-2.5 h-2.5" strokeWidth={2.5} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      </div>

      <div className="px-4 pt-2">
      {/* ── OUTFITS TAB ────────────────────────────────────────────────────── */}
      {tab === 'outfits' && (
        <TabFade>
          <input
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search outfits…"
            className="w-full border-2 border-ink px-3 py-2 text-[14px] font-mono outline-none bg-paper text-ink focus:bg-surface-dim placeholder:text-muted placeholder:normal-case"
          />

          <div className="mt-2 flex flex-wrap items-end gap-2 mb-3">
            <div className="flex-1">
              <FilterBar
                filters={filterConfigs}
                values={filterValues}
                onChange={handleFilterChange}
                onClear={clearFilters}
                activeCount={activeFilterCount}
              />
            </div>
            <button
              onClick={() => setAiOnly(v => !v)}
              className={`shrink-0 self-end px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] border-2 border-ink shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base ${
                aiOnly ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
              }`}
            >
              AI Only
            </button>
          </div>

          {outfitTags.length > 0 && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setTagsOpen(v => !v)}
                className="flex items-center gap-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors"
              >
                Tags
                {selectedTags.length > 0 && (
                  <span className="px-1 py-0.5 bg-accent text-accent-on text-[14px] leading-none">
                    {selectedTags.length}
                  </span>
                )}
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
                  className={`transition-transform duration-200 ${tagsOpen || selectedTags.length > 0 ? 'rotate-180' : ''}`}>
                  <path d="M4 5.5L0.5 2h7L4 5.5z" />
                </svg>
              </button>
              <div className={`grid transition-all duration-200 ease-in-out ${
                tagsOpen || selectedTags.length > 0 ? 'grid-rows-[1fr] opacity-100 mt-1.5' : 'grid-rows-[0fr] opacity-0'
              }`}>
                <div className="overflow-hidden">
                  <ChipToggle options={outfitTags} selected={selectedTags} onChange={setSelectedTags} />
                </div>
              </div>
            </div>
          )}

          {showOutfitLoading && <VastraLoader />}

          {error && (
            <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[14px] font-mono uppercase tracking-[0.06em] rounded-base">{error}</div>
          )}

          {!loading && filtered.length === 0 && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <p className="text-[14px] font-mono text-muted uppercase tracking-[0.08em]">
                {outfits.length === 0 ? 'No saved outfits yet.' : 'No outfits matching your filters.'}
              </p>
              {outfits.length === 0 && (
                <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">Go to Closet to create one.</p>
              )}
            </div>
          )}

          {!loading && filtered.length > 0 && (() => {
            const visible = filtered.slice(0, visibleCount)
            const hasMore = visibleCount < filtered.length
            return (
              <>
                <div className={`${CARD_GRID} grid-cols-2 mt-4`}>
                  {visible.map(outfit => (
                    <RevealCard key={outfit.id}>
                      <SavedOutfitCard
                        outfit={outfit}
                        selectable={selectMode}
                        selected={selectMode && selectedIds.has(outfit.id)}
                        onClick={() => selectMode ? toggleSelect(outfit.id) : setDetail(outfit)}
                      />
                    </RevealCard>
                  ))}
                </div>
                {hasMore && (
                  <LoadMoreSentinel key={visibleCount} onVisible={() => setVisibleCount(c => Math.min(c + WINDOW_SIZE, filtered.length))} />
                )}
              </>
            )
          })()}

          {detail && (
            <OutfitDetail
              outfit={detail}
              onClose={() => setDetail(null)}
              onChanged={() => { void refetch(); void refetchCollections() }}
            />
          )}
        </TabFade>
      )}

      {/* ── COLLECTIONS TAB ────────────────────────────────────────────────── */}
      {tab === 'collections' && (
        <TabFade>
          {showColLoading && <VastraLoader />}

          {colError && (
            <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[14px] font-mono uppercase tracking-[0.06em] rounded-base">{colError}</div>
          )}

          {!colLoading && collections.length === 0 && (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <p className="text-[14px] font-mono text-muted uppercase tracking-[0.08em]">No collections yet.</p>
              <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">Group your outfits — summer, work, weddings…</p>
              <button
                onClick={() => setCollectionBuilderOpen(true)}
                className="border-2 border-ink px-4 py-2 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] flex items-center gap-1.5 rounded-base"
              >
                <Plus className="w-3 h-3 shrink-0" strokeWidth={2.5} /> New Collection
              </button>
            </div>
          )}

          {!colLoading && collections.length > 0 && (() => {
            const colTags = [...new Set(collections.flatMap(c => {
              try { return JSON.parse(c.tags || '[]') as string[] } catch { return [] }
            }))].sort()

            const filteredCols = selectedColTag
              ? collections.filter(c => {
                  try { return (JSON.parse(c.tags || '[]') as string[]).includes(selectedColTag) } catch { return false }
                })
              : collections

            const visibleCols = filteredCols.slice(0, visibleColCount)
            const hasMoreCols = visibleColCount < filteredCols.length

            return (
              <>
                {colTags.length > 0 && (
                  <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide mb-4">
                    <button
                      onClick={() => setSelectedColTag('')}
                      className={`shrink-0 px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] border-2 border-ink shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base ${
                        selectedColTag === '' ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
                      }`}
                    >
                      All
                    </button>
                    {colTags.map(tag => (
                      <button
                        key={tag}
                        onClick={() => setSelectedColTag(t => t === tag ? '' : tag)}
                        className={`shrink-0 px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] border-2 border-ink shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] capitalize rounded-base ${
                          selectedColTag === tag ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
                        }`}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}

                <div className={`${CARD_GRID} grid-cols-2`}>
                  {visibleCols.map(col => (
                    <RevealCard key={col.id}>
                    <div className="relative">
                      <CollectionCard
                        collection={col}
                        onClick={() => colSelectMode ? toggleColSelect(col.id) : setCollectionDetail(col.id)}
                        selectable={colSelectMode}
                        selected={selectedColIds.has(col.id)}
                      />
                    </div>
                    </RevealCard>
                  ))}
                </div>
                {hasMoreCols && (
                  <LoadMoreSentinel key={visibleColCount} onVisible={() => setVisibleColCount(c => Math.min(c + WINDOW_SIZE, filteredCols.length))} />
                )}
              </>
            )
          })()}

          {collectionDetail && (
            <CollectionDetail
              collectionId={collectionDetail}
              onClose={() => setCollectionDetail(null)}
              onChanged={refetchCollections}
            />
          )}

          {collectionBuilderOpen && (
            <CollectionBuilder
              onClose={() => setCollectionBuilderOpen(false)}
              onCreated={refetchCollections}
            />
          )}
        </TabFade>
      )}
      </div>

      {/* Bulk add to collection sheet */}
      {bulkAddToCollectionOpen && (
        <AddToCollectionSheet
          outfitIds={[...selectedIds]}
          onClose={() => setBulkAddToCollectionOpen(false)}
          onAdded={() => { setBulkAddToCollectionOpen(false); exitSelectMode(); void refetchCollections() }}
        />
      )}
    </div>
  )
}

function LoadMoreSentinel({ onVisible }: { onVisible: () => void }) {
  const { ref, inView } = useInView({ rootMargin: '400px', triggerOnce: true })
  const prevInView = useRef(false)
  useEffect(() => {
    if (inView && !prevInView.current) onVisible()
    prevInView.current = inView
  }, [inView, onVisible])
  return <div ref={ref} className="h-1" />
}
