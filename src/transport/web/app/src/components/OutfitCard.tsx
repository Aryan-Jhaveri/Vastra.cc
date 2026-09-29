import type { OutfitSuggestion } from '../api/outfits'
import { Button } from './ui/Button'
import { AuthImage } from './AuthImage'
import { ShareButton } from './ShareButton'

interface OutfitCardProps {
  suggestion: OutfitSuggestion
  onSave?: () => void
  onView?: () => void
  saving?: boolean
  showShare?: boolean
  saved?: boolean
}

export function OutfitCard({ suggestion, onSave, onView, saving, showShare, saved }: OutfitCardProps) {
  // Defence-in-depth: legacy/malformed runs (e.g. daily_outfit rows written
  // before items were hydrated) can have an undefined items array. Never let a
  // missing items field crash the whole Reminders tab.
  const items = suggestion.items ?? []
  return (
    <div className="border-2 border-ink shadow-flat-xs p-3 flex flex-col gap-3 bg-paper rounded-base">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-bold text-ink text-[17px] leading-tight tracking-tight">{suggestion.name}</h3>
        {suggestion.occasion && (
          <span className="shrink-0 border-[2px] border-ink px-1.5 py-0.5 text-[14px] font-bold font-mono uppercase tracking-[0.06em]">
            {suggestion.occasion}
          </span>
        )}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
        {items.length > 0 ? (
          items.map(item => (
            <div key={item.id} className="shrink-0 w-14 h-[76px] border-2 border-ink overflow-hidden bg-surface-dim rounded-base">
              <AuthImage
                src={`/${item.imageUri}`}
                alt={item.subcategory ?? item.category}
                className="w-full h-full object-contain"
              />
            </div>
          ))
        ) : (
          <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] py-2">
            Items no longer available
          </span>
        )}
      </div>
      {suggestion.reasoning && (
        <p className="text-[14px] text-muted font-mono border-l-2 border-outline-variant pl-2 leading-relaxed">
          {suggestion.reasoning}
        </p>
      )}
      <div className="flex items-center gap-2">
        {saved && onView ? (
          <Button variant="secondary" onClick={onView} className="self-start">
            View outfit
          </Button>
        ) : onSave ? (
          <Button variant="secondary" onClick={onSave} loading={saving} className="self-start">
            Save outfit
          </Button>
        ) : null}
        {showShare && (
          <ShareButton
            source="suggestion"
            description={`${suggestion.name} — ${suggestion.reasoning}`}
            imageUris={items.map(i => i.imageUri)}
          />
        )}
      </div>
    </div>
  )
}
