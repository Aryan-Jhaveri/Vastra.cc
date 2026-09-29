import { FilterDropdown } from './ui/FilterDropdown'

interface FilterConfig {
  key: string
  label: string
  options: string[]
}

interface FilterBarProps {
  filters: FilterConfig[]
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  onClear: () => void
  activeCount: number
}

export function FilterBar({ filters, values, onChange, onClear, activeCount }: FilterBarProps) {
  return (
    <div className="flex flex-wrap gap-2 items-end">
      {filters.map(f => (
        <FilterDropdown
          key={f.key}
          label={f.label}
          options={f.options}
          value={values[f.key] ?? ''}
          onChange={v => onChange(f.key, v)}
        />
      ))}
      {activeCount > 0 && (
        <button
          onClick={onClear}
          className="shrink-0 self-end pb-1.5 text-[14px] font-mono text-muted uppercase tracking-[0.06em] hover:text-ink transition-colors"
        >
          × Clear
        </button>
      )}
    </div>
  )
}
