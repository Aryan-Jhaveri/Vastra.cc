import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import type { LikedProduct, LikedProductsPage } from '../../src/api/shop'

vi.mock('../../src/api/shop', () => ({
  fetchLikedProducts: vi.fn(),
  unlikeProduct: vi.fn(),
  bulkUnlikeProducts: vi.fn(),
}))
vi.mock('../../src/lib/analytics', () => ({ track: vi.fn() }))

import { fetchLikedProducts, bulkUnlikeProducts } from '../../src/api/shop'
import * as shopApi from '../../src/api/shop'
import { LikedItems } from '../../src/pages/LikedItems'

function like(id: string, over: Partial<LikedProduct> = {}): LikedProduct {
  return {
    productId: `gid://shopify/p/${id}`,
    savedItemId: null,
    createdAt: 1,
    status: 'live',
    product: {
      id: `gid://shopify/p/${id}`, title: `Title ${id}`, imageUrl: null, price: '10.00 CAD',
      merchant: 'M', url: null, available: true,
    },
    ...over,
  }
}

function page(likes: LikedProduct[], over: Partial<LikedProductsPage> = {}): LikedProductsPage {
  return { likes, total: likes.length, nextOffset: null, ...over }
}

function renderPage(backTo = '/settings') {
  return render(
    <MemoryRouter>
      <LikedItems backTo={backTo} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('LikedItems', () => {
  it('labels the back link with where it returns to', async () => {
    vi.mocked(fetchLikedProducts).mockResolvedValue(page([]))
    renderPage('/closet')
    expect(await screen.findByRole('button', { name: /closet/i })).toBeInTheDocument()
    expect(screen.getByText(/no liked items yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
  })

  it('renders live catalog data for each like', async () => {
    vi.mocked(fetchLikedProducts).mockResolvedValue(page([like('a')]))
    renderPage()
    expect(await screen.findByText('Title a')).toBeInTheDocument()
    expect(screen.getByText('10.00 CAD')).toBeInTheDocument()
  })

  it('each liked card offers View, not Add to closet', async () => {
    vi.mocked(fetchLikedProducts).mockResolvedValue(page([
      like('a', { product: { ...like('a').product!, url: 'https://shop.example/a' } }),
    ]))
    renderPage()
    expect(await screen.findByRole('link', { name: /view title a/i })).toHaveAttribute('href', 'https://shop.example/a')
    expect(screen.queryByText(/add to closet/i)).toBeNull()
  })

  it('shows delisted and unloadable likes with a Remove button', async () => {
    vi.mocked(fetchLikedProducts).mockResolvedValue(page([
      like('gone', { status: 'gone', product: null }),
      like('unk', { status: 'unknown', product: null }),
    ], { error: 'catalog_unavailable' }))
    vi.mocked(shopApi.unlikeProduct).mockResolvedValue()

    renderPage()
    expect(await screen.findByText('No longer available')).toBeInTheDocument()
    expect(screen.getByText("Couldn't load")).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/couldn't reach shopify/i)

    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0])
    await waitFor(() => expect(shopApi.unlikeProduct).toHaveBeenCalledWith('gid://shopify/p/gone'))
    expect(screen.queryByText('No longer available')).toBeNull()
  })

  it('Load more fetches the next page', async () => {
    vi.mocked(fetchLikedProducts)
      .mockResolvedValueOnce(page([like('a')], { total: 2, nextOffset: 1 }))
      .mockResolvedValueOnce(page([like('b')], { total: 2, nextOffset: null }))

    renderPage()
    await screen.findByText('Title a')
    expect(screen.getByText('2 items')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))

    expect(await screen.findByText('Title b')).toBeInTheDocument()
    expect(vi.mocked(fetchLikedProducts).mock.calls[1]).toEqual([1])
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })

  it('select mode removes the chosen likes with one red Remove tap', async () => {
    vi.mocked(fetchLikedProducts).mockResolvedValue(page([like('a'), like('b')]))
    vi.mocked(bulkUnlikeProducts).mockResolvedValue()

    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }))
    // Nothing selected yet → Remove is disabled.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
    fireEvent.click(screen.getByText('Title a'))
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    const remove = screen.getByRole('button', { name: 'Remove 1' })
    expect(remove.className).toContain('text-error')
    fireEvent.click(remove)

    await waitFor(() => expect(bulkUnlikeProducts).toHaveBeenCalledWith(['gid://shopify/p/a']))
    await waitFor(() => expect(screen.queryByText('Title a')).toBeNull())
    expect(screen.getByText('Title b')).toBeInTheDocument()
  })
})
