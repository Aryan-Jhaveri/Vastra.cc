import { useState } from 'react'
import { X } from 'lucide-react'
import { CreatedFacets } from './CreatedFacets'

/** The pill's × with a 44px tap area that doesn't grow the pill (#371). */
export const REMOVE_BUTTON = "relative text-muted hover:text-ink flex items-center after:absolute after:-inset-4 after:content-['']"

interface TagEditorProps {
  tags: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  className?: string
  /** Show "Your tags": add a created tag, or Select → delete it everywhere (#372). */
  created?: boolean
}

export function TagEditor({ tags, onChange, placeholder = 'Add tag, press Enter', className, created }: TagEditorProps) {
  const [input, setInput] = useState('')

  function addTag(raw: string) {
    const t = raw.trim().toLowerCase()
    if (t.length > 50) return
    if (!t || tags.includes(t)) { setInput(''); return }
    onChange([...tags, t])
    setInput('')
  }

  function removeTag(t: string) {
    onChange(tags.filter(x => x !== t))
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {tags.map(t => (
          <span key={t} className="flex items-center gap-1 border-2 border-ink px-2 py-0.5 text-[14px] font-mono uppercase tracking-[0.06em]">
            {t}
            <button
              type="button"
              aria-label={`Remove ${t}`}
              // Keep focus in the input: a blur would add its half-typed text
              // with the old list and undo this removal (#371).
              onMouseDown={e => e.preventDefault()}
              onClick={() => removeTag(t)}
              className={REMOVE_BUTTON}
            >
              <X className="w-3 h-3" strokeWidth={2.5} />
            </button>
          </span>
        ))}
      </div>
      <div className="relative">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              addTag(input)
            }
          }}
          onBlur={() => { if (input.trim()) addTag(input) }}
          placeholder={placeholder}
          maxLength={50}
          className="w-full border-2 border-ink px-3 py-1.5 pr-14 text-[14px] font-mono outline-none focus:bg-surface-dim bg-paper text-ink placeholder:text-muted placeholder:normal-case"
        />
        {input.length > 0 && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] font-mono text-muted pointer-events-none">
            {input.length}/50
          </span>
        )}
      </div>
      {created && (
        <CreatedFacets
          kind="tag"
          current={tags}
          onAdd={addTag}
          onDeleted={gone => {
            // Already removed on the server; keep this card's state in step.
            if (tags.some(t => gone.includes(t))) onChange(tags.filter(t => !gone.includes(t)))
          }}
        />
      )}
    </div>
  )
}
