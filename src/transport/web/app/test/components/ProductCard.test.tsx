import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ProductCard, safeProductUrl } from '../../src/components/ProductCard'
import type { ShopProduct } from '../../src/api/shop'

const product: ShopProduct = {
  id: 'gid://shopify/p/1',
  title: 'Linen Shirt',
  imageUrl: 'https://cdn.shopify.com/a.jpg',
  price: '198.00 CAD',
  merchant: 'Faherty',
  url: 'https://www.faherty.example/p/1',
  available: true,
}

describe('safeProductUrl', () => {
  it('allows https and drops anything else', () => {
    expect(safeProductUrl('https://shop.example/p')).toBe('https://shop.example/p')
    expect(safeProductUrl('javascript:alert(1)')).toBeNull()
    expect(safeProductUrl('http://shop.example/p')).toBeNull()
    expect(safeProductUrl('not a url')).toBeNull()
    expect(safeProductUrl(null)).toBeNull()
  })
})

describe('ProductCard', () => {
  it('never renders a javascript: link', () => {
    render(<ProductCard product={{ ...product, url: 'javascript:alert(1)' }} />)
    expect(screen.queryByRole('link')).toBeNull()
    // Falls back to the merchant name rather than a host.
    expect(screen.getByText('Faherty')).toBeInTheDocument()
  })

  it('shows the merchant host without www and opens links safely', () => {
    render(<ProductCard product={product} />)
    expect(screen.getByText('faherty.example')).toBeInTheDocument()
    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('View is a full-width button linking to the product; there is no Add to closet', () => {
    render(<ProductCard product={product} variant="grid" />)
    const view = screen.getByRole('link', { name: /view linen shirt/i })
    expect(view).toHaveAttribute('href', 'https://www.faherty.example/p/1')
    expect(view.className).toContain('bg-accent')
    expect(screen.queryByText(/add to closet|save item|in closet/i)).toBeNull()
  })

  it('keeps a same-size inert View when there is no link', () => {
    render(<ProductCard product={{ ...product, url: null }} variant="grid" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('View')).toBeInTheDocument()
  })

  it('in select mode, tapping anywhere (even View) toggles selection and never navigates', () => {
    const onSelect = vi.fn()
    const onLike = vi.fn()
    render(
      <ProductCard product={product} onLike={onLike} onSelect={onSelect}
        selectable selected={false} variant="grid" />,
    )
    expect(screen.queryByRole('button', { name: /like/i })).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()

    fireEvent.click(screen.getByText('View'))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it('heart is a theme-token button: accent when liked, paper when not', () => {
    const { rerender } = render(<ProductCard product={product} onLike={vi.fn()} />)
    const off = screen.getByRole('button', { name: 'Like' })
    expect(off.className).toContain('bg-paper')
    expect(off.className).toContain('border-ink')
    expect(off.className).not.toMatch(/red-|black\//)
    rerender(<ProductCard product={product} liked onLike={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Unlike' }).className).toContain('bg-accent')
  })

  it('like button reports its pressed state', () => {
    const onLike = vi.fn()
    render(<ProductCard product={product} liked onLike={onLike} />)
    const btn = screen.getByRole('button', { name: 'Unlike' })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(btn)
    expect(onLike).toHaveBeenCalledOnce()
  })
})
