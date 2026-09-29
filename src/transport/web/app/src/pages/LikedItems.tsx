import { useState, useEffect, useCallback } from 'react'
import { ArrowLeft, X, Heart } from 'lucide-react'
import { useNavigate, useLocation } from 'react-router'
import { PageHeader } from '../components/PageHeader'
import { ProductCard } from '../components/ProductCard'
import { VastraLoader } from '../components/ui/VastraLoader'
import { useDelayedLoading } from '../hooks/useDelayedLoading'
import {
  fetchLikedProducts,
  unlikeProduct,
  bulkUnlikeProducts,
  type LikedProduct,
} from '../api/shop'
import { track } from '../lib/analytics'
import { CARD_GRID } from '../constants/grid'

interface Props {
  backTo: string
}

const BACK_LABELS: Record<string, string> = { '/closet': 'Closet', '/settings': 'Settings' }

const HEADER_BTN = 'border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-sans uppercase tracking-[0.04em] hover:bg-surface-dim shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base disabled:opacity-30'

export function LikedItems({ backTo }: Props) {
  const navigate = useNavigate()
  const location = useLocation()
  const [likes, setLikes] = useState<LikedProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const show = useDelayedLoading(loading)

  // Reloads from the first page. Catalog data is live on every load (never cached).
  const loadLikes = useCallback(async () => {
    try {
      const page = await fetchLikedProducts(0)
      setLikes(page.likes)
      setTotal(page.total)
      setNextOffset(page.nextOffset)
      setError(page.error ? "Couldn't reach Shopify — some items may not show details right now." : null)
    } catch {
      setLikes([])
      setTotal(0)
      setNextOffset(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMore = async () => {
    if (nextOffset === null || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await fetchLikedProducts(nextOffset)
      setLikes(prev => {
        const seen = new Set(prev.map(l => l.productId))
        return [...prev, ...page.likes.filter(l => !seen.has(l.productId))]
      })
      setTotal(page.total)
      setNextOffset(page.nextOffset)
    } catch {
      // Keep what's shown; the button stays so the user can retry.
    } finally {
      setLoadingMore(false)
    }
  }

  useEffect(() => {
    void loadLikes()
    track('page_view', { route: location.pathname })
  }, [loadLikes, location.pathname])

  const exitSelectMode = () => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const handleUnlike = useCallback(async (productId: string) => {
    setLikes(prev => prev.filter(l => l.productId !== productId))
    setTotal(t => Math.max(0, t - 1))
    try {
      await unlikeProduct(productId)
    } catch {
      void loadLikes()
    }
  }, [loadLikes])

  const handleBulkUnlike = async () => {
    setDeleting(true)
    try {
      await bulkUnlikeProducts([...selectedIds])
      setLikes(prev => prev.filter(l => !selectedIds.has(l.productId)))
      setTotal(t => Math.max(0, t - selectedIds.size))
      exitSelectMode()
    } catch {
      void loadLikes()
    } finally {
      setDeleting(false)
    }
  }

  const toggleSelect = (productId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(productId)) next.delete(productId)
      else next.add(productId)
      return next
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        {show ? <VastraLoader /> : null}
      </div>
    )
  }

  // One tap: unliking is easy to undo (tap ♡ again), so no confirm step.
  const headerRight = selectMode ? (
    <div className="flex gap-2">
      <button
        onClick={() => void handleBulkUnlike()}
        disabled={selectedIds.size === 0 || deleting}
        className={`${HEADER_BTN} border-error text-error`}
      >
        {deleting ? '…' : selectedIds.size > 0 ? `Remove ${selectedIds.size}` : 'Remove'}
      </button>
      <button onClick={exitSelectMode} className={`${HEADER_BTN} flex items-center gap-1`}>
        <X className="w-3 h-3" strokeWidth={2.5} /> Cancel
      </button>
    </div>
  ) : likes.length > 0 ? (
    <button onClick={() => setSelectMode(true)} className={HEADER_BTN}>
      Select
    </button>
  ) : undefined

  return (
    <div className="flex flex-col pb-20">
      {/* Same sticky header block as Closet; back link sits above the title
          (as in Settings → Guide) so the title rule spans the full width. */}
      <div className="sticky top-0 z-20 bg-paper px-4 pt-4 pb-3 flex flex-col gap-2">
        <button
          onClick={() => navigate(backTo)}
          className="self-start flex items-center gap-2 text-muted hover:text-ink transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">
            {BACK_LABELS[backTo] ?? 'Back'}
          </span>
        </button>
        <PageHeader
          title="Liked items"
          subtitle={
            selectMode
              ? (selectedIds.size > 0 ? `${selectedIds.size} selected` : 'select items')
              : `${total} ${total === 1 ? 'item' : 'items'}`
          }
          right={headerRight}
        />
      </div>

      <div className="flex flex-col px-4 pt-2">
        {error && (
          <p role="status" className="text-[14px] font-mono text-muted mb-3">{error}</p>
        )}

        {likes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center gap-3">
            <Heart className="w-8 h-8 text-muted" />
            <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] max-w-[18rem]">
              No liked items yet. Tap ♡ on shop items in Suggest or Discover.
            </p>
          </div>
        ) : (
          <div className={`${CARD_GRID} grid-cols-2 sm:grid-cols-3 animate-grid-in`}>
            {likes.map(like => like.product ? (
              <ProductCard
                key={like.productId}
                product={like.product}
                liked
                onLike={() => void handleUnlike(like.productId)}
                selectable={selectMode}
                selected={selectedIds.has(like.productId)}
                onSelect={() => toggleSelect(like.productId)}
                variant="grid"
              />
            ) : (
              <UnavailableCard
                key={like.productId}
                status={like.status}
                selectable={selectMode}
                selected={selectedIds.has(like.productId)}
                onSelect={() => toggleSelect(like.productId)}
                onRemove={() => void handleUnlike(like.productId)}
              />
            ))}
          </div>
        )}

        {nextOffset !== null && (
          <button
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className={`${HEADER_BTN} self-center mt-4`}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>

    </div>
  )
}

/** Same footprint as a grid ProductCard, for likes Shopify no longer lists
 *  (`gone`) or couldn't be looked up just now (`unknown`). */
function UnavailableCard({ status, selectable, selected, onSelect, onRemove }: {
  status: LikedProduct['status']
  selectable: boolean
  selected: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  const border = selectable && selected
    ? 'border-accent ring-[2px] ring-accent ring-offset-[-2px]'
    : 'border-ink shadow-flat-xs'
  return (
    <div
      role={selectable ? 'button' : undefined}
      aria-pressed={selectable ? selected : undefined}
      onClick={selectable ? onSelect : undefined}
      className={`relative flex flex-col w-full h-full border-2 ${border} overflow-hidden rounded-base bg-paper ${selectable ? 'cursor-pointer' : ''}`}
    >
      <div className="relative aspect-[3/4] bg-surface-dim border-b-2 border-ink flex items-center justify-center p-2 text-center">
        <span className="text-[14px] font-mono text-muted uppercase tracking-[0.04em]">
          {status === 'gone' ? 'No longer available' : "Couldn't load"}
        </span>
      </div>
      <div className="flex flex-1 flex-col p-2 gap-0.5">
        <p className="truncate text-[14px] font-bold font-mono uppercase tracking-[0.05em] text-muted leading-tight">
          {status === 'gone' ? 'Removed by store' : 'Try again later'}
        </p>
        {/* Mirrors ProductCard's merchant + price rows so the grid stays aligned. */}
        <p className="truncate text-[14px] font-mono text-muted leading-tight" aria-hidden="true">&nbsp;</p>
        <p className="h-5" aria-hidden="true" />
        <div className="mt-auto pt-1.5">
          <button
            onClick={(e) => { if (selectable) return; e.stopPropagation(); onRemove() }}
            tabIndex={selectable ? -1 : undefined}
            className="w-full h-8 text-[13px] font-bold font-mono uppercase tracking-[0.04em] border-2 border-ink rounded-base shadow-flat-xs bg-paper text-ink hover:bg-surface-dim transition-[transform,box-shadow,colors] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}
