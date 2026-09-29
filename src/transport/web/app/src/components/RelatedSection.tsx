import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Search, X } from 'lucide-react'
import { Spinner } from './ui/Spinner'
import { findRelated, fetchSavedRelated, type RelatedKind, type RelatedResult } from '../api/related'

// #332 / #279 — the "Related" section in the Item / Outfit / Collection
// detail cards. It starts idle and makes NO find request until the magnifier
// is tapped (each find uses one of the user's daily finds). A saved result
// that is still current is shown on open, which is free. The daily limit is
// only ever shown once it's reached.

export type RelatedState =
  | { phase: 'idle' }
  | { phase: 'loading'; previous: RelatedResult | null }
  | { phase: 'results'; result: RelatedResult }
  | { phase: 'error' }
  | { phase: 'capped'; resetsAt: number | null }

export interface RelatedEntry<T> { id: string; entity: T }

interface Props<T> {
  kind: RelatedKind
  targetId: string
  title: string
  /** aria-label and tooltip of the magnifier, e.g. "Find related items". */
  searchLabel: string
  emptyText: string
  entriesOf: (result: RelatedResult) => RelatedEntry<T>[]
  renderCard: (entity: T, opts: { selectable: boolean; selected: boolean; onClick: () => void }) => ReactNode
  onOpen: (entity: T) => void
  /** Header actions in select mode, given the selected entities. */
  selectActions?: (selected: T[], clear: () => void) => ReactNode
  /** Ids to drop from the result (e.g. outfits just added to the collection). */
  hiddenIds?: ReadonlySet<string>
  /** Rendered above the grid (e.g. an outfit just saved from a selection). */
  children?: ReactNode
}

/** Classes for header action buttons in select mode (Outfit / + Collection / Add N). */
export const relatedActionClass = 'border-2 border-ink rounded-base shadow-flat-xs bg-accent text-accent-on px-2 h-9 text-[12px] font-bold font-mono uppercase active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-50 disabled:cursor-not-allowed'

export function foundAgo(foundAt: number, now = Date.now()): string {
  const mins = Math.floor((now - foundAt) / 60_000)
  if (mins < 1) return 'Found just now'
  if (mins < 60) return `Found ${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `Found ${hours}h ago`
  return `Found ${Math.floor(hours / 24)}d ago`
}

export function resetsIn(resetsAt: number | null, now = Date.now()): string {
  if (!resetsAt) return 'resets within 24h'
  const mins = Math.max(0, Math.ceil((resetsAt - now) / 60_000))
  const h = Math.floor(mins / 60)
  return `resets in ${h ? `${h}h ` : ''}${mins % 60}m`
}

export function RelatedSection<T>({
  kind, targetId, title, searchLabel, emptyText, entriesOf, renderCard, onOpen, selectActions, hiddenIds, children,
}: Props<T>) {
  const [state, setState] = useState<RelatedState>({ phase: 'idle' })
  const [selecting, setSelecting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  // A saved, still-current result shows on open for free. No find request.
  useEffect(() => {
    let cancelled = false
    setState({ phase: 'idle' })
    setSelecting(false)
    setSelectedIds([])
    void fetchSavedRelated(kind, targetId).then(saved => {
      if (!cancelled && saved) setState(s => (s.phase === 'idle' ? { phase: 'results', result: saved } : s))
    })
    return () => { cancelled = true }
  }, [kind, targetId])

  const entries = useMemo(() => {
    if (state.phase !== 'results') return []
    return entriesOf(state.result).filter(e => !hiddenIds?.has(e.id))
  }, [state, entriesOf, hiddenIds])

  async function find() {
    if (state.phase === 'loading' || state.phase === 'capped') return
    setSelecting(false)
    setSelectedIds([])
    setState({ phase: 'loading', previous: state.phase === 'results' ? state.result : null })
    const outcome = await findRelated(kind, targetId)
    if (outcome.kind === 'result') setState({ phase: 'results', result: outcome.result })
    else if (outcome.kind === 'capped') setState({ phase: 'capped', resetsAt: outcome.resetsAt })
    else setState({ phase: 'error' })
  }

  const clear = () => { setSelecting(false); setSelectedIds([]) }
  const selected = entries.filter(e => selectedIds.includes(e.id)).map(e => e.entity)
  const loading = state.phase === 'loading'
  const capped = state.phase === 'capped'

  const toolButton = 'border-2 border-ink rounded-base shadow-flat-xs active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <section data-testid={`related-${kind}`} className="flex flex-col gap-2 pt-3">
      <div className="flex items-center justify-between gap-2 border-b-2 border-ink pb-2">
        <h3 className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">{title}</h3>
        <div className="flex items-center gap-2">
          {selecting ? (
            <>
              {selectActions?.(selected, clear)}
              <button onClick={clear} className={`${toolButton} bg-paper px-2 h-9 text-[12px] font-bold font-mono uppercase flex items-center gap-1`}>
                <X className="w-3 h-3" /> Cancel
              </button>
            </>
          ) : (
            <>
              {selectActions && entries.length > 0 && !loading && (
                <button onClick={() => setSelecting(true)} className={`${toolButton} bg-paper px-2 h-9 text-[12px] font-bold font-mono uppercase`}>
                  Select
                </button>
              )}
              <button
                onClick={() => void find()}
                disabled={loading || capped}
                aria-label={searchLabel}
                title={searchLabel}
                className={`${toolButton} w-9 h-9 bg-accent text-accent-on flex items-center justify-center`}
              >
                {loading ? <Spinner size={16} /> : <Search className="w-4 h-4" />}
              </button>
            </>
          )}
        </div>
      </div>

      {children}

      {state.phase === 'loading' && (
        <p className="text-[13px] font-mono text-muted">Finding…</p>
      )}
      {state.phase === 'error' && (
        <p className="text-[13px] font-mono text-error">Couldn't find related · tap search to try again</p>
      )}
      {state.phase === 'capped' && (
        <p className="text-[13px] font-mono text-muted">Daily limit reached · {resetsIn(state.resetsAt)}</p>
      )}
      {state.phase === 'results' && entries.length === 0 && (
        <p className="text-[13px] font-mono text-muted">{emptyText}</p>
      )}
      {state.phase === 'results' && entries.length > 0 && (
        <>
          {selecting && <p className="text-[12px] font-mono text-muted">{selectedIds.length} selected</p>}
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {entries.map(({ id, entity }) => (
              <div key={id}>
                {renderCard(entity, {
                  selectable: selecting,
                  selected: selectedIds.includes(id),
                  onClick: () => {
                    if (!selecting) return onOpen(entity)
                    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
                  },
                })}
              </div>
            ))}
          </div>
          <p className="text-[11px] font-mono text-muted uppercase tracking-[0.06em]">{foundAgo(state.result.foundAt)}</p>
        </>
      )}
    </section>
  )
}
