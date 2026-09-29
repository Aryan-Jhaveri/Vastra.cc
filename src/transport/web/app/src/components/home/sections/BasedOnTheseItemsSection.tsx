import { useState, useMemo, useEffect, useRef } from 'react'
import { X, ChevronDown, ChevronRight } from 'lucide-react'
import { Spinner } from '../../ui/Spinner'
import { OutfitSaveModal } from '../../../modals/OutfitSaveModal'
import { useItemCache } from '../../../context/ItemCacheContext'
import { getImageSrc, thumbUri } from '../../../api/client'
import type { Item } from '../../../api/items'

interface Props {
  items: Item[] | null
  phase: string
  onItemClick?: (id: string) => void
}

const COLLAPSE_KEY = 'suggest-section-state'

function getCollapsed(): boolean {
  try {
    const raw = sessionStorage.getItem(COLLAPSE_KEY)
    if (raw) return (JSON.parse(raw) as { shortlist?: boolean }).shortlist ?? false
  } catch {}
  return false
}

function saveCollapse(val: boolean) {
  try {
    const raw = sessionStorage.getItem(COLLAPSE_KEY)
    const state = raw ? JSON.parse(raw) as Record<string, boolean> : {}
    state.shortlist = val
    sessionStorage.setItem(COLLAPSE_KEY, JSON.stringify(state))
  } catch {}
}

export function BasedOnTheseItemsSection({ items, phase, onItemClick }: Props) {
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showOutfitSave, setShowOutfitSave] = useState(false)
  const [collapsed, setCollapsed] = useState(getCollapsed)
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressedRef = useRef(false)

  const { items: allItems } = useItemCache()
  const allItemMap = useMemo(() => new Map(allItems.map(i => [i.id, i])), [allItems])

  const selectedItems = useMemo(
    () => [...selectedIds].map(id => allItemMap.get(id)).filter((i): i is Item => Boolean(i)),
    [selectedIds, allItemMap],
  )

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitSelectMode() {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const prevSelSizeRef = useRef(0)
  useEffect(() => {
    if (selectMode && selectedIds.size === 0 && prevSelSizeRef.current > 0) {
      setSelectMode(false)
    }
    prevSelSizeRef.current = selectedIds.size
  }, [selectMode, selectedIds.size])

  function handlePointerDown(id: string) {
    longPressedRef.current = false
    holdTimerRef.current = setTimeout(() => {
      longPressedRef.current = true
      setSelectMode(true)
      setSelectedIds(new Set([id]))
    }, 500)
  }

  function cancelHold() {
    if (holdTimerRef.current) {
      clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
  }

  function handleItemClick(id: string) {
    if (longPressedRef.current) {
      longPressedRef.current = false
      return
    }
    selectMode ? toggleSelect(id) : onItemClick?.(id)
  }

  if (!items || items.length === 0) {
    if (phase === 'shortlisting') {
      return (
        <div>
          <div className="flex items-center justify-start gap-2 py-2">
            <Spinner />
            <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">Finding items…</span>
          </div>
        </div>
      )
    }
    return null
  }

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center justify-between mb-2 border-b-2 border-ink pb-2">
        <button
          onClick={() => { const next = !collapsed; setCollapsed(next); saveCollapse(next) }}
          className="flex items-center gap-1 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:text-muted transition-colors"
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          BASED ON THESE ITEMS
        </button>
        <div className="flex items-center gap-2">
          {selectMode ? (
            <>
              <button
                onClick={() => setShowOutfitSave(true)}
                disabled={selectedIds.size < 2}
                className="bg-accent text-accent-on border-2 border-ink px-2 py-1 text-[14px] font-bold font-sans uppercase tracking-[0.08em] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-30 rounded-base"
              >
                Outfit
              </button>
              <button
                onClick={exitSelectMode}
                className="border-2 border-ink px-2 py-1 text-[14px] font-bold font-sans uppercase tracking-[0.08em] hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] flex items-center gap-1 rounded-base"
              >
                <X className="w-3 h-3" strokeWidth={2.5} /> Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setSelectMode(true)}
              className="border-2 border-ink px-2 py-1 text-[14px] font-bold font-sans uppercase tracking-[0.04em] hover:bg-surface-dim active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow] rounded-base"
            >
              Select
            </button>
          )}
        </div>
      </div>

      {!collapsed && (
        <>
          {/* Selected items carousel */}
          {selectMode && (
        <div className="border-2 border-ink p-2 mb-2 rounded-base">
          {selectedItems.length === 0 ? (
            <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">
              Tap items below to select
            </p>
          ) : (
            <div className="flex gap-2 overflow-x-auto py-1.5">
              {selectedItems.map(item => (
                <div key={item.id} className="relative shrink-0">
                  <img
                    src={getImageSrc(item.imageUri)}
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

      {/* Item grid — 5 columns for 20-item window */}
      <div className="grid grid-cols-5 gap-1.5">
        {items.map(item => {
          const isSelected = selectedIds.has(item.id)
          const cardClass = selectMode
            ? (isSelected
              ? 'border-transparent bg-surface-dim animate-border-march'
              : 'border-ink overflow-hidden')
            : 'border-ink overflow-hidden hover:border-outline-variant'
          return (
            <button
              key={item.id}
              onPointerDown={() => handlePointerDown(item.id)}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              onPointerCancel={cancelHold}
              onClick={() => handleItemClick(item.id)}
              className={`relative aspect-[4/5] border-2 bg-surface-dim transition-colors rounded-base ${cardClass}`}
            >
              <img
                src={getImageSrc(item.imageUri)}
                alt={item.category}
                className="w-full h-full object-cover"
              />
            </button>
          )
        })}
      </div>
      </>
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
