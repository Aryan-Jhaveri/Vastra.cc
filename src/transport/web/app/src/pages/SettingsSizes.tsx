import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { InlineField } from '../components/ui/InlineField'
import { ItemCard } from '../components/ItemCard'
import { useSettings } from '../hooks/useSettings'
import { fetchItems, updateItem, type Item } from '../api/items'
import { CARD_GRID } from '../constants/grid'
import {
  PRIMARY_SIZE_CATEGORIES,
  EXTRA_SIZE_CATEGORIES,
  MAX_SIZE_LENGTH,
  sizeCategoryLabel,
} from '../constants/sizes'

// Settings › Sizes (#329): the user's own size per category, the existing
// per-item `size` field in one list, and the "Use my sizes in Ask" toggle.
// Sizes are personal data — nothing here is sent to analytics.

const SECTION_LABEL = 'text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted mt-6 mb-2 pb-1 border-b border-outline-variant'
const PAGE_SIZE = 100
const MAX_PAGES = 20

/** Every item card, paged through the existing `GET /api/items?cards=true`. */
async function fetchAllItemCards(): Promise<Item[]> {
  const all: Item[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchItems({ cards: true, limit: PAGE_SIZE, page })
    all.push(...res.items)
    if (res.items.length < PAGE_SIZE || all.length >= res.total) break
  }
  return all
}

type SizeFilter = 'all' | 'with' | 'without'
const SIZE_FILTERS: Array<{ value: SizeFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'with', label: 'With size' },
  { value: 'without', label: 'Without size' },
]

function hasSize(item: Item): boolean {
  return !!item.size && item.size.trim().length > 0
}

export function SettingsSizes() {
  const navigate = useNavigate()
  const { settings, loading: settingsLoading, update } = useSettings()
  const sizes = settings.userSizes ?? {}
  const agentContextOn = settings.sizesAgentContext !== false

  const [showExtra, setShowExtra] = useState(false)
  const [toggleSaving, setToggleSaving] = useState(false)
  const [toggleError, setToggleError] = useState(false)

  const [items, setItems] = useState<Item[]>([])
  const [itemsLoading, setItemsLoading] = useState(true)
  const [itemsError, setItemsError] = useState(false)
  const [sizeFilter, setSizeFilter] = useState<SizeFilter>('all')
  const [editingItemId, setEditingItemId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchAllItemCards()
      .then(rows => { if (!cancelled) setItems(rows) })
      .catch(() => { if (!cancelled) setItemsError(true) })
      .finally(() => { if (!cancelled) setItemsLoading(false) })
    return () => { cancelled = true }
  }, [])

  // Extra categories stay hidden unless revealed or already filled in.
  const categories = useMemo(() => [
    ...PRIMARY_SIZE_CATEGORIES,
    ...EXTRA_SIZE_CATEGORIES.filter(c => showExtra || sizes[c]),
  ], [showExtra, sizes])
  const hiddenCount = EXTRA_SIZE_CATEGORIES.filter(c => !showExtra && !sizes[c]).length

  const setCount = items.filter(hasSize).length
  const missingCount = items.length - setCount
  // Strict (#369): a list never mixes sized and unsized items. The item being
  // edited stays reachable in the edit panel above the grid.
  const visibleItems = sizeFilter === 'all' ? items : items.filter(i => hasSize(i) === (sizeFilter === 'with'))
  const filterCounts: Record<SizeFilter, number> = { all: items.length, with: setCount, without: missingCount }
  const editingItem = editingItemId ? items.find(i => i.id === editingItemId) ?? null : null

  async function saveUserSize(category: string, next: string) {
    const value = next.trim()
    if (value === (sizes[category] ?? '')) return
    await update({ userSizes: { [category]: value } })
  }

  async function toggleAgentContext() {
    if (toggleSaving || settingsLoading) return
    setToggleSaving(true)
    setToggleError(false)
    try {
      await update({ sizesAgentContext: !agentContextOn })
    } catch {
      setToggleError(true)
    } finally {
      setToggleSaving(false)
    }
  }

  // Same PATCH /api/items/:id { size } path ItemDetail uses.
  async function saveItemSize(item: Item, next: string) {
    const value = next.trim()
    if (value !== (item.size ?? '')) {
      const updated = await updateItem(item.id, { size: value || null })
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, size: updated.size ?? null } : i)))
    }
    // Only close if the user hasn't already tapped another item (blur saves).
    setEditingItemId(cur => (cur === item.id ? null : cur))
  }

  return (
    <div className="flex flex-col p-4 pb-20">
      <button
        onClick={() => navigate('/settings')}
        className="flex items-center gap-2 mb-4 text-muted hover:text-ink transition-colors"
      >
        <ArrowLeft className="w-4 h-4" />
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Settings</span>
      </button>

      <PageHeader title="Sizes." hideEmptySubtitle={true} />
      <div className="mb-4" />

      {/* Agent context toggle */}
      <div className="border-2 border-ink rounded-base p-4 bg-surface flex items-start gap-3">
        <div className="flex-1">
          <p className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Use my sizes in Ask</p>
          <p className="text-sm font-mono text-muted leading-relaxed mt-1">
            {toggleError
              ? "Couldn't save. Try again."
              : 'The assistant reads these to answer fit questions and flag shop items in your size. Never sent to stores.'}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={agentContextOn}
          aria-label="Use my sizes in Ask"
          onClick={() => void toggleAgentContext()}
          disabled={toggleSaving || settingsLoading}
          className={`shrink-0 border-2 border-ink rounded-base px-2 py-1 text-[12px] font-bold font-mono uppercase tracking-[0.08em] transition-colors disabled:opacity-50 ${
            agentContextOn ? 'bg-accent text-accent-on shadow-flat-xs' : 'bg-paper text-ink hover:bg-surface-dim'
          }`}
        >
          {agentContextOn ? 'On' : 'Off'}
        </button>
      </div>

      {/* My sizes */}
      <p className={SECTION_LABEL}>My sizes</p>
      {categories.map(category => (
        <div key={category} className="border-b border-outline-variant py-3">
          <InlineField
            label={sizeCategoryLabel(category)}
            value={sizes[category] ?? null}
            onSave={next => saveUserSize(category, next)}
            maxLength={MAX_SIZE_LENGTH}
            placeholder="e.g. M, 32 × 30, US 10"
            valueClassName="text-sm font-mono"
          />
        </div>
      ))}
      {hiddenCount > 0 && (
        <button
          onClick={() => setShowExtra(true)}
          className="border-b border-outline-variant py-3 flex items-center justify-between w-full text-left hover:bg-surface-dim transition-colors text-muted"
        >
          <p className="text-[14px] font-mono uppercase tracking-[0.06em]">+ Add a size</p>
        </button>
      )}

      {/* Sizes on your items */}
      <p className={SECTION_LABEL}>
        Sizes on your items{!itemsLoading && !itemsError && ` · ${setCount} of ${items.length} set`}
      </p>

      {itemsLoading && <p className="text-[14px] font-mono text-muted py-3">Loading items…</p>}
      {itemsError && <p className="text-[14px] font-mono text-error py-3">Couldn't load your items.</p>}
      {!itemsLoading && !itemsError && items.length === 0 && (
        <p className="text-[14px] font-mono text-muted py-3">No items in your closet yet.</p>
      )}

      {editingItem && (
        <div className="border-2 border-ink rounded-base p-3 bg-paper shadow-flat-xs mb-3">
          <InlineField
            key={editingItem.id}
            label={`Size · ${editingItem.subcategory ?? editingItem.category}${editingItem.brand ? ` · ${editingItem.brand}` : ''}`}
            value={editingItem.size}
            onSave={next => saveItemSize(editingItem, next)}
            maxLength={100}
            placeholder="e.g. M"
            valueClassName="text-sm font-mono"
            startEditing
          />
        </div>
      )}

      {!itemsLoading && !itemsError && items.length > 0 && (
        <div role="radiogroup" aria-label="Filter items by size" className="flex border-2 border-ink mb-3">
          {SIZE_FILTERS.map(f => (
            <button
              key={f.value}
              role="radio"
              aria-checked={sizeFilter === f.value}
              onClick={() => setSizeFilter(f.value)}
              className={`flex-1 min-h-[44px] px-2 text-[12px] font-bold font-mono uppercase tracking-[0.06em] transition-colors ${
                sizeFilter === f.value ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
              }`}
            >
              {f.label} · {filterCounts[f.value]}
            </button>
          ))}
        </div>
      )}

      {!itemsLoading && !itemsError && items.length > 0 && visibleItems.length === 0 && (
        <p className="text-[14px] font-mono text-muted py-3">
          {sizeFilter === 'without' ? 'Every item has a size.' : 'No items have a size yet.'}
        </p>
      )}

      {visibleItems.length > 0 && (
        <div className={`${CARD_GRID} grid-cols-3`}>
          {visibleItems.map(item => (
            <div key={item.id} className="relative" data-testid={`size-item-${item.id}`}>
              <ItemCard
                item={item}
                selected={item.id === editingItemId}
                onClick={() => setEditingItemId(item.id)}
              />
              {hasSize(item) ? (
                <span className="absolute top-1.5 left-1.5 z-20 bg-paper border-2 border-ink rounded-base px-1 text-[11px] font-bold font-mono">
                  {item.size}
                </span>
              ) : (
                <span className="absolute top-1.5 left-1.5 z-20 bg-paper border-2 rounded-base px-1 text-[11px] font-bold font-mono text-muted border-outline-variant">
                  No size
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {!itemsLoading && !itemsError && items.length > 0 && (
        <p className="text-[12px] font-mono text-muted mt-2">Tap an item to edit its size — same field as in item details.</p>
      )}
    </div>
  )
}
