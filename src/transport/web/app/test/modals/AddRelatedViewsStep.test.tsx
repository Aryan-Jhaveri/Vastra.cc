import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchItemImages = vi.fn()
let makePrettyProps: Record<string, any> = {}

vi.mock('../../src/api/items', () => ({
  fetchItemImages: (...args: unknown[]) => mockFetchItemImages(...args),
  uploadItemImage: vi.fn(),
  deleteItemImage: vi.fn(),
  setItemImagePrimary: vi.fn(),
}))

vi.mock('../../src/components/AuthImage', () => ({
  AuthImage: ({ src, alt }: { src: string; alt?: string }) => <img data-src={src} alt={alt ?? ''} />,
}))

vi.mock('../../src/components/MakePrettySheet', () => ({
  MakePrettySheet: (props: any) => {
    makePrettyProps = props
    return props.open ? <div data-testid="make-pretty-sheet" /> : null
  },
}))

import { AddRelatedViewsStep, type ExtrasItem } from '../../src/modals/AddRelatedViewsStep'

const mockItems: ExtrasItem[] = [
  { id: 'item-1', imageUri: 'images/items/a.jpg', label: 'Blue T-Shirt' },
  { id: 'item-2', imageUri: 'images/items/b.jpg', label: 'Black Jeans' },
]

function renderStep(items: ExtrasItem[] = mockItems) {
  return render(<AddRelatedViewsStep items={items} onDone={vi.fn()} />)
}

describe('AddRelatedViewsStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    makePrettyProps = {}
    mockFetchItemImages.mockResolvedValue([
      { id: 'img-1', imageUri: 'images/items/a.jpg', role: 'source', isPrimary: 1, position: 0 },
    ] as any)
  })

  it('wires onGenerated → refreshes byItem for the active item', async () => {
    const initialImages = [
      { id: 'img-1', imageUri: 'images/items/a.jpg', role: 'source', isPrimary: 1, position: 0 },
    ] as any
    const afterGenImages = [
      { id: 'img-1', imageUri: 'images/items/a.jpg', role: 'source', isPrimary: 1, position: 0 },
      { id: 'gen-1', imageUri: 'images/items/gen.jpg', role: 'generated', isPrimary: 0, position: 1 },
    ] as any

    mockFetchItemImages.mockResolvedValueOnce(initialImages).mockResolvedValueOnce(initialImages).mockResolvedValue(afterGenImages)

    renderStep()

    // wait for initial load — fetchItemImages called for each item
    await waitFor(() => {
      expect(mockFetchItemImages).toHaveBeenCalledWith('item-1')
      expect(mockFetchItemImages).toHaveBeenCalledWith('item-2')
    })

    // open MakePrettySheet for item-1
    const generateBtn = screen.getAllByText('Generate Cover Photo')[0]
    generateBtn.click()

    await waitFor(() => {
      expect(screen.getByTestId('make-pretty-sheet')).toBeInTheDocument()
    })

    expect(makePrettyProps.itemId).toBe('item-1')

    const callsBeforeGen = mockFetchItemImages.mock.calls.length

    // simulate generation completing
    makePrettyProps.onGenerated()

    await waitFor(() => {
      expect(mockFetchItemImages.mock.calls.length).toBeGreaterThan(callsBeforeGen)
    })
  })
})
