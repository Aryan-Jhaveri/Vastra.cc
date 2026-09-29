import { useState, useCallback, useEffect, useMemo } from 'react'
import { BasedOnTheseItemsSection } from './sections/BasedOnTheseItemsSection'
import { RelatedOutfitsSection } from './sections/RelatedOutfitsSection'
import { RelatedShopItemsSection } from './sections/RelatedShopItemsSection'
import { AIRecommendationsSection } from './sections/AIRecommendationsSection'
import { fetchLikedProductIds, type ShopRankContext } from '../../api/shop'
import { useShopEnabled } from '../../hooks/useShopEnabled'
import type { HydratedOutfit, OutfitSuggestion } from '../../api/outfits'
import type { UseDiscoverStreamReturn, ReshuffleResult } from '../../hooks/useDiscoverStream'

interface Props {
  stream: UseDiscoverStreamReturn
  onReshuffleItems: () => ReshuffleResult | undefined
  onReshuffleOutfits: () => ReshuffleResult | undefined
  onItemClick?: (id: string) => void
  onOutfitClick?: (outfit: HydratedOutfit) => void
  onSave?: (suggestion: OutfitSuggestion) => void
  onView?: (suggestion: OutfitSuggestion) => void
  onRegenerate?: () => void
  savingId?: string | null
  savedIds?: Set<string>
}

export function PhasedSuggestionLayout({
  stream,
  onReshuffleItems,
  onReshuffleOutfits,
  onItemClick,
  onOutfitClick,
  onSave,
  onView,
  onRegenerate,
  savingId,
  savedIds,
}: Props) {
  const shopEnabled = useShopEnabled()
  const [likedProductIds, setLikedProductIds] = useState<Set<string>>(new Set())

  // Seed hearts from the server so products liked earlier show as liked and
  // the first tap unlikes them. Merged with any likes tapped before it lands.
  useEffect(() => {
    if (!shopEnabled) return
    let cancelled = false
    fetchLikedProductIds()
      .then(ids => {
        if (cancelled) return
        setLikedProductIds(prev => new Set([...ids, ...prev]))
      })
      .catch(() => { /* hearts just start empty */ })
    return () => { cancelled = true }
  }, [shopEnabled])

  // What the shop row is ranked against (#336): the closet items and saved
  // outfits on screen, ids only (the server re-reads them). Not the AI
  // recommendations, so the shop row never waits on the model.
  const shopRankContext = useMemo<ShopRankContext>(() => ({
    itemIds: (stream.visibleItems ?? []).map(i => i.id),
    outfitIds: (stream.visibleOutfits ?? []).map(o => o.id),
    recommendations: [],
  }), [stream.visibleItems, stream.visibleOutfits])

  const handleLikeToggle = useCallback((productId: string, liked: boolean) => {
    setLikedProductIds(prev => {
      const next = new Set(prev)
      if (liked) next.add(productId)
      else next.delete(productId)
      return next
    })
  }, [])

  return (
    <div className="flex flex-col gap-0">
      <BasedOnTheseItemsSection
        items={stream.visibleItems}
        phase={stream.phase}
        onItemClick={onItemClick}
      />

      <RelatedOutfitsSection
        outfits={stream.visibleOutfits}
        hasMore={stream.hasMoreOutfits}
        phase={stream.phase}
        source={stream.relatedOutfitsSource ?? undefined}
        onReshuffle={onReshuffleOutfits}
        onOutfitClick={onOutfitClick}
      />

      {shopEnabled && (
        <RelatedShopItemsSection
          shopQuery={stream.shopQuery}
          rankContext={shopRankContext}
          likedProductIds={likedProductIds}
          onLikeToggle={handleLikeToggle}
        />
      )}

      <AIRecommendationsSection
        suggestions={stream.suggestions}
        phase={stream.phase}
        retrievalMode={stream.retrievalMode}
        contextDescription={stream.contextDescription}
        onSave={onSave}
        onView={onView}
        onRegenerate={onRegenerate}
        savingId={savingId}
        savedIds={savedIds}
      />
    </div>
  )
}
