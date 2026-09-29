import { getImageSrc } from '../../api/client'
import type { Item } from '../../api/items'

interface Props {
  items: Item[]
  onItemClick?: (id: string) => void
}

export function ClosetItemMini({ items, onItemClick }: Props) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map(item => {
        const img = (
          <img
            key={item.id}
            src={getImageSrc(item.imageUri)}
            alt={item.category}
            className="w-12 h-12 object-cover border-2 border-ink"
          />
        )
        if (onItemClick) {
          return (
            <button
              key={item.id}
              onClick={() => onItemClick(item.id)}
              className="hover:opacity-80 transition-opacity"
            >
              {img}
            </button>
          )
        }
        return img
      })}
    </div>
  )
}
