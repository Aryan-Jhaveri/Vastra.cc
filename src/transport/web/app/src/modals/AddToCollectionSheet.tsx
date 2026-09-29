import { useState, useEffect } from 'react'
import { ArrowLeft } from 'lucide-react'
import { useCollections } from '../hooks/useCollections'
import {
  addOutfitsToCollection, createCollection, fetchCollectionsForOutfit,
} from '../api/collections'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'

interface AddToCollectionSheetProps {
  /** Outfit IDs to add (one from OutfitDetail, many from bulk select) */
  outfitIds?: string[]
  /** When used inside CollectionDetail to add outfits to one specific collection */
  collectionId?: string
  existingOutfitIds?: string[]
  onClose: () => void
  onAdded: () => void
}

export function AddToCollectionSheet({
  outfitIds = [],
  collectionId,
  existingOutfitIds = [],
  onClose,
  onAdded,
}: AddToCollectionSheetProps) {
  const { collections, loading, refetch } = useCollections()
  const [currentIds, setCurrentIds] = useState<string[]>([])
  const [loadingCurrentIds, setLoadingCurrentIds] = useState(true)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // When adding a single outfit, fetch which collections it's already in
    if (outfitIds.length === 1) {
      fetchCollectionsForOutfit(outfitIds[0])
        .then(setCurrentIds)
        .catch(() => {})
        .finally(() => setLoadingCurrentIds(false))
    } else {
      setLoadingCurrentIds(false)
    }
  }, [outfitIds])

  async function addToCollection(targetCollectionId: string) {
    const ids = outfitIds.length > 0 ? outfitIds : []
    if (ids.length === 0 && existingOutfitIds.length === 0) return
    const toAdd = ids.length > 0 ? ids : []
    if (toAdd.length === 0) return
    setAdding(targetCollectionId)
    setError(null)
    try {
      await addOutfitsToCollection(targetCollectionId, toAdd)
      setCurrentIds(prev => [...prev, targetCollectionId])
      onAdded()
    } catch (err) { setError(String(err)) }
    finally { setAdding(null) }
  }

  async function handleCreate() {
    if (!newName.trim()) return
    setAdding('new')
    setError(null)
    try {
      const col = await createCollection({ name: newName.trim() })
      const ids = outfitIds.length > 0 ? outfitIds : []
      if (ids.length > 0) {
        await addOutfitsToCollection(col.id, ids)
      }
      await refetch()
      setCreating(false)
      setNewName('')
      setCurrentIds(prev => [...prev, col.id])
      onAdded()
    } catch (err) { setError(String(err)) }
    finally { setAdding(null) }
  }

  const title = collectionId
    ? 'Add Outfits'
    : outfitIds.length > 1
    ? `Add ${outfitIds.length} Outfits to Collection`
    : 'Add to Collection'

  return (
    <div className="fixed inset-0 nav-anchor-right z-[60] flex items-end justify-center bg-black/50" onClick={onClose}>
      <div className="bg-paper border-2 border-ink border-b-0 w-full max-w-lg max-h-[70vh] flex flex-col rounded-base" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b-2 border-ink shrink-0">
          <button onClick={onClose} className="text-ink hover:text-muted flex items-center justify-center" aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
          <span className="text-[12px] font-bold font-mono uppercase tracking-[0.08em]">{title}</span>
          <div className="w-8" />
        </div>

        <div className="overflow-y-auto flex-1 p-4 flex flex-col gap-3">
          {error && (
            <div className="border-2 border-ink bg-surface-dim px-3 py-2 text-[13px] font-mono uppercase tracking-[0.06em] rounded-base">{error}</div>
          )}

          {(loading || loadingCurrentIds) && <div className="flex justify-center py-4"><Spinner /></div>}

          {!loading && collections.map(col => {
            const isIn = currentIds.includes(col.id)
            const isCurrentCollection = col.id === collectionId
            // Hydrated collections carry the outfits themselves; count those so the
            // label always matches what the collection actually holds (#361).
            const count = col.outfits?.length ?? col.outfitCount ?? 0
            return (
              <button
                key={col.id}
                onClick={() => !isIn && !isCurrentCollection && addToCollection(col.id)}
                disabled={isIn || isCurrentCollection || adding === col.id}
                className={`flex items-center justify-between px-3 py-2.5 border-2 border-ink text-left transition-colors rounded-base ${
                  isIn ? 'bg-accent text-accent-on cursor-default' : 'hover:bg-surface-dim disabled:opacity-50'
                }`}
              >
                <div>
                  <p className="text-[12px] font-bold font-mono uppercase tracking-[0.06em]">{col.name}</p>
                  <p className="text-[11px] font-mono text-muted">{count} {count === 1 ? 'outfit' : 'outfits'}</p>
                </div>
                <span className="text-[13px] font-mono">
                  {adding === col.id ? '…' : isIn ? '✓' : '+'}
                </span>
              </button>
            )
          })}

          {!loading && collections.length === 0 && !creating && (
            <p className="text-[13px] font-mono text-muted uppercase tracking-[0.06em] text-center py-2">
              No collections yet.
            </p>
          )}

          {/* Create new */}
          {creating ? (
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); if (e.key === 'Escape') setCreating(false) }}
                placeholder="Collection name…"
                autoFocus
                maxLength={100}
                className="flex-1 border-2 border-ink px-3 py-2 text-sm font-mono outline-none focus:bg-surface-dim"
              />
              <Button onClick={handleCreate} loading={adding === 'new'} className="shrink-0">
                Create
              </Button>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex items-center gap-2 px-3 py-2.5 border-2 border-dashed border-outline text-left hover:border-ink transition-colors"
            >
              <span className="text-[13px] font-mono text-muted">+</span>
              <p className="text-[12px] font-bold font-mono uppercase tracking-[0.06em] text-muted">New collection</p>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
