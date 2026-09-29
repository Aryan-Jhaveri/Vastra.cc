import { useState } from 'react'
import { RelatedSection, relatedActionClass, type RelatedEntry } from '../RelatedSection'
import { SavedOutfitCard } from '../SavedOutfitCard'
import { AddToCollectionSheet } from '../../modals/AddToCollectionSheet'
import type { HydratedOutfit } from '../../api/outfits'
import type { RelatedResult } from '../../api/related'

const outfitEntries = (r: RelatedResult): RelatedEntry<HydratedOutfit>[] => (r.outfits ?? []).map(o => ({ id: o.id, entity: o }))

// #332 — Related outfits in OutfitDetail. Select → + Collection sends the
// selected outfits to AddToCollectionSheet.
export function OutfitRelated({ anchorId, onOpenOutfit }: {
  anchorId: string
  onOpenOutfit: (outfit: HydratedOutfit) => void
}) {
  const [sheetFor, setSheetFor] = useState<string[] | null>(null)
  return (
    <>
      <RelatedSection<HydratedOutfit>
        kind="outfit"
        targetId={anchorId}
        title="Related outfits"
        searchLabel="Find related outfits"
        emptyText="Nothing related yet. Save more outfits to compare."
        entriesOf={outfitEntries}
        renderCard={(outfit, o) => <SavedOutfitCard outfit={outfit} onClick={o.onClick} selectable={o.selectable} selected={o.selected} />}
        onOpen={onOpenOutfit}
        selectActions={(selected, clear) => (
          <button
            className={relatedActionClass}
            disabled={selected.length < 1}
            onClick={() => { setSheetFor(selected.map(o => o.id)); clear() }}
          >
            + Collection
          </button>
        )}
      />
      {sheetFor && <AddToCollectionSheet outfitIds={sheetFor} onClose={() => setSheetFor(null)} onAdded={() => setSheetFor(null)} />}
    </>
  )
}
