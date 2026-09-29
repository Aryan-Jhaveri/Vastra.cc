import { useState, useMemo, useEffect } from 'react'
import { CategoryFilter } from './CategoryFilter'
import { FilterBar } from './FilterBar'
import { ChipToggle } from './ui/ChipToggle'
import { parseColors, itemMatchesSearch } from '../lib/search'
import type { Item } from '../api/items'

export interface ItemFilterState {
  categories: string[]
  search: string
  color: string
  season: string
  occasion: string
  brand: string
  types: string[]
  material: string
  tags: string[]
}

export const EMPTY_FILTER_STATE: ItemFilterState = {
  categories: [],
  search: '',
  color: '',
  season: '',
  occasion: '',
  brand: '',
  types: [],
  material: '',
  tags: [],
}

export function isFilterActive(f: ItemFilterState): boolean {
  return (
    f.categories.length > 0 ||
    f.search.trim().length > 0 ||
    !!f.color || !!f.season || !!f.occasion || !!f.brand || !!f.material ||
    f.types.length > 0 || f.tags.length > 0
  )
}

export function applyItemFilters(itemList: Item[], f: ItemFilterState): Item[] {
  return itemList
    .filter(i => !f.categories.length || f.categories.includes(i.category))
    .filter(i => !f.color || parseColors(i).includes(f.color))
    .filter(i => {
      if (!f.season) return true
      try { return (JSON.parse(i.season || '[]') as string[]).includes(f.season) } catch { return false }
    })
    .filter(i => {
      if (!f.occasion) return true
      try {
        const lower = (JSON.parse(i.occasion || '[]') as string[]).map(o => o.toLowerCase())
        return lower.includes(f.occasion.toLowerCase())
      } catch { return false }
    })
    .filter(i => !f.brand || i.brand === f.brand)
    .filter(i => !f.types.length || f.types.includes(i.subcategory ?? ''))
    .filter(i => !f.material || (i.material?.toLowerCase().includes(f.material.toLowerCase()) ?? false))
    .filter(i => !f.tags.length || f.tags.every(t => {
      try { return (JSON.parse(i.tags || '[]') as string[]).map(tag => tag.toLowerCase()).includes(t.toLowerCase()) } catch { return false }
    }))
    .filter(i => itemMatchesSearch(i, f.search))
}

const SEASONS = ['fall', 'spring', 'summer', 'winter']
const ci = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase())

interface ItemFilterControlsProps {
  allItems: Item[]
  value: ItemFilterState
  onChange: (patch: Partial<ItemFilterState>) => void
  onClear: () => void
  showSearch?: boolean
}

export function ItemFilterControls({
  allItems,
  value,
  onChange,
  onClear,
  showSearch = true,
}: ItemFilterControlsProps) {
  const [tagsOpen, setTagsOpen] = useState(false)
  const [typesOpen, setTypesOpen] = useState(false)
  const [firstOpened, setFirstOpened] = useState<'tags' | 'types' | null>(null)

  const categories = useMemo(
    () => [...new Set(allItems.map(i => i.category))].sort(ci),
    [allItems],
  )
  const colors = useMemo(
    () => [...new Set(allItems.flatMap(i => parseColors(i)))].sort(ci),
    [allItems],
  )
  const brands = useMemo(
    () => [...new Set(allItems.map(i => i.brand).filter(Boolean) as string[])].sort(ci),
    [allItems],
  )
  const typeOptions = useMemo(
    () => [...new Set(allItems.map(i => i.subcategory).filter(Boolean) as string[])].sort(ci),
    [allItems],
  )
  const materials = useMemo(
    () => [...new Set(allItems.map(i => i.material).filter(Boolean) as string[])].sort(ci),
    [allItems],
  )
  const allTags = useMemo(() => {
    const tagSet = new Set<string>()
    allItems.forEach(i => {
      try { (JSON.parse(i.tags || '[]') as string[]).forEach(t => tagSet.add(t.trim().toLowerCase())) } catch { /* ignore */ }
    })
    return [...tagSet].sort(ci)
  }, [allItems])

  const occasionOptions = useMemo(() => {
    const occSet = new Set<string>()
    allItems.forEach(i => {
      try { (JSON.parse(i.occasion || '[]') as string[]).forEach(o => occSet.add(o.trim().toLowerCase())) } catch { /* ignore */ }
    })
    return [...occSet].filter(Boolean).sort(ci)
  }, [allItems])

  const filterValues = {
    color: value.color,
    season: value.season,
    occasion: value.occasion,
    brand: value.brand,
    material: value.material,
  }
  const filterConfigs = [
    ...(colors.length > 0 ? [{ key: 'color', label: 'Color', options: colors }] : []),
    { key: 'season', label: 'Season', options: SEASONS },
    { key: 'occasion', label: 'Occasion', options: occasionOptions },
    ...(brands.length > 0 ? [{ key: 'brand', label: 'Brand', options: brands }] : []),
    ...(materials.length > 0 ? [{ key: 'material', label: 'Material', options: materials }] : []),
  ]
  const activeDropdownCount = [value.color, value.season, value.occasion, value.brand, value.material, ...value.types, ...value.tags].filter(Boolean).length

  const tagsOpenEffective = tagsOpen || value.tags.length > 0
  const typesOpenEffective = typesOpen || value.types.length > 0
  const showChipRow = allTags.length > 0 || typeOptions.length > 0

  useEffect(() => {
    if (!tagsOpenEffective && !typesOpenEffective) {
      if (firstOpened !== null) setFirstOpened(null)
      return
    }
    if (firstOpened === null) {
      setFirstOpened(tagsOpenEffective ? 'tags' : 'types')
      return
    }
    const firstStillOpen = firstOpened === 'tags' ? tagsOpenEffective : typesOpenEffective
    if (!firstStillOpen) {
      setFirstOpened(firstOpened === 'tags' ? 'types' : 'tags')
    }
  }, [tagsOpenEffective, typesOpenEffective, firstOpened])

  return (
    <div className="flex flex-col gap-3">
      {showSearch && (
        <input
          type="search"
          placeholder="Search items..."
          value={value.search}
          onChange={e => onChange({ search: e.target.value })}
          className="w-full mt-2 border-2 border-ink px-3 py-2 text-[14px] font-mono focus:outline-none placeholder:text-muted bg-paper text-ink rounded-base"
        />
      )}

      {categories.length > 0 && (
        <CategoryFilter
          categories={categories}
          value={value.categories}
          onChange={cats => onChange({ categories: cats })}
        />
      )}

      {filterConfigs.length > 0 && (
        <FilterBar
          filters={filterConfigs}
          values={filterValues}
          onChange={(key, val) => onChange({ [key]: val })}
          onClear={onClear}
          activeCount={activeDropdownCount}
        />
      )}

      {showChipRow && (
        <div className="flex flex-col gap-0">
          {/* Default: buttons side-by-side. Expanded: each header stacks above its own chips. */}
          {!tagsOpenEffective && !typesOpenEffective ? (
            // Neither open — side by side
            <div className="flex gap-4">
              {allTags.length > 0 && (
                <button
                  type="button"
                  onClick={() => setTagsOpen(true)}
                  className="flex items-center gap-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors"
                >
                  Tags
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                    <path d="M4 5.5L0.5 2h7L4 5.5z" />
                  </svg>
                </button>
              )}
              {typeOptions.length > 0 && (
                <button
                  type="button"
                  onClick={() => setTypesOpen(true)}
                  className="flex items-center gap-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors"
                >
                  Type
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                    <path d="M4 5.5L0.5 2h7L4 5.5z" />
                  </svg>
                </button>
              )}
            </div>
          ) : (
            // At least one open — whichever was tapped last sits on top with its chips,
            // the other sits below.
            (() => {
              const tagsSection = allTags.length > 0 ? (
                <div key="tags" className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => setTagsOpen(v => !v)}
                    className="flex items-center gap-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors self-start"
                  >
                    Tags
                    {value.tags.length > 0 && (
                      <span className="px-1 py-0.5 bg-accent text-accent-on text-[14px] leading-none">
                        {value.tags.length}
                      </span>
                    )}
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
                      className={`transition-transform duration-200 ${tagsOpenEffective ? 'rotate-180' : ''}`}>
                      <path d="M4 5.5L0.5 2h7L4 5.5z" />
                    </svg>
                  </button>
                  <div className={`grid transition-all duration-200 ease-in-out ${
                    tagsOpenEffective ? 'grid-rows-[1fr] opacity-100 mt-1 mb-3' : 'grid-rows-[0fr] opacity-0 mt-0 mb-1'
                  }`}>
                    <div className="overflow-hidden">
                      <ChipToggle options={allTags} selected={value.tags} onChange={next => onChange({ tags: next })} />
                    </div>
                  </div>
                </div>
              ) : null

              const typesSection = typeOptions.length > 0 ? (
                <div key="types" className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => setTypesOpen(v => !v)}
                    className="flex items-center gap-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.1em] text-muted hover:text-ink transition-colors self-start"
                  >
                    Type
                    {value.types.length > 0 && (
                      <span className="px-1 py-0.5 bg-accent text-accent-on text-[14px] leading-none">
                        {value.types.length}
                      </span>
                    )}
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"
                      className={`transition-transform duration-200 ${typesOpenEffective ? 'rotate-180' : ''}`}>
                      <path d="M4 5.5L0.5 2h7L4 5.5z" />
                    </svg>
                  </button>
                  <div className={`grid transition-all duration-200 ease-in-out ${
                    typesOpenEffective ? 'grid-rows-[1fr] opacity-100 mt-1 mb-3' : 'grid-rows-[0fr] opacity-0 mt-0'
                  }`}>
                    <div className="overflow-hidden">
                      <ChipToggle options={typeOptions} selected={value.types} onChange={next => onChange({ types: next })} />
                    </div>
                  </div>
                </div>
              ) : null

              return firstOpened === 'types'
                ? <>{typesSection}{tagsSection}</>
                : <>{tagsSection}{typesSection}</>
            })()
          )}
        </div>
      )}
    </div>
  )
}
