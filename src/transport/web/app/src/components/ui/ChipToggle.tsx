export function ChipToggle({ options, selected, onChange }: {
  options: readonly string[]
  selected: string[]
  onChange: (v: string[]) => void
}) {
  function toggle(opt: string) {
    onChange(selected.includes(opt) ? selected.filter(s => s !== opt) : [...selected, opt])
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(opt => (
        <button
          key={opt}
          type="button"
          onClick={() => toggle(opt)}
          className={`px-2.5 py-1 text-[14px] font-bold font-mono uppercase tracking-[0.05em] border-[2px] transition-colors capitalize ${
            selected.includes(opt)
              ? 'bg-accent text-accent-on border-ink'
              : 'bg-paper text-ink border-ink hover:bg-surface-dim'
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}
