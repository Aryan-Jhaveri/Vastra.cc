import { useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import { REMOVE_BUTTON } from './TagEditor'
import { CreatedFacets } from './CreatedFacets'
import { OCCASIONS } from '../../constants/occasions'

interface Props {
  value: string | null | undefined
  onChange: (next: string) => void
}

export function OccasionPicker({ value, onChange }: Props) {
  const current = (value ?? '').toLowerCase()
  const [customInput, setCustomInput] = useState('')
  const [showInput, setShowInput] = useState(false)
  const presetSet = useMemo(() => new Set(OCCASIONS.map(o => o.toLowerCase())), [])

  function pick(next: string) {
    const norm = next.trim().toLowerCase()
    if (!norm) return
    onChange(current === norm ? '' : norm)
  }

  function submitCustom() {
    const next = customInput.trim().toLowerCase()
    if (!next) { setShowInput(false); return }
    onChange(next)
    setCustomInput('')
    setShowInput(false)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* The saved value with an explicit remove (#371); tapping the
          highlighted chip again still clears it too. */}
      {current && (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 border-2 border-ink px-2 py-0.5 text-[14px] font-mono uppercase tracking-[0.06em] capitalize">
            {current}
            <button
              type="button"
              aria-label={`Remove ${current}`}
              onMouseDown={e => e.preventDefault()}
              onClick={() => onChange('')}
              className={REMOVE_BUTTON}
            >
              <X className="w-3 h-3" strokeWidth={2.5} />
            </button>
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {OCCASIONS.map(opt => (
          <button
            key={opt}
            type="button"
            onClick={() => pick(opt)}
            className={`px-2.5 py-1 text-[14px] font-bold font-mono uppercase tracking-[0.05em] border-[2px] transition-colors capitalize ${
              current === opt
                ? 'bg-accent text-accent-on border-ink'
                : 'bg-paper text-ink border-ink hover:bg-surface-dim'
            }`}
          >
            {opt}
          </button>
        ))}
      </div>

      {/* #372 — created occasions: tap to use, Select → delete everywhere. */}
      <CreatedFacets
        kind="occasion"
        current={current ? [current] : []}
        exclude={presetSet}
        onAdd={pick}
        onDeleted={gone => { if (gone.includes(current)) onChange('') }}
      />

      {showInput ? (
        <input
          autoFocus
          value={customInput}
          onChange={e => setCustomInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); submitCustom() }
            else if (e.key === 'Escape') { setCustomInput(''); setShowInput(false) }
          }}
          onBlur={submitCustom}
          placeholder="Add occasion, press Enter"
          maxLength={40}
          className="w-full border-2 border-ink px-3 py-1.5 text-[12px] font-mono outline-none focus:bg-surface-dim placeholder:text-muted placeholder:normal-case"
        />
      ) : (
        <button
          type="button"
          onClick={() => setShowInput(true)}
          className="flex items-center gap-1 self-start border border-dashed border-outline px-2 py-0.5 text-[11px] font-mono text-muted uppercase tracking-[0.04em] hover:border-ink hover:text-ink"
        >
          <Plus className="w-2.5 h-2.5" strokeWidth={2.5} /> Custom
        </button>
      )}
    </div>
  )
}
