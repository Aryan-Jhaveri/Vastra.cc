import type { Item } from '../api/items'
import { AuthImage } from './AuthImage'
import { thumbUri } from '../api/client'

function parseJSON<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T } catch { return fallback }
}

interface ItemCardProps {
  item: Item
  onClick?: () => void
  selected?: boolean
  selectable?: boolean
}

export function ItemCard({ item, onClick, selected, selectable }: ItemCardProps) {
  const colors = parseJSON<string[]>(item.colors, [])
  const base = 'relative border-2 text-left transition-colors w-full block rounded-base'
  const borderClass = selectable
    ? (selected
      ? `${base} border-transparent bg-paper animate-border-march`
      : `${base} overflow-hidden border-ink shadow-flat-xs hover:bg-surface-dim bg-paper`)
    : (selected
      ? `${base} overflow-hidden border-accent ring-[2px] ring-accent ring-offset-[-2px] bg-paper`
      : `${base} overflow-hidden border-ink shadow-flat-xs hover:bg-surface-dim bg-paper`)
  return (
    <button
      onClick={onClick}
      className={borderClass}
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-surface-dim border-b-2 border-ink">
        <AuthImage
          src={`/${thumbUri(item.imageUri)}`}
          alt={item.subcategory ?? item.category}
          className="absolute inset-0 h-full w-full object-contain"
          fillBackground
          lazy
        />
      </div>
      <div className="p-2 min-h-[3rem]">
        <p className="truncate text-[14px] font-bold font-mono uppercase tracking-[0.05em] text-ink leading-tight">
          {item.subcategory ?? item.category}
        </p>
        <div className="min-h-[0.5rem]">
          {colors.length > 0 && (
            <p className="truncate text-[14px] font-mono text-muted capitalize">
              {colors.slice(0, 3).join(', ')}
              {colors.length > 3 && ` +${colors.length - 3}`}
            </p>
          )}
        </div>
      </div>
    </button>
  )
}
