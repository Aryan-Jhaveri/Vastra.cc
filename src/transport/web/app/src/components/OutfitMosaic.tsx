import { AuthImage } from './AuthImage'
import type { Item } from '../api/items'

// 2×2 item-photo grid shown wherever an outfit has no cover photo — the
// SavedOutfitCard and the OutfitDetail cover section share it so the modal's
// empty state previews exactly what the card will look like.
export function OutfitMosaic({ items }: { items: Item[] }) {
  const thumbnails = items.slice(0, 4)
  return (
    <div className="grid grid-cols-2 h-full">
      {thumbnails.map((item, i) => (
        <div key={item.id} className={`relative overflow-hidden bg-surface-dim ${i < 2 ? 'border-b border-outline-variant' : ''} ${i % 2 === 0 ? 'border-r border-outline-variant' : ''}`}>
          <AuthImage
            src={`/${item.imageUri}`}
            alt={item.subcategory ?? item.category}
            className="absolute inset-0 h-full w-full object-contain"
            fillBackground
            lazy
          />
        </div>
      ))}
      {Array.from({ length: Math.max(0, 4 - thumbnails.length) }).map((_, i) => (
        <div key={`empty-${i}`} className="bg-surface" />
      ))}
    </div>
  )
}
