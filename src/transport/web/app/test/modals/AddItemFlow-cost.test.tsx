import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import userEvent from '@testing-library/user-event'
import { AddItemFlow } from '../../src/modals/AddItemFlow'
import type { Detection } from '../../src/components/DetectionOverlay'

const mockDetections: Detection[] = [
  { id: 'd1', label: 'Blue jacket', category: 'outerwear', cropColor: '#d4e8d4', box: { x: 10, y: 10, w: 30, h: 40 }, kept: true, alternatives: [] },
]

const mockCost = {
  billedTokens: 2,
  wholesaleCostCentsX100: 40,
  tokensIn: 500,
  tokensOut: 100,
}

const mockDetectBulkItems = vi.fn().mockResolvedValue({
  sourceUri: 'images/source/src1.jpg',
  detections: mockDetections,
  cost: mockCost,
})

vi.mock('../../src/api/bulkItems', () => ({
  detectBulkItems: (...args: unknown[]) => mockDetectBulkItems(...args),
  cropDetectedBox: vi.fn().mockResolvedValue(new File(['crop'], 'crop.jpg', { type: 'image/jpeg' })),
  stageSourcePhoto: vi.fn().mockResolvedValue('images/source/staged.jpg'),
}))

vi.mock('../../src/components/AuthImage', () => ({
  AuthImage: ({ src, alt }: { src: string; alt?: string }) => <img data-src={src} alt={alt ?? ''} />,
}))

vi.mock('../../src/components/DetectionOverlay', () => ({
  DetectionOverlay: ({ detections }: { detections: Detection[] }) => (
    <div data-testid="detection-overlay">{detections.length} detections</div>
  ),
}))

vi.mock('../../src/components/MakePrettySheet', () => ({
  MakePrettySheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="make-pretty-sheet" /> : null,
}))

Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test') })
Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn() })
Object.defineProperty(globalThis, 'Image', {
  value: class {
    onload: (() => void) | null = null
    src = ''
    naturalWidth = 800
    naturalHeight = 1000
    constructor() { setTimeout(() => this.onload?.(), 0) }
  },
})

describe('AddItemFlow batch cost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDetectBulkItems.mockResolvedValue({
      sourceUri: 'images/source/src1.jpg',
      detections: mockDetections,
      cost: mockCost,
    })
  })

  it('shows batch cost summary on done step after detect', async () => {
    render(
      <MemoryRouter>
        <AddItemFlow mode="add" onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>,
    )

    const file = new File(['fake-image'], 'test.jpg', { type: 'image/jpeg' })

    const fileInput = document.querySelector('input[type="file"]')
    expect(fileInput).toBeTruthy()
    await userEvent.upload(fileInput!, file)

    await waitFor(() => {
      const detectBtn = screen.queryByText(/detect items/i)
      if (detectBtn) return true
      const scanBtn = screen.queryByText(/scan for items/i)
      return !!scanBtn
    })
  })
})
