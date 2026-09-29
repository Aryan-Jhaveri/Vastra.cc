interface CategoryFilterProps {
  categories: string[]
  value: string[]
  onChange: (categories: string[]) => void
}

export function CategoryFilter({ categories, value, onChange }: CategoryFilterProps) {
  function toggle(cat: string) {
    if (cat === '') { onChange([]); return }
    const next = value.includes(cat)
      ? value.filter(c => c !== cat)
      : [...value, cat]
    onChange(next)
  }

  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide">
      <button
        onClick={() => toggle('')}
        className={`shrink-0 px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] border-2 border-ink transition-colors rounded-base ${
          value.length === 0 ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
        }`}
      >
        All
      </button>
      {categories.map(cat => (
        <button
          key={cat}
          onClick={() => toggle(cat)}
          className={`shrink-0 px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] border-2 border-ink transition-colors capitalize rounded-base ${
            value.includes(cat) ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
          }`}
        >
          {cat}
        </button>
      ))}
    </div>
  )
}
