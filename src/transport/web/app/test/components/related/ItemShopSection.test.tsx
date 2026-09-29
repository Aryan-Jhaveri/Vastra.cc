import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// #332 — Related shop items in ItemDetail: opt-in, one find, More pages free.
vi.mock('../../../src/api/shop', () => ({
  fetchShopForItem: vi.fn(),
  fetchLikedProductIds: vi.fn().mockResolvedValue([]),
  likeProduct: vi.fn(),
  unlikeProduct: vi.fn(),
}))
vi.mock('../../../src/components/ProductCard', () => ({
  ProductCard: (p: { product: { title: string } }) => <div>{p.product.title}</div>,
}))

import { fetchShopForItem } from '../../../src/api/shop'
import { ItemShopSection } from '../../../src/components/related/ItemShopSection'

const prod = (t: string) => ({ id: `gid://shopify/p/${t}`, title: t, imageUrl: null, price: null, merchant: 'M', url: null, available: true })
const search = () => fireEvent.click(screen.getByRole('button', { name: 'Find shop items for this item' }))

beforeEach(() => vi.mocked(fetchShopForItem).mockReset())

describe('ItemShopSection', () => {
  it('makes no request until Search is tapped', async () => {
    render(<ItemShopSection itemId="i1" />)
    await new Promise(r => setTimeout(r, 10))
    expect(fetchShopForItem).not.toHaveBeenCalled()
    expect(screen.getByText(/Find pieces from Shopify stores/)).toBeInTheDocument()
  })

  it('Search shows products; More pages with the cursor, de-duplicated', async () => {
    vi.mocked(fetchShopForItem)
      .mockResolvedValueOnce({ kind: 'result', products: [prod('Chinos'), prod('Loafers')], nextCursor: 'c1' })
      .mockResolvedValueOnce({ kind: 'result', products: [prod('Loafers'), prod('Blazer')], nextCursor: null })
    render(<ItemShopSection itemId="i1" />)
    search()
    expect(await screen.findByText('Chinos')).toBeInTheDocument()
    expect(fetchShopForItem).toHaveBeenCalledWith('i1')
    fireEvent.click(screen.getByRole('button', { name: /more/i }))
    expect(await screen.findByText('Blazer')).toBeInTheDocument()
    expect(fetchShopForItem).toHaveBeenLastCalledWith('i1', 'c1')
    expect(screen.getAllByText('Loafers')).toHaveLength(1)
    await waitFor(() => expect(screen.queryByRole('button', { name: /more/i })).toBeNull())
  })

  it('shows the capped and error states', async () => {
    vi.mocked(fetchShopForItem).mockResolvedValueOnce({ kind: 'error' })
    render(<ItemShopSection itemId="i1" />)
    search()
    expect(await screen.findByText(/Couldn't reach the shops/)).toBeInTheDocument()
    vi.mocked(fetchShopForItem).mockResolvedValueOnce({ kind: 'capped', resetsAt: null })
    search()
    expect(await screen.findByText(/Daily limit reached/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Find shop items for this item' })).toBeDisabled()
  })
})
