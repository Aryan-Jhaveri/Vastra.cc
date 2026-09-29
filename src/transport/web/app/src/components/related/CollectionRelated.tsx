import { useState } from 'react'
import { RelatedSection, relatedActionClass, type RelatedEntry } from '../RelatedSection'
import { SavedOutfitCard } from '../SavedOutfitCard'
import { addOutfitsToCollection } from '../../api/collections'
import type { HydratedOutfit } from '../../api/outfits'
import type { RelatedResult } from '../../api/related'

const outfitEntries = (r: RelatedResult): RelatedEntry<HydratedOutfit>[] => (r.outfits ?? []).map(o => ({ id: o.id, entity: o }))

// #332 — "Outfits for this collection" in CollectionDetail. Select → Add N
// adds them in one call, refreshes the modal's grid and drops them from here.
export function CollectionRelated({ collectionId, onOpenOutfit, onAdded }: {
  collectionId: string
  onOpenOutfit: (outfit: HydratedOutfit) => void
  onAdded: () => void
}) {
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState(false)
  return (
    <RelatedSection<HydratedOutfit>
      kind="collection"
      targetId={collectionId}
      title="Outfits for this collection"
      searchLabel="Find outfits for this collection"
      emptyText="No other saved outfits fit this collection yet."
      entriesOf={outfitEntries}
      hiddenIds={added}
      renderCard={(outfit, o) => <SavedOutfitCard outfit={outfit} onClick={o.onClick} selectable={o.selectable} selected={o.selected} />}
      onOpen={onOpenOutfit}
      selectActions={(selected, clear) => (
        <button
          className={relatedActionClass}
          disabled={selected.length < 1 || adding}
          onClick={async () => {
            const ids = selected.map(o => o.id)
            setAdding(true)
            setError(false)
            try {
              await addOutfitsToCollection(collectionId, ids)
              setAdded(prev => new Set([...prev, ...ids]))
              clear()
              onAdded()
            } catch {
              setError(true)
            } finally {
              setAdding(false)
            }
          }}
        >
          Add {selected.length}
        </button>
      )}
    >
      {error && <p className="text-[13px] font-mono text-error">Couldn't add. Try again.</p>}
    </RelatedSection>
  )
}
