import { render, screen, fireEvent } from '@testing-library/react'
import { ItemCard } from '../../src/components/ItemCard'
import type { Item } from '../../src/api/items'

const mockItem: Item = {
  id: 'item1',
  imageUri: 'images/items/test.jpg',
  category: 'tops',
  subcategory: 'T-shirt',
  primaryColor: 'white',
  colors: '["white"]',
  material: 'cotton',
  careInstructions: '[]',
  brand: null,
  size: null,
  season: '["summer"]',
  tags: '[]',
  aiDescription: null,
  occasion: '[]',
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  tagImageUri: null,
}

describe('ItemCard', () => {
  it('renders correct image src', () => {
    render(<ItemCard item={mockItem} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('data-src')
    expect(img.getAttribute('data-src')).toContain('test_thumb')
  })

  it('shows subcategory label', () => {
    render(<ItemCard item={mockItem} />)
    expect(screen.getByText('T-shirt')).toBeInTheDocument()
  })

  it('calls onClick when tapped', () => {
    const onClick = vi.fn()
    render(<ItemCard item={mockItem} onClick={onClick} />)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('shows border-transparent + marching ants when selected and selectable', () => {
    const { container } = render(<ItemCard item={mockItem} selectable selected />)
    const button = container.querySelector('button')
    expect(button?.className).toContain('border-transparent')
    expect(button?.className).toContain('animate-border-march')
    expect(button?.className).not.toContain('animate-select-wobble')
    expect(button?.className).not.toContain('overflow-hidden')
  })

  it('shows primary color when present', () => {
    render(<ItemCard item={mockItem} />)
    expect(screen.getByText('white')).toBeInTheDocument()
  })

  it('renders multiple colors from colors array, capped at 3 with +N overflow', () => {
    const multiColorItem: Item = {
      ...mockItem,
      colors: '["navy","cream","black","red"]',
      primaryColor: 'navy',
    }
    render(<ItemCard item={multiColorItem} />)
    expect(screen.getByText('navy, cream, black +1')).toBeInTheDocument()
  })

  it('renders all colors when 3 or fewer, no +N suffix', () => {
    const multiColorItem: Item = {
      ...mockItem,
      colors: '["navy","cream"]',
      primaryColor: 'navy',
    }
    render(<ItemCard item={multiColorItem} />)
    expect(screen.getByText('navy, cream')).toBeInTheDocument()
  })

  it('renders nothing when colors is empty', () => {
    const noColorItem: Item = {
      ...mockItem,
      colors: '[]',
      primaryColor: null,
    }
    render(<ItemCard item={noColorItem} />)
    expect(screen.queryByText('white')).not.toBeInTheDocument()
    const label = screen.getByText('T-shirt')
    expect(label.nextElementSibling?.tagName).toBe('DIV')
    expect(label.nextElementSibling).toHaveClass('min-h-[0.5rem]')
  })

  it('renders solid border when selectable and not selected', () => {
    const { container } = render(<ItemCard item={mockItem} selectable selected={false} />)
    const button = container.querySelector('button')
    expect(button?.className).toContain('border-ink')
    expect(button?.className).toContain('shadow-flat-xs')
    expect(button?.className).not.toContain('border-dashed')
  })

  it('renders marching ants border (no shadow, no overflow) when selectable and selected', () => {
    const { container } = render(<ItemCard item={mockItem} selectable selected />)
    const button = container.querySelector('button')
    expect(button?.className).toContain('border-transparent')
    expect(button?.className).not.toContain('shadow-flat-xs')
    expect(button?.className).not.toContain('overflow-hidden')
    expect(button?.className).toContain('animate-border-march')
    expect(button?.className).not.toContain('animate-select-wobble')
  })

  it('renders default styling (no dashed, no ring) when not selectable', () => {
    const { container } = render(<ItemCard item={mockItem} />)
    const button = container.querySelector('button')
    expect(button?.className).toContain('shadow-flat-xs')
    expect(button?.className).toContain('border-ink')
    expect(button?.className).not.toContain('border-dashed')
    expect(button?.className).not.toContain('ring-accent')
  })
})
