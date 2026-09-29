import type { HydratedCollection } from '../api/collections'
import type { HydratedOutfit } from '../api/outfits'
import { AuthImage } from './AuthImage'

function OutfitMini({ outfit }: { outfit: HydratedOutfit }) {
  if (outfit.coverImageUri) {
    return (
      <AuthImage
        src={`/${outfit.coverImageUri}`}
        alt={outfit.name}
        className="absolute inset-0 h-full w-full object-contain"
        fillBackground
        lazy
      />
    )
  }
  const items = outfit.items?.slice(0, 4) ?? []
  return (
    <div className="grid grid-cols-2 h-full w-full">
      {items.map((item, i) => (
        <div
          key={item.id}
          className={`relative overflow-hidden bg-surface-dim ${i < 2 ? 'border-b border-outline-variant' : ''} ${i % 2 === 0 ? 'border-r border-outline-variant' : ''}`}
        >
          <AuthImage
            src={`/${item.imageUri}`}
            alt={item.subcategory ?? item.category}
            className="absolute inset-0 h-full w-full object-contain"
            fillBackground
            lazy
          />
        </div>
      ))}
      {Array.from({ length: Math.max(0, 4 - items.length) }).map((_, i) => (
        <div key={`e-${i}`} className="bg-surface" />
      ))}
    </div>
  )
}

interface CollectionCardProps {
  collection: HydratedCollection
  onClick?: () => void
  selectable?: boolean
  selected?: boolean
}

export function CollectionCard({ collection, onClick, selectable, selected }: CollectionCardProps) {
  const outfitCount = collection.outfits.length
  const slots = collection.outfits.slice(0, 4)

  const borderClass = selectable
    ? (selected
      ? 'border-transparent animate-border-march'
      : 'border-ink overflow-hidden')
    : 'border-ink overflow-hidden'

  return (
    <button
      onClick={onClick}
      className={`relative border-2 text-left bg-paper w-full transition-colors shadow-flat-xs rounded-base hover:bg-hover ${borderClass}`}
    >
      {/* Photo area */}
      <div className="relative aspect-[3/4] overflow-hidden border-b-2 border-ink bg-surface-dim">
        {collection.coverImageUri ? (
          <AuthImage
            src={`/${collection.coverImageUri}`}
            alt={collection.name}
            className="absolute inset-0 h-full w-full object-contain"
            fillBackground
            lazy
          />
        ) : slots.length > 0 ? (
          <div className="grid grid-cols-2 h-full">
            {slots.map((outfit, i) => (
              <div
                key={outfit.id}
                className={`relative overflow-hidden bg-surface-dim ${i < 2 ? 'border-b border-outline-variant' : ''} ${i % 2 === 0 ? 'border-r border-outline-variant' : ''}`}
              >
                <OutfitMini outfit={outfit} />
              </div>
            ))}
            {Array.from({ length: Math.max(0, 4 - slots.length) }).map((_, i) => (
              <div key={`empty-${i}`} className="bg-surface" />
            ))}
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">No outfits yet</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-1.5 flex flex-col gap-0.5">
        <p className="truncate text-[14px] font-bold font-mono uppercase tracking-[0.04em] text-ink">
          {collection.name}
        </p>
        <p className="text-[14px] font-mono text-muted">
          {outfitCount} {outfitCount === 1 ? 'outfit' : 'outfits'}
        </p>
      </div>
    </button>
  )
}
