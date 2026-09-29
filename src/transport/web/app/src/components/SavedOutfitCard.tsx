import type { HydratedOutfit } from '../api/outfits'
import { AuthImage } from './AuthImage'
import { OutfitMosaic } from './OutfitMosaic'

interface SavedOutfitCardProps {
  outfit: HydratedOutfit
  onClick?: () => void
  selectable?: boolean
  selected?: boolean
}

export function SavedOutfitCard({ outfit, onClick, selectable, selected }: SavedOutfitCardProps) {
  const seasons: string[] = (() => { try { return JSON.parse(outfit.season || '[]') } catch { return [] } })()
  const tags: string[] = (() => { try { return JSON.parse(outfit.tags || '[]') } catch { return [] } })()

  const borderClass = selectable
    ? (selected
      ? 'border-transparent bg-paper animate-border-march'
      : 'border-ink')
    : (selected
      ? 'border-accent ring-[2px] ring-accent ring-offset-[-2px]'
      : 'border-ink')

  return (
    <button
      onClick={onClick}
      className={`relative border-2 text-left bg-paper w-full transition-colors shadow-flat-xs rounded-base hover:bg-hover ${borderClass}`}
    >
      {/* Photo area: cover photo OR 2×2 grid */}
      <div className="relative aspect-[3/4] overflow-hidden border-b-2 border-ink bg-surface-dim">
        {outfit.coverImageUri ? (
          <AuthImage
            src={`/${outfit.coverImageUri}`}
            alt={outfit.name}
            className="absolute inset-0 h-full w-full object-contain"
            fillBackground
            lazy
          />
        ) : (
          <OutfitMosaic items={outfit.items} />
        )}
      </div>

      {/* Info */}
      <div className="p-1.5 flex flex-col gap-0.5">
        <p className="truncate text-[14px] font-bold font-mono uppercase tracking-[0.04em] text-ink">
          {outfit.name}
        </p>
        <div className="min-h-[1.25rem]">
          <div className="flex items-center gap-1 flex-wrap">
            {outfit.occasion && (
              <span className="text-[14px] font-mono text-muted capitalize">{outfit.occasion}</span>
            )}
            {seasons.length > 0 && (
              <span className="text-[14px] font-mono text-muted capitalize">
                {outfit.occasion ? '· ' : ''}{seasons.join(' · ')}
              </span>
            )}
            {outfit.aiGenerated === 1 && (
              <span className="text-[11px] font-bold font-mono uppercase tracking-[0.06em] border border-ink px-1">
                AI
              </span>
            )}
          </div>
        </div>
        <div className="min-h-[1.25rem]">
          {tags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap mt-0.5">
              {tags.slice(0, 2).map(t => (
                <span key={t} className="text-[11px] font-mono uppercase tracking-[0.04em] border border-outline-variant px-1 text-muted">{t}</span>
              ))}
              {tags.length > 2 && (
                <span className="text-[11px] font-mono text-muted">+{tags.length - 2}</span>
              )}
            </div>
          )}
        </div>
      </div>
    </button>
  )
}
