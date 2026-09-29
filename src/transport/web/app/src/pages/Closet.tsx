import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { X, Plus, Heart } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useItemCache } from '../context/ItemCacheContext'
import { fetchItems, deleteItem } from '../api/items'
import { ItemCard } from '../components/ItemCard'
import { ItemFilterControls, EMPTY_FILTER_STATE, applyItemFilters, isFilterActive } from '../components/ItemFilterControls'
import type { ItemFilterState } from '../components/ItemFilterControls'
import { PageHeader } from '../components/PageHeader'
import { AddItemFlow } from '../modals/AddItemFlow'
import { ItemDetail } from '../modals/ItemDetail'
import { OutfitSaveModal } from '../modals/OutfitSaveModal'
import { Spinner } from '../components/ui/Spinner'
import { VastraLoader } from '../components/ui/VastraLoader'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import { useShopEnabled } from '../hooks/useShopEnabled'
import { track } from '../lib/analytics'
import { usePageReset } from '../context/PageResetContext'
import { CARD_GRID } from '../constants/grid'
import type { Item } from '../api/items'

const PAGE_SIZE = 12

export function Closet() {
  const navigate = useNavigate()
  const shopEnabled = useShopEnabled()
  const [filters, setFilters] = useState<ItemFilterState>(EMPTY_FILTER_STATE)
  const [addOpen, setAddOpen] = useState(false)
  const [selected, setSelected] = useState<Item | null>(null)

  // Select mode
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showOutfitSave, setShowOutfitSave] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressedRef = useRef(false)
  const filterDebounceRef = useRef<ReturnType<typeof setTimeout>>()

  const { resetKeys } = usePageReset()
  const closetResetKey = resetKeys.closet
  const initialResetKey = useRef(closetResetKey)
  const resetAllState = useCallback(() => {
    setFilters(EMPTY_FILTER_STATE)
    setAddOpen(false)
    setSelected(null)
    setSelectMode(false)
    setSelectedIds(new Set())
    setShowOutfitSave(false)
    setConfirmDelete(false)
    setReloadKey(k => k + 1)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }, []) // setReloadKey is a stable setter
  useEffect(() => {
    if (closetResetKey === initialResetKey.current) return
    resetAllState()
  }, [closetResetKey, resetAllState])

  // Infinite scroll state (server-side filtered, no search)
  const [accItems, setAccItems] = useState<Item[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const hasMoreRef = useRef(false)
  loadingRef.current = loading
  hasMoreRef.current = accItems.length < total

  // Stable key for non-search filters (server-side)
  const filterDep = [
    filters.categories.join(','),
    filters.color, filters.season, filters.occasion, filters.brand, filters.material,
    filters.tags.join(','),
    reloadKey,
  ].join('|')

  // Reset paginator when server-side filters change
  useEffect(() => {
    setAccItems([])
    setTotal(0)
    setPage(1)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterDep])

  // Fetch on page or filter change
  useEffect(() => {
    let cancelled = false
    const p = page
    setLoading(true)
    void fetchItems({
      categories: filters.categories.length ? filters.categories : undefined,
      color: filters.color || undefined,
      season: filters.season || undefined,
      occasion: filters.occasion || undefined,
      brand: filters.brand || undefined,
      material: filters.material || undefined,
      tags: filters.tags.length ? filters.tags : undefined,
      page: p,
      limit: PAGE_SIZE,
      cards: true,
    }).then(result => {
      if (!cancelled) {
        setTotal(result.total)
        setAccItems(prev => p === 1 ? result.items : [...prev, ...result.items])
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filterDep])

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !loadingRef.current && hasMoreRef.current) {
        setPage(p => p + 1)
      }
    }, { rootMargin: '300px' })
    observer.observe(sentinel)
    return () => observer.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accItems.length])

  async function refetch() {
    setAccItems([])
    setTotal(0)
    await refetchAll()
    if (page === 1) setReloadKey(k => k + 1)
    else setPage(1)
  }

  // allItems: for deriving filter options + search + select mode
  const { items: allItems, refetch: refetchAll } = useItemCache()

  const selectedItems = useMemo(
    () => allItems.filter(i => selectedIds.has(i.id)),
    [allItems, selectedIds],
  )

  // When search or multi-type is active, use client-side filtered allItems instead of paginated results
  const searchActive = filters.search.trim().length > 0
  const typesActive = filters.types.length > 0
  const clientMode = searchActive || typesActive
  const clientResults = useMemo(
    () => clientMode ? applyItemFilters(allItems, filters) : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clientMode, allItems, filters.search, filters.categories.join(','), filters.color, filters.season, filters.occasion, filters.brand, filters.types.join(','), filters.material, filters.tags.join(',')],
  )

  const showLoading = useDelayedLoading(loading && !clientMode)

  const displayItems = clientMode ? clientResults : accItems
  const displayTotal = clientMode ? clientResults.length : total

  function clearDropdownFilters() {
    setFilters(prev => ({
      ...prev,
      color: '', season: '', occasion: '', brand: '', material: '', types: [], tags: [],
    }))
  }

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
    setConfirmDelete(false)
  }

  const prevSelSizeRef = useRef(0)
  useEffect(() => {
    if (selectMode && selectedIds.size === 0 && prevSelSizeRef.current > 0) {
      setSelectMode(false)
    }
    prevSelSizeRef.current = selectedIds.size
  }, [selectMode, selectedIds.size])

  function handlePointerDown(item: Item) {
    longPressedRef.current = false
    holdTimerRef.current = setTimeout(() => {
      longPressedRef.current = true
      setSelectMode(true)
      setSelectedIds(prev => new Set([...prev, item.id]))
    }, 500)
  }

  function cancelHold() {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }

  function handleItemClick(item: Item) {
    if (longPressedRef.current) {
      longPressedRef.current = false
      return
    }
    selectMode ? toggleSelect(item.id) : setSelected(item)
  }

  async function handleDeleteSelected() {
    setDeleting(true)
    try {
      await Promise.all([...selectedIds].map(id => deleteItem(id)))
      exitSelectMode()
      refetch()
    } catch { /* ignore */ }
    finally { setDeleting(false) }
  }

  return (
    <div className="flex flex-col pb-20">
      <div className="sticky top-0 z-20 bg-paper px-4 pt-4 pb-3 flex flex-col gap-2">
      <PageHeader
        title="Closet"
        subtitle={
          selectMode
            ? (selectedIds.size > 0 ? `${selectedIds.size} selected` : 'select items')
            : `${displayTotal} ${displayTotal === 1 ? 'item' : 'items'}`
        }
        right={selectMode ? (
          <div className="flex gap-2">
            {confirmDelete ? (
              <>
                <button
                  onClick={() => void handleDeleteSelected()}
                  disabled={deleting}
                  className="border-2 border-error text-error px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-50 rounded-base"
                >
                  {deleting ? '...' : `Delete ${selectedIds.size}`}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => setShowOutfitSave(true)}
                  disabled={selectedIds.size < 2}
                  className="bg-accent text-accent-on border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-30 rounded-base"
                >
                  Outfit
                </button>
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={selectedIds.size === 0}
                  className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-30 rounded-base"
                >
                  Delete
                </button>
                <button
                  onClick={exitSelectMode}
                  className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] flex items-center gap-1 rounded-base"
                >
                  <X className="w-3 h-3" strokeWidth={2.5} /> Cancel
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="flex gap-2">
            {shopEnabled && (
              <button
                onClick={() => navigate('/closet/liked')}
                className="border-2 border-ink w-9 h-9 flex items-center justify-center hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow] rounded-base"
                aria-label="Liked items"
              >
                <Heart className="w-4 h-4" strokeWidth={2} />
              </button>
            )}
            <button
              onClick={() => setSelectMode(true)}
              className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.04em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow] rounded-base"
            >
              Select
            </button>
            <button
              onClick={() => setAddOpen(true)}
              className="bg-accent text-accent-on border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.04em] shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow] rounded-base flex items-center gap-1.5"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" strokeWidth={2.5} /> Add
            </button>
          </div>
        )}
      />

      {/* Selected items carousel — only in select mode */}
      {selectMode && (
        <div className="border-2 border-ink py-1.5 px-2 rounded-base">
          {selectedItems.length === 0 ? (
            <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">
              Tap items below to select
            </p>
          ) : (
            <div className="flex gap-2 overflow-x-auto py-1.5">
              {selectedItems.map(item => (
                <div key={item.id} className="relative shrink-0">
                  <img
                    src={`/${item.imageUri}`}
                    alt={item.subcategory ?? item.category}
                    className="w-14 h-14 object-cover border-2 border-ink rounded-base"
                  />
                  <button
                    onClick={() => toggleSelect(item.id)}
                    className="absolute -top-1 -right-1 w-4 h-4 bg-accent text-accent-on flex items-center justify-center border border-ink"
                  >
                    <X className="w-2.5 h-2.5" strokeWidth={2.5} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      <div className="flex flex-col px-4 pt-2">
      <ItemFilterControls
        allItems={allItems}
        value={filters}
          onChange={patch => {
            setFilters(prev => ({ ...prev, ...patch }))
            clearTimeout(filterDebounceRef.current)
            filterDebounceRef.current = setTimeout(() => track('filter_applied'), 800)
          }}
        onClear={clearDropdownFilters}
        showSearch
      />

      {!loading && displayItems.length === 0 && (
        <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] text-center py-10">
          {isFilterActive(filters)
            ? 'No items matching your filters.'
            : 'Your closet is empty. Add your first item!'}
        </p>
      )}

      <div className={`${CARD_GRID} grid-cols-3 animate-grid-in`}>
        {displayItems.map(item => (
          <div
            key={item.id}
            onPointerDown={() => handlePointerDown(item)}
            onPointerUp={cancelHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
          >
            <ItemCard
              item={item}
              selectable={selectMode}
              selected={selectMode && selectedIds.has(item.id)}
              onClick={() => handleItemClick(item)}
            />
          </div>
        ))}
        {!selectMode && (
          <button
            onClick={() => setAddOpen(true)}
            className="relative overflow-hidden border-2 border-dashed border-muted text-left transition-colors w-full hover:border-ink rounded-base"
          >
            <div className="aspect-[3/4] flex flex-col items-center justify-center gap-1 bg-surface-dim border-b-2 border-ink">
              <Plus className="w-5 h-5 text-muted" />
              <span className="text-[14px] font-mono font-bold uppercase tracking-[0.08em] text-muted">Add</span>
            </div>
            <div className="p-2 min-h-[3rem]" />
          </button>
        )}
      </div>

      {/* Infinite scroll sentinel — only when not in search mode */}
      {!clientMode && <div ref={sentinelRef} className="h-1" />}

      {showLoading && <VastraLoader />}
      {loading && !clientMode && displayItems.length > 0 && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}
      </div>

      {addOpen && (
        <AddItemFlow
          mode="closet-add"
          onClose={() => setAddOpen(false)}
          onSaved={(count) => { setAddOpen(false); if (count > 0) refetch() }}
        />
      )}

      {selected && (
        <ItemDetail
          item={selected}
          onClose={() => setSelected(null)}
          onChanged={() => refetch()}
        />
      )}

      {showOutfitSave && (
        <OutfitSaveModal
          items={selectedItems}
          onClose={() => setShowOutfitSave(false)}
          onSaved={() => {
            setShowOutfitSave(false)
            exitSelectMode()
          }}
        />
      )}
    </div>
  )
}
