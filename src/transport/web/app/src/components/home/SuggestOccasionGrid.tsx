import { useState, useEffect, useCallback } from 'react'
import { getOccasions } from '../../api/suggestOccasions'

const SELECTED_KEY = 'suggest-selected-occasion'

const PRESET_LABELS: Record<string, string> = {
  casual: 'Casual',
  work: 'Work',
  formal: 'Formal',
  outdoor: 'Outdoor',
  date: 'Date',
}

interface Props {
  selected: string | null
  onSelect: (value: string | null) => void
}

export function SuggestOccasionGrid({ selected, onSelect }: Props) {
  const [derived, setDerived] = useState<string[]>([])
  const [presets, setPresets] = useState<string[]>([])

  const fetchOccasions = useCallback(async () => {
    try {
      const data = await getOccasions()
      setPresets(data.presets)
      setDerived(data.derived)
    } catch { /* silent */ }
  }, [])

  useEffect(() => {
    fetchOccasions()
  }, [fetchOccasions])

  function toggleChip(value: string) {
    if (selected === value) {
      sessionStorage.removeItem(SELECTED_KEY)
      onSelect(null)
    } else {
      sessionStorage.setItem(SELECTED_KEY, value)
      onSelect(value)
    }
  }

  const chipClass = (isSelected: boolean, isDashed: boolean) =>
    [
      'border-2 border-ink text-[14px] font-bold font-mono uppercase tracking-[0.08em] py-2 px-3 rounded-base',
      'shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none',
      'transition-[transform,box-shadow,colors]',
      isDashed ? 'border-dashed' : 'border-solid',
      isSelected ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim',
    ].join(' ')

  if (presets.length === 0) return null

  return (
    <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
      {presets.map(p => {
        const label = PRESET_LABELS[p] ?? p.charAt(0).toUpperCase() + p.slice(1)
        return (
          <button key={p} onClick={() => toggleChip(p)} className={`shrink-0 ${chipClass(selected === p, false)}`}>
            {label}
          </button>
        )
      })}
      {derived.map(value => {
        const label = value.charAt(0).toUpperCase() + value.slice(1)
        return (
          <button
            key={value}
            onClick={() => toggleChip(value)}
            className={`shrink-0 ${chipClass(selected === value, true)}`}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

export { SELECTED_KEY }
