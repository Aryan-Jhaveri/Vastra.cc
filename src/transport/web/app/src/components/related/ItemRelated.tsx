import { useState } from 'react'
import { RelatedSection, relatedActionClass, type RelatedEntry } from '../RelatedSection'
import { ItemCard } from '../ItemCard'
import { SavedOutfitCard } from '../SavedOutfitCard'
import { OutfitSaveModal } from '../../modals/OutfitSaveModal'
import { AddToCollectionSheet } from '../../modals/AddToCollectionSheet'
import { fetchOutfit, type HydratedOutfit } from '../../api/outfits'
import type { Item } from '../../api/items'
import type { RelatedResult } from '../../api/related'

const itemEntries = (r: RelatedResult): RelatedEntry<Item>[] => (r.items ?? []).map(i => ({ id: i.id, entity: i }))

// #332 — Related items in ItemDetail. Select → Outfit saves [this item,
// ...selected] through OutfitSaveModal; the new outfit then shows here with
// + Collection.
export function ItemRelated({ anchor, onOpenItem, onChanged }: {
  anchor: Item
  onOpenItem: (item: Item) => void
  onChanged?: () => void
}) {
  const [saveItems, setSaveItems] = useState<Item[] | null>(null)
  const [created, setCreated] = useState<HydratedOutfit | null>(null)
  const [sheetFor, setSheetFor] = useState<string[] | null>(null)

  return (
    <>
      <RelatedSection<Item>
        kind="item"
        targetId={anchor.id}
        title="Related items"
        searchLabel="Find related items"
        emptyText="Nothing related yet. Add more items in other categories."
        entriesOf={itemEntries}
        renderCard={(item, o) => <ItemCard item={item} onClick={o.onClick} selectable={o.selectable} selected={o.selected} />}
        onOpen={onOpenItem}
        selectActions={(selected, clear) => (
          <button
            className={relatedActionClass}
            disabled={selected.length < 1}
            onClick={() => { setSaveItems([anchor, ...selected]); clear() }}
          >
            Outfit
          </button>
        )}
      >
        {created && (
          <div className="flex items-end gap-2" data-testid="related-created-outfit">
            <div className="w-32"><SavedOutfitCard outfit={created} /></div>
            <button className={relatedActionClass} onClick={() => setSheetFor([created.id])}>+ Collection</button>
          </div>
        )}
      </RelatedSection>
      {saveItems && (
        <OutfitSaveModal
          items={saveItems}
          onClose={() => setSaveItems(null)}
          onSaved={async outfit => {
            setSaveItems(null)
            onChanged?.()
            setCreated(await fetchOutfit(outfit.id).catch(() => null))
          }}
        />
      )}
      {sheetFor && <AddToCollectionSheet outfitIds={sheetFor} onClose={() => setSheetFor(null)} onAdded={() => setSheetFor(null)} />}
    </>
  )
}
