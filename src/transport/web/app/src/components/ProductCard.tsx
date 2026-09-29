import { Heart, ExternalLink, Check } from 'lucide-react'
import type { ShopProduct } from '../api/shop'

interface ProductCardProps {
  product: ShopProduct
  liked?: boolean
  onLike?: () => void
  /** Grid select mode: the whole card toggles selection; like and View are inert. */
  selectable?: boolean
  selected?: boolean
  onSelect?: () => void
  variant?: 'row' | 'grid'
}

// Neobrutalist button base shared by the heart and View, so both follow the
// active palette (ink / paper / accent tokens) in light and dark mode.
const BTN = 'border-2 border-ink rounded-base shadow-flat-xs transition-[transform,box-shadow,colors] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none'

/** Only https links are rendered — the URL comes from stored like data. */
export function safeProductUrl(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

export function ProductCard({
  product, liked, onLike,
  selectable, selected, onSelect, variant = 'row',
}: ProductCardProps) {
  const href = safeProductUrl(product.url)
  const merchantHost = (() => {
    if (!href) return product.merchant
    try { return new URL(href).hostname.replace(/^www\./, '') } catch { return product.merchant }
  })()

  // Same border/selection treatment as ItemCard so the Liked grid matches the Closet grid.
  const border = selectable && selected
    ? 'border-accent ring-[2px] ring-accent ring-offset-[-2px]'
    : 'border-ink shadow-flat-xs'

  return (
    <div
      role={selectable ? 'button' : undefined}
      aria-pressed={selectable ? !!selected : undefined}
      onClick={selectable ? onSelect : undefined}
      className={`relative flex flex-col border-2 ${border} overflow-hidden rounded-base bg-paper text-left ${
        variant === 'row' ? 'w-[160px] flex-shrink-0' : 'w-full h-full'
      } ${selectable ? 'cursor-pointer' : ''}`}
    >
      <div className="relative aspect-[3/4] overflow-hidden bg-surface-dim border-b-2 border-ink">
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt={product.title}
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-[14px] font-mono text-muted">No image</span>
          </div>
        )}
        {!product.available && (
          <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
            <span className="text-[14px] font-mono uppercase text-white">Sold out</span>
          </div>
        )}
        {onLike && !selectable && (
          <button
            onClick={(e) => { e.stopPropagation(); onLike() }}
            className={`absolute top-1.5 right-1.5 w-9 h-9 flex items-center justify-center ${BTN} ${
              liked ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
            }`}
            aria-label={liked ? 'Unlike' : 'Like'}
            aria-pressed={!!liked}
          >
            <Heart className={`w-4 h-4 ${liked ? 'fill-current' : ''}`} strokeWidth={2.5} />
          </button>
        )}
        {selectable && selected && (
          <div className="absolute top-1.5 right-1.5 w-9 h-9 flex items-center justify-center border-2 border-ink rounded-base bg-accent text-accent-on">
            <Check className="w-3.5 h-3.5" strokeWidth={3} />
          </div>
        )}
      </div>

      {/* Fixed-height rows so every card in a grid lines up whether or not
          a price is present; View is pinned to the bottom. */}
      <div className="flex flex-1 flex-col p-2 gap-0.5">
        <p className="truncate text-[14px] font-bold font-mono uppercase tracking-[0.05em] text-ink leading-tight">
          {product.title}
        </p>
        <p className="truncate text-[14px] font-mono text-muted leading-tight">{merchantHost}</p>
        <p className="truncate h-5 text-[14px] font-bold font-mono text-ink leading-tight">{product.price ?? ''}</p>
        <div className="mt-auto pt-1.5">
          {href && !selectable ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={`w-full h-8 flex items-center justify-center gap-1 text-[13px] font-bold font-mono uppercase tracking-[0.04em] bg-accent text-accent-on hover:bg-active ${BTN}`}
              aria-label={`View ${product.title} on ${merchantHost}`}
            >
              View <ExternalLink className="w-3 h-3" strokeWidth={2.5} />
            </a>
          ) : (
            // Same footprint when there's no link or while selecting, so card
            // heights never change; in select mode the tap reaches the card.
            <span
              aria-hidden="true"
              className="w-full h-8 flex items-center justify-center gap-1 text-[13px] font-bold font-mono uppercase tracking-[0.04em] border-2 border-ink rounded-base bg-surface text-muted opacity-60"
            >
              View <ExternalLink className="w-3 h-3" strokeWidth={2.5} />
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
