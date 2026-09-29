import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { ShopProduct, ShopQuery, ShopRankContext } from '../../../src/api/shop'

vi.mock('../../../src/api/shop', () => ({
  fetchRelatedShop: vi.fn(),
  likeProduct: vi.fn(),
  unlikeProduct: vi.fn(),
}))

import { fetchRelatedShop, likeProduct } from '../../../src/api/shop'
import { RelatedShopItemsSection, SHOP_BATCH } from '../../../src/components/home/sections/RelatedShopItemsSection'

function p(id: string, title = id): ShopProduct {
  return { id, title, imageUrl: null, price: null, merchant: 'M', url: null, available: true }
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
})

const sq = (query: string, intent?: string): ShopQuery => (intent ? { query, intent } : { query })

const NO_CTX: ShopRankContext = { itemIds: [], outfitIds: [], recommendations: [] }
const CTX: ShopRankContext = { itemIds: ['i1'], outfitIds: ['o1'], recommendations: [] }

function section(shopQuery: ShopQuery | null, rankContext: ShopRankContext = NO_CTX, likedProductIds = new Set<string>(), onLikeToggle = vi.fn()) {
  return <RelatedShopItemsSection shopQuery={shopQuery} rankContext={rankContext} likedProductIds={likedProductIds} onLikeToggle={onLikeToggle} />
}

function renderSection(shopQuery: ShopQuery | null, rankContext: ShopRankContext = NO_CTX, likedProductIds = new Set<string>(), onLikeToggle = vi.fn()) {
  return render(section(shopQuery, rankContext, likedProductIds, onLikeToggle))
}

const search = () => fireEvent.click(screen.getByRole('button', { name: /search/i }))
const many = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => p(`${prefix}${i}`, `Product ${prefix}${i}`))

describe('RelatedShopItemsSection — opt-in (#336)', () => {
  it('renders nothing before the shop query arrives', () => {
    const { container } = renderSection(null)
    expect(container).toBeEmptyDOMElement()
    expect(fetchRelatedShop).not.toHaveBeenCalled()
  })

  it('never calls the shop on its own: it shows a Search button and waits', async () => {
    renderSection(sq('rain jacket'), CTX)
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /more/i })).toBeNull()
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(fetchRelatedShop).not.toHaveBeenCalled()
  })

  it('Search fetches once, ranked against closet items/outfits only, then turns into More', async () => {
    vi.mocked(fetchRelatedShop).mockResolvedValue({ products: many(SHOP_BATCH + 1), nextCursor: null, ranked: true })
    renderSection(sq('rain jacket'), CTX)
    search()
    await screen.findByText('Product p0')
    expect(fetchRelatedShop).toHaveBeenCalledExactlyOnceWith({ query: 'rain jacket' }, undefined, CTX)
    expect(screen.queryByRole('button', { name: /search/i })).toBeNull()
    expect(screen.getByRole('button', { name: /more/i })).toBeInTheDocument()
  })

  it('sends no context (catalog order) when no closet items or outfits are on screen yet', async () => {
    vi.mocked(fetchRelatedShop).mockResolvedValue({ products: [p('a', 'One')], nextCursor: null })
    renderSection(sq('rain jacket'), NO_CTX)
    search()
    await screen.findByText('One')
    expect(fetchRelatedShop).toHaveBeenCalledWith({ query: 'rain jacket' }, undefined, undefined)
  })

  it('does not re-rank or refetch when the context changes after the search', async () => {
    vi.mocked(fetchRelatedShop).mockResolvedValue({ products: [p('a', 'One')], nextCursor: null })
    const { rerender } = renderSection(sq('ctx'), NO_CTX)
    search()
    await screen.findByText('One')
    rerender(section(sq('ctx'), CTX))
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(fetchRelatedShop).toHaveBeenCalledOnce()
  })

  it('a new run goes back to idle: old results cleared, Search shown, no automatic call', async () => {
    vi.mocked(fetchRelatedShop).mockResolvedValue({ products: [p('a', 'Old Shirt')], nextCursor: null })
    const { rerender } = renderSection(sq('linen shirt'))
    search()
    await screen.findByText('Old Shirt')

    rerender(section(sq('linen shirt', 'Outfit for rain')))
    expect(screen.queryByText('Old Shirt')).toBeNull()
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
    expect(fetchRelatedShop).toHaveBeenCalledOnce()
  })

  it('ignores a slow response from the previous run', async () => {
    let resolveOld!: (v: { products: ShopProduct[]; nextCursor: null }) => void
    vi.mocked(fetchRelatedShop).mockReturnValueOnce(new Promise(r => { resolveOld = r }))
    const { rerender } = renderSection(sq('old'))
    search()
    rerender(section(sq('new')))
    await act(async () => { resolveOld({ products: [p('x', 'Stale')], nextCursor: null }) })
    expect(screen.queryByText('Stale')).toBeNull()
  })

  it('says so when a search finds nothing, instead of vanishing', async () => {
    vi.mocked(fetchRelatedShop).mockResolvedValue({ products: [], nextCursor: null })
    renderSection(sq('rain jacket'))
    search()
    expect(await screen.findByText(/No matching items found/)).toBeInTheDocument()
  })

  it('shows the top batch in server order; More reveals the next batch without a fetch', async () => {
    vi.mocked(fetchRelatedShop).mockResolvedValue({ products: many(SHOP_BATCH * 2 + 1), nextCursor: null, ranked: true })
    renderSection(sq('ctx'))
    search()
    await screen.findByText('Product p0')

    const titles = () => screen.getAllByText(/^Product p\d+$/).map(e => e.textContent)
    expect(titles()).toEqual(many(SHOP_BATCH).map(x => x.title))
    fireEvent.click(screen.getByRole('button', { name: /more/i }))
    expect(titles()).toHaveLength(SHOP_BATCH * 2)
    fireEvent.click(screen.getByRole('button', { name: /more/i }))
    expect(titles()).toHaveLength(SHOP_BATCH * 2 + 1)
    expect(fetchRelatedShop).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /more/i })).toBeNull()
  })

  it('once the pool is shown, More fetches the next page with the same context, de-duplicated', async () => {
    vi.mocked(fetchRelatedShop)
      .mockResolvedValueOnce({ products: [p('a', 'One'), p('b', 'Two')], nextCursor: 'c1', ranked: true })
      .mockResolvedValueOnce({ products: [p('b', 'Two'), p('c', 'Three')], nextCursor: null, ranked: true })
    renderSection(sq('ctx'), CTX)
    search()
    await screen.findByText('One')
    fireEvent.click(screen.getByRole('button', { name: /more/i }))

    expect(await screen.findByText('Three')).toBeInTheDocument()
    expect(screen.getAllByText('Two')).toHaveLength(1)
    expect(vi.mocked(fetchRelatedShop).mock.calls[1]).toEqual([{ query: 'ctx' }, 'c1', CTX])
    expect(screen.queryByRole('button', { name: /more/i })).toBeNull()
  })

  it('reverts the heart when liking fails', async () => {
    vi.mocked(fetchRelatedShop).mockResolvedValue({ products: [p('a', 'One')], nextCursor: null })
    vi.mocked(likeProduct).mockRejectedValue(new Error('HTTP 400'))
    const onLikeToggle = vi.fn()

    renderSection(sq('ctx'), NO_CTX, new Set(), onLikeToggle)
    search()
    await screen.findByText('One')
    fireEvent.click(screen.getByRole('button', { name: 'Like' }))

    await waitFor(() => expect(onLikeToggle).toHaveBeenCalledTimes(2))
    expect(onLikeToggle.mock.calls).toEqual([['a', true], ['a', false]])
    expect(likeProduct).toHaveBeenCalledWith('a')
  })
})
