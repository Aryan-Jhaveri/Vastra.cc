import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react'
import { ProductCard } from '../../ProductCard'
import { fetchRelatedShop, likeProduct, unlikeProduct, type ShopProduct, type ShopQuery, type ShopRankContext } from '../../../api/shop'

/** Cards revealed per tap of More. The server returns a ranked pool. */
export const SHOP_BATCH = 6

interface Props {
  /** Server-built shop search for this run; null until the shortlist event. */
  shopQuery: ShopQuery | null
  /**
   * What to rank against: the closet items and saved outfits this run shows.
   * Never the AI recommendations (#336), so the row doesn't wait on them.
   * Read when the user taps Search; later changes don't re-rank the row.
   */
  rankContext: ShopRankContext
  likedProductIds: Set<string>
  onLikeToggle: (productId: string, liked: boolean) => void
}

export function RelatedShopItemsSection({ shopQuery, rankContext, likedProductIds, onLikeToggle }: Props) {
  const [collapsed, setCollapsedState] = useState(() => {
    try {
      const raw = sessionStorage.getItem('suggest-section-state')
      if (raw) return (JSON.parse(raw) as { shop?: boolean }).shop ?? false
    } catch {}
    return false
  })

  const setCollapsed = (val: boolean) => {
    try {
      const raw = sessionStorage.getItem('suggest-section-state')
      const state = raw ? JSON.parse(raw) as Record<string, boolean> : {}
      state.shop = val
      sessionStorage.setItem('suggest-section-state', JSON.stringify(state))
    } catch {}
    setCollapsedState(val)
  }

  // Opt-in (#336): nothing is fetched until the user taps Search for this
  // run's shop query. A new Suggest/Discover run brings a new query and goes
  // back to idle, so a shop call is never automatic.
  const shopKey = shopQuery ? JSON.stringify([shopQuery.query, shopQuery.intent ?? '']) : null
  const [searchedFor, setSearchedFor] = useState<string | null>(null)
  const searched = shopKey !== null && searchedFor === shopKey

  // Ranked best-first by the server; `visible` of them are shown.
  const [products, setProducts] = useState<ShopProduct[]>([])
  const [visible, setVisible] = useState(SHOP_BATCH)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // Guards against a slow response for an old query landing after a new one.
  const requestSeq = useRef(0)
  // The context the first page was ranked with; More pages reuse it so what
  // "best" means doesn't change mid-row.
  const contextRef = useRef<ShopRankContext | undefined>(undefined)

  // A new run resets the row to idle.
  useEffect(() => {
    requestSeq.current++
    setProducts([])
    setVisible(SHOP_BATCH)
    setNextCursor(null)
    setLoading(false)
  }, [shopKey])

  const fetchProducts = useCallback(async (shop: ShopQuery, cursor?: string) => {
    const seq = ++requestSeq.current
    setLoading(true)
    try {
      const result = await fetchRelatedShop(shop, cursor, contextRef.current)
      if (seq !== requestSeq.current) return
      if (cursor) {
        // De-dupe: a later page can repeat a product from an earlier one.
        setProducts(prev => {
          const seen = new Set(prev.map(p => p.id))
          return [...prev, ...result.products.filter(p => !seen.has(p.id))]
        })
      } else {
        setProducts(result.products)
      }
      setNextCursor(result.nextCursor)
    } catch {
      if (seq !== requestSeq.current) return
      if (!cursor) setProducts([])
      setNextCursor(null)
    } finally {
      if (seq === requestSeq.current) setLoading(false)
    }
  }, [])

  const handleSearch = useCallback(() => {
    if (!shopQuery || !shopKey || loading) return
    const hasContext = rankContext.itemIds.length > 0 || rankContext.outfitIds.length > 0
    contextRef.current = hasContext ? rankContext : undefined
    setSearchedFor(shopKey)
    setVisible(SHOP_BATCH)
    if (collapsed) setCollapsed(false)
    void fetchProducts(shopQuery)
  }, [shopQuery, shopKey, loading, rankContext, collapsed, fetchProducts])

  const handleLike = useCallback(async (product: ShopProduct) => {
    const isLiked = likedProductIds.has(product.id)
    onLikeToggle(product.id, !isLiked)
    try {
      if (isLiked) {
        await unlikeProduct(product.id)
      } else {
        await likeProduct(product.id)
      }
    } catch {
      // Revert on error
      onLikeToggle(product.id, isLiked)
    }
  }, [likedProductIds, onLikeToggle])

  const hasHidden = visible < products.length
  const canMore = hasHidden || Boolean(nextCursor)

  // Reveal the next batch of the ranked pool; fetch the next catalog page only
  // once everything already fetched is on screen.
  const handleMore = useCallback(() => {
    if (loading) return
    if (!hasHidden) {
      if (!nextCursor || !shopQuery) return
      void fetchProducts(shopQuery, nextCursor)
    }
    setVisible(v => v + SHOP_BATCH)
  }, [loading, hasHidden, nextCursor, shopQuery, fetchProducts])

  const header = (
    <button
      onClick={() => setCollapsed(!collapsed)}
      className="flex items-center gap-1 text-[14px] font-bold font-mono uppercase tracking-[0.1em] hover:text-muted transition-colors"
    >
      {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      Related Shop Items
    </button>
  )

  // Hide while shortlisting (before the shop query exists)
  if (!shopQuery) return null

  const buttonClass = 'border-2 border-ink bg-accent text-accent-on text-[14px] font-bold font-sans uppercase tracking-[0.08em] px-2 py-1 hover:bg-active shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base flex items-center gap-1 disabled:opacity-50'

  let action: ReactNode = null
  if (!searched) {
    action = (
      <button onClick={handleSearch} className={buttonClass}>
        <Search className="w-3 h-3" />
        Search
      </button>
    )
  } else if (canMore && products.length > 0) {
    action = (
      <button onClick={handleMore} disabled={loading} className={buttonClass}>
        <Plus className={`w-3 h-3 ${loading ? 'animate-pulse' : ''}`} />
        More
      </button>
    )
  }

  return (
    <div className="pt-3">
      <div className="flex items-center justify-between mb-2 border-b-2 border-ink pb-2">
        {header}
        {action}
      </div>

      {!collapsed && !searched && (
        <p className="text-[13px] font-mono text-muted">Find pieces from Shopify stores that go with this.</p>
      )}

      {!collapsed && searched && loading && products.length === 0 && (
        <div className="flex gap-3 overflow-hidden" data-testid="shop-skeleton">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="w-[160px] flex-shrink-0 border-2 border-ink bg-surface-dim rounded-base">
              <div className="aspect-[4/5] bg-surface animate-pulse" />
              <div className="p-2 space-y-1.5">
                <div className="h-3 bg-surface w-3/4 rounded animate-pulse" />
                <div className="h-2.5 bg-surface w-1/2 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!collapsed && searched && !loading && products.length === 0 && (
        <p className="text-[13px] font-mono text-muted">No matching items found in Shopify stores.</p>
      )}

      {!collapsed && products.length > 0 && (
        <>
          <div className="flex gap-3 overflow-x-auto pb-2 animate-grid-in">
            {products.slice(0, visible).map(product => (
              <ProductCard
                key={product.id}
                product={product}
                liked={likedProductIds.has(product.id)}
                onLike={() => handleLike(product)}
                variant="row"
              />
            ))}
          </div>
          <p className="text-[11px] font-mono text-muted uppercase tracking-[0.06em] mt-1">
            From Shopify stores
          </p>
        </>
      )}
    </div>
  )
}
