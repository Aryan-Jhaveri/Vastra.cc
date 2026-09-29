import { useEffect, useRef, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { ProductCard } from '../ProductCard'
import { Spinner } from '../ui/Spinner'
import { resetsIn } from '../RelatedSection'
import { fetchShopForItem, fetchLikedProductIds, likeProduct, unlikeProduct, type ShopProduct } from '../../api/shop'

type Phase = 'idle' | 'loading' | 'results' | 'error' | 'capped'

// #332 — "Related shop items" in ItemDetail: products that complete this item,
// found only when the user taps Search (one Find related), then More pages
// through the catalog without using another find. Same card + likes as the
// Suggest/Discover shop row.
export function ItemShopSection({ itemId }: { itemId: string }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [products, setProducts] = useState<ShopProduct[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [paging, setPaging] = useState(false)
  const [resetsAt, setResetsAt] = useState<number | null>(null)
  const [liked, setLiked] = useState<Set<string>>(new Set())
  const seq = useRef(0)

  useEffect(() => {
    seq.current++
    setPhase('idle')
    setProducts([])
    setNextCursor(null)
  }, [itemId])

  async function search() {
    if (phase === 'loading' || phase === 'capped') return
    const mine = ++seq.current
    setPhase('loading')
    fetchLikedProductIds().then(ids => setLiked(new Set(ids))).catch(() => {})
    const out = await fetchShopForItem(itemId)
    if (mine !== seq.current) return
    if (out.kind === 'result') {
      setProducts(out.products)
      setNextCursor(out.nextCursor)
      setPhase('results')
    } else if (out.kind === 'capped') {
      setResetsAt(out.resetsAt)
      setPhase('capped')
    } else {
      setPhase('error')
    }
  }

  async function more() {
    if (!nextCursor || paging) return
    const mine = seq.current
    setPaging(true)
    const out = await fetchShopForItem(itemId, nextCursor)
    setPaging(false)
    if (mine !== seq.current || out.kind !== 'result') return
    setProducts(prev => {
      const seen = new Set(prev.map(p => p.id))
      return [...prev, ...out.products.filter(p => !seen.has(p.id))]
    })
    setNextCursor(out.nextCursor)
  }

  async function toggleLike(product: ShopProduct) {
    const was = liked.has(product.id)
    const flip = (on: boolean) => setLiked(prev => {
      const next = new Set(prev)
      if (on) next.add(product.id)
      else next.delete(product.id)
      return next
    })
    flip(!was)
    try { await (was ? unlikeProduct(product.id) : likeProduct(product.id)) } catch { flip(was) }
  }

  const button = 'border-2 border-ink rounded-base shadow-flat-xs bg-accent text-accent-on h-9 flex items-center justify-center gap-1 text-[12px] font-bold font-mono uppercase active:translate-x-[1px] active:translate-y-[1px] active:shadow-none transition-[transform,box-shadow,colors] disabled:opacity-50 disabled:cursor-not-allowed'

  return (
    <section data-testid="related-item-shop" className="flex flex-col gap-2 pt-3">
      <div className="flex items-center justify-between gap-2 border-b-2 border-ink pb-2">
        <h3 className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Related shop items</h3>
        {phase === 'results' && nextCursor ? (
          <button className={`${button} px-2`} onClick={() => void more()} disabled={paging}>
            <Plus className={`w-3 h-3 ${paging ? 'animate-pulse' : ''}`} /> More
          </button>
        ) : (
          <button
            className={`${button} w-9`}
            onClick={() => void search()}
            disabled={phase === 'loading' || phase === 'capped'}
            aria-label="Find shop items for this item"
            title="Find shop items for this item"
          >
            {phase === 'loading' ? <Spinner size={16} /> : <Search className="w-4 h-4" />}
          </button>
        )}
      </div>
      {phase === 'idle' && <p className="text-[13px] font-mono text-muted">Find pieces from Shopify stores that go with this.</p>}
      {phase === 'loading' && <p className="text-[13px] font-mono text-muted">Finding…</p>}
      {phase === 'error' && <p className="text-[13px] font-mono text-error">Couldn't reach the shops · tap search to try again</p>}
      {phase === 'capped' && <p className="text-[13px] font-mono text-muted">Daily limit reached · {resetsIn(resetsAt)}</p>}
      {phase === 'results' && products.length === 0 && (
        <p className="text-[13px] font-mono text-muted">No matching items found in Shopify stores.</p>
      )}
      {phase === 'results' && products.length > 0 && (
        <>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {products.map(p => (
              <ProductCard key={p.id} product={p} liked={liked.has(p.id)} onLike={() => void toggleLike(p)} variant="row" />
            ))}
          </div>
          <p className="text-[11px] font-mono text-muted uppercase tracking-[0.06em]">From Shopify stores</p>
        </>
      )}
    </section>
  )
}
