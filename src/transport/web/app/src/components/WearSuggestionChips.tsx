import type { WearSuggestion } from '../api/tryon'

/** The instruction a chip puts in the Refine box, always naming its garment. */
export function chipInstruction(chip: WearSuggestion): string {
  if (!chip.itemLabel || chip.instruction.toLowerCase().includes(chip.itemLabel.toLowerCase())) return chip.instruction
  return `For the ${chip.itemLabel}: ${chip.instruction}`
}

/** Chip text: "t-shirt · Tucked", or just the label for older chips. */
export function chipText(chip: WearSuggestion): string {
  return chip.itemLabel ? `${chip.itemLabel} · ${chip.label}` : chip.label
}

export function WearSuggestionChips({ suggestions, instruction, onPick }: {
  suggestions: WearSuggestion[]
  instruction: string
  onPick: (instruction: string) => void
}) {
  if (!suggestions.length) return null
  return (
    <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-hide" aria-label="Refine suggestions">
      {suggestions.map((chip, i) => {
        const text = chipInstruction(chip)
        const selected = instruction === text
        return (
          <button
            key={`${chip.itemId ?? ''}:${chip.label}:${i}`}
            type="button"
            aria-pressed={selected}
            title={text}
            onClick={() => onPick(text)}
            className={`shrink-0 px-2.5 py-1 text-[14px] font-bold font-mono uppercase tracking-[0.03em] border-[2px] transition-colors ${
              selected ? 'bg-accent text-accent-on border-ink' : 'bg-paper text-ink border-ink hover:bg-surface-dim'
            }`}
          >
            {chipText(chip)}
          </button>
        )
      })}
    </div>
  )
}
