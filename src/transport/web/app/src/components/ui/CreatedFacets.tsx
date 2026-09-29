import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { deleteFacets, fetchFacets, type FacetKind, type FacetUsage } from '../../api/tags'

// #372 — "Your tags" / "Your occasions": every value the user has created.
// Tap one to add it to this card. Select → tap values → Delete removes them
// from everything that uses them, after a confirmation that says how many
// items, outfits and collections that touches. Removing a value from just
// this card stays the × on its pill.

const LINK = 'text-[11px] font-mono text-muted uppercase tracking-[0.06em] hover:text-ink'

interface Props {
  kind: FacetKind
  /** Values already on this card: shown as added, not addable. */
  current: string[]
  onAdd: (value: string) => void
  /** After a delete, with the values removed everywhere (drop them from local state). */
  onDeleted?: (values: string[]) => void
  /** Values not to list (e.g. the built-in occasion presets). */
  exclude?: ReadonlySet<string>
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function describeUsage(rows: Array<Pick<FacetUsage, 'items' | 'outfits' | 'collections'>>): string {
  const sum = rows.reduce((a, r) => ({ items: a.items + r.items, outfits: a.outfits + r.outfits, collections: a.collections + r.collections }), { items: 0, outfits: 0, collections: 0 })
  const parts = [
    sum.items ? plural(sum.items, 'item') : null,
    sum.outfits ? plural(sum.outfits, 'outfit') : null,
    sum.collections ? plural(sum.collections, 'collection') : null,
  ].filter(Boolean) as string[]
  if (!parts.length) return 'nothing'
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

export function CreatedFacets({ kind, current, onAdd, onDeleted, exclude }: Props) {
  const [values, setValues] = useState<FacetUsage[]>([])
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    fetchFacets(kind).then(setValues).catch(() => {})
  }, [kind])

  // Refetch when this card's values change, so counts stay true.
  const currentKey = current.join('\u0000')
  useEffect(() => { load() }, [load, currentKey])

  const shown = values.filter(v => !exclude?.has(v.value))
  const noun = kind === 'tag' ? 'tag' : 'occasion'

  if (!shown.length) return null

  function toggle(value: string) {
    setConfirming(false)
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return next
    })
  }

  function exit() {
    setSelecting(false)
    setSelected(new Set())
    setConfirming(false)
    setError(null)
  }

  async function confirmDelete() {
    const doomed = [...selected]
    setDeleting(true)
    setError(null)
    try {
      await deleteFacets(kind, doomed)
      onDeleted?.(doomed)
      exit()
      load()
    } catch {
      setError(`Couldn't delete. Try again.`)
    } finally {
      setDeleting(false)
    }
  }

  const chosen = shown.filter(v => selected.has(v.value))
  const names = chosen.map(v => `“${v.value}”`).join(', ')

  return (
    <div className="flex flex-col gap-1.5 mt-2" data-testid={`created-${kind}s`}>
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-mono text-muted uppercase tracking-[0.06em]">Your {noun}s</p>
        {selecting ? (
          <button type="button" onClick={exit} className={LINK}>Cancel</button>
        ) : (
          <button type="button" onClick={() => setSelecting(true)} className={LINK}>Select</button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {shown.map(v => {
          const onCard = current.includes(v.value)
          if (selecting) {
            const on = selected.has(v.value)
            return (
              <button
                key={v.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(v.value)}
                className={`flex items-center gap-1 border-2 px-2 py-0.5 min-h-[32px] text-[11px] font-mono uppercase tracking-[0.04em] transition-colors ${
                  on ? 'bg-accent text-accent-on border-ink' : 'bg-paper text-ink border-dashed border-outline'
                }`}
              >
                {v.value}
              </button>
            )
          }
          return (
            <button
              key={v.value}
              type="button"
              onClick={() => { if (!onCard) onAdd(v.value) }}
              className={`flex items-center gap-1 border border-dashed border-outline px-2 py-0.5 text-[11px] font-mono uppercase tracking-[0.04em] transition-opacity ${
                onCard ? 'opacity-40 cursor-default' : 'text-muted hover:border-ink hover:text-ink'
              }`}
            >
              {!onCard && <Plus className="w-2.5 h-2.5 shrink-0" strokeWidth={2.5} />}{v.value}
            </button>
          )
        })}
      </div>

      {selecting && (
        <div className="flex flex-col gap-1.5 mt-1">
          {confirming && chosen.length > 0 ? (
            <>
              <p className="text-[12px] font-mono text-ink" role="status">
                {names} will be removed from {describeUsage(chosen)}.
              </p>
              <div className="flex items-center gap-3">
                <button type="button" onClick={() => void confirmDelete()} disabled={deleting} className={`${LINK} text-error hover:text-error font-bold`}>
                  {deleting ? 'Deleting…' : `Delete ${plural(chosen.length, noun)}`}
                </button>
                <button type="button" onClick={() => setConfirming(false)} className={LINK}>Keep</button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!chosen.length}
                className={`${LINK} disabled:opacity-40 disabled:hover:text-muted`}
              >
                {chosen.length ? `Delete ${plural(chosen.length, noun)}…` : `Tap ${noun}s to delete them everywhere`}
              </button>
            </div>
          )}
          {error && <p className="text-[12px] font-mono text-error">{error}</p>}
        </div>
      )}
    </div>
  )
}
