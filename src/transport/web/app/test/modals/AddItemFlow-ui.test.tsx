import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import userEvent from '@testing-library/user-event'
import { AddItemFlow } from '../../src/modals/AddItemFlow'
import type { Detection } from '../../src/components/DetectionOverlay'

const mockDetectBulkItems = vi.fn()
const mockAnalyzeItem = vi.fn()
const mockCreateItem = vi.fn()
const mockDeleteItem = vi.fn()
const mockFetchItemMeta = vi.fn()

vi.mock('../../src/api/bulkItems', () => ({
  detectBulkItems: (...args: unknown[]) => mockDetectBulkItems(...args),
  cropDetectedBox: vi.fn().mockResolvedValue(new File(['crop'], 'crop.jpg', { type: 'image/jpeg' })),
  stageSourcePhoto: vi.fn().mockResolvedValue('images/source/staged.jpg'),
}))

vi.mock('../../src/api/items', () => ({
  analyzeItem: (...args: unknown[]) => mockAnalyzeItem(...args),
  createItem: (...args: unknown[]) => mockCreateItem(...args),
  deleteItem: (...args: unknown[]) => mockDeleteItem(...args),
  fetchItemMeta: (...args: unknown[]) => mockFetchItemMeta(...args),
  fetchItemImages: vi.fn(),
  uploadItemImage: vi.fn(),
  deleteItemImage: vi.fn(),
  setItemImagePrimary: vi.fn(),
}))

// The hosted index as the open-source stub, with a spy on the balance fetch.
const mockFetchTokenBalance = vi.fn()
vi.mock('../../src/hosted', async () => ({
  ...(await import('../helpers/hostedStub')),
  fetchTokenBalance: (...args: unknown[]) => mockFetchTokenBalance(...args),
}))

// #315 — billing off (self-host). The hosted billing gate is tested in
// test/hosted/modals/AddItemFlow-billing.test.tsx.
const billingEnabledMock = { value: false }
vi.mock('../../src/hooks/useBillingEnabled', () => ({
  useBillingEnabled: () => billingEnabledMock.value,
}))

vi.mock('../../src/lib/cropToBbox', () => ({
  cropToBbox: vi.fn().mockResolvedValue(new File(['crop'], 'crop.jpg', { type: 'image/jpeg' })),
}))

vi.mock('../../src/lib/analytics', () => ({ track: vi.fn() }))

vi.mock('../../src/components/AuthImage', () => ({
  AuthImage: ({ src, alt }: { src: string; alt?: string }) => <img data-src={src} alt={alt ?? ''} />,
}))

vi.mock('../../src/components/MakePrettySheet', () => ({
  MakePrettySheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="make-pretty-sheet" /> : null,
}))

Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:test') })
Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn() })
// AddItemFlow's scroll-lock cleanup calls window.scrollTo, which jsdom doesn't implement
window.scrollTo = () => {}
Object.defineProperty(globalThis, 'Image', {
  value: class {
    onload: (() => void) | null = null
    src = ''
    naturalWidth = 800
    naturalHeight = 1000
    constructor() { setTimeout(() => this.onload?.(), 0) }
  },
})

function makeDetections(call: number, n: number): Detection[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `d${call}-${i}`,
    label: 'Item',
    category: 'tops',
    cropColor: 'var(--color-accent)',
    box: { x: 10, y: 10, w: 30, h: 40 },
    kept: true,
    alternatives: [],
  }))
}

const imgFile = (name: string) => new File(['fake-image'], name, { type: 'image/jpeg' })

async function uploadAndContinue(user: ReturnType<typeof userEvent.setup>, count: number) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await user.upload(input, Array.from({ length: count }, (_, i) => imgFile(`p${i}.jpg`)))
  await user.click(await screen.findByText('continue'))
}

async function autoDetect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /auto-detect/ }))
  await waitFor(() => {
    const skip = screen.queryByText('skip to review →')
    const review = screen.queryByRole('button', { name: /^review \d/ })
    expect(skip || review).toBeTruthy()
  })
}

async function proceedToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^review \d/ }))
  await screen.findByText('item 1 of 2')
}

describe('AddItemFlow UI polish (#286)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    billingEnabledMock.value = false
    let detectCalls = 0
    mockDetectBulkItems.mockImplementation(() => {
      detectCalls++
      return Promise.resolve({
        sourceUri: `images/source/s${detectCalls}.jpg`,
        detections: makeDetections(detectCalls, 2),
        cost: null,
      })
    })
    mockFetchItemMeta.mockResolvedValue({ categories: [] })
    mockAnalyzeItem.mockResolvedValue({
      category: 'tops', subcategory: 't-shirt', primary_color: 'blue',
      colors: ['blue'], material: 'cotton', season: ['summer'],
      ai_description: 'A tee', suggested_tags: ['casual'], wear_context: null,
    })
    mockCreateItem.mockResolvedValue({ id: 'c1', imageUri: 'images/items/c1.jpg', category: 'tops', subcategory: 't-shirt' })
    mockDeleteItem.mockResolvedValue(undefined)
  })

  it('shows "skip to review" on non-last photos but hides it on the last photo', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AddItemFlow mode="closet-add" onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>,
    )
    await uploadAndContinue(user, 2)
    await autoDetect(user)

    expect(screen.getByText('skip to review →')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /next photo/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^review \d/ })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /next photo/ }))

    expect(screen.getByText('photo 2 of 2')).toBeInTheDocument()
    expect(screen.queryByText('skip to review →')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^review \d/ })).toBeInTheDocument()
  })

  it('header back and close are bordered theme icon buttons', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AddItemFlow mode="closet-add" onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>,
    )
    await uploadAndContinue(user, 1)
    await autoDetect(user)

    for (const name of ['Back', 'Close']) {
      const btn = screen.getByRole('button', { name })
      expect(btn.className).toContain('border-2')
      expect(btn.className).toContain('border-ink')
      expect(btn.className).toContain('bg-paper')
      expect(btn.className).toContain('rounded-base')
      expect(btn.className).toContain('shadow-flat-xs')
      expect(btn.className).toContain('active:translate-x-[2px]')
      expect(btn.className).toContain('active:translate-y-[2px]')
      expect(btn.className).toContain('active:shadow-none')
    }
  })

  it('review dots are uniform in size, coloured by state, active one ringed', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AddItemFlow mode="closet-add" onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>,
    )
    await uploadAndContinue(user, 1)
    await autoDetect(user)
    await proceedToReview(user)

    const dots = [
      screen.getByRole('button', { name: 'Go to item 1' }),
      screen.getByRole('button', { name: 'Go to item 2' }),
    ]
    for (const dot of dots) {
      expect(dot.className).toContain('w-2.5 h-2.5 md:w-3 md:h-3')
      expect(dot.className).not.toContain('md:w-1.5')
    }
    expect(dots[0].className).toContain('bg-accent')
    expect(dots[0].className).toContain('ring-2 ring-accent')
    expect(dots[1].className).toContain('bg-outline-variant')
    expect(dots[1].className).not.toContain('ring-2')
  })

  it('edit and cancel are theme buttons; cancel still skips without a swipe', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AddItemFlow mode="closet-add" onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>,
    )
    await uploadAndContinue(user, 1)
    await autoDetect(user)
    await proceedToReview(user)

    const edit = screen.getByText('edit')
    expect(edit.className).toContain('border-2 border-ink')
    expect(edit.className).toContain('rounded-base')
    expect(edit.className).toContain('shadow-flat-xs')
    expect(edit.className).toContain('active:translate-x-[2px]')
    expect(edit.className).not.toContain('border-outline-variant')

    const cancel = screen.getByText('cancel')
    expect(cancel.className).toContain('border-2 border-error')
    expect(cancel.className).toContain('text-error')
    expect(cancel.className).toContain('bg-paper')
    expect(cancel.className).toContain('rounded-base')
    expect(cancel.className).toContain('shadow-flat-xs')

    await user.click(cancel)

    expect(await screen.findByText('item 2 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Go to item 1' }).className).toContain('bg-error')
  })

  it('remove on a saved item un-saves it via deleteItem', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AddItemFlow mode="closet-add" onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>,
    )
    await uploadAndContinue(user, 1)
    await autoDetect(user)
    await proceedToReview(user)

    const save = screen.getByRole('button', { name: 'save' })
    await waitFor(() => expect(save).not.toBeDisabled())
    await user.click(save)

    await screen.findByText('item 2 of 2')
    await user.click(screen.getByRole('button', { name: 'Go to item 1' }))
    const remove = await screen.findByText('remove')
    expect(remove.className).toContain('border-2 border-error')

    await user.click(remove)

    await waitFor(() => expect(mockDeleteItem).toHaveBeenCalledWith('c1'))
    expect(screen.getByRole('button', { name: 'Go to item 1' }).className).toContain('bg-error')
  })

  // #347 — a retry of one item reuses its idempotency key, so a save whose
  // response was lost can't create the item twice.
  it('retries a failed save with the same idempotency key; other items get their own', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AddItemFlow mode="closet-add" onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>,
    )
    await uploadAndContinue(user, 1)
    await autoDetect(user)
    await proceedToReview(user)

    mockCreateItem.mockRejectedValueOnce(new Error('network'))
    const save = screen.getByRole('button', { name: 'save' })
    await waitFor(() => expect(save).not.toBeDisabled())
    await user.click(save)
    await screen.findByText('item 2 of 2')

    await user.click(screen.getByRole('button', { name: 'Go to item 1' }))
    const retry = await screen.findByRole('button', { name: 'save' })
    await waitFor(() => expect(retry).not.toBeDisabled())
    await user.click(retry)
    await waitFor(() => expect(mockCreateItem).toHaveBeenCalledTimes(2))

    const keyOf = (call: number) => (mockCreateItem.mock.calls[call][2] as { idempotencyKey: string }).idempotencyKey
    expect(keyOf(0)).toMatch(/^[A-Za-z0-9_-]{8,128}$/)
    expect(keyOf(1)).toBe(keyOf(0))

    await user.click(screen.getByRole('button', { name: 'Go to item 2' }))
    const save2 = await screen.findByRole('button', { name: 'save' })
    await waitFor(() => expect(save2).not.toBeDisabled())
    await user.click(save2)
    await waitFor(() => expect(mockCreateItem).toHaveBeenCalledTimes(3))
    expect(keyOf(2)).not.toBe(keyOf(0))
  })

  it('a removed item saved again gets a fresh key, not a replay of the deleted one', async () => {
    const user = userEvent.setup()
    render(
      <MemoryRouter>
        <AddItemFlow mode="closet-add" onClose={vi.fn()} onSaved={vi.fn()} />
      </MemoryRouter>,
    )
    await uploadAndContinue(user, 1)
    await autoDetect(user)
    await proceedToReview(user)

    const save = screen.getByRole('button', { name: 'save' })
    await waitFor(() => expect(save).not.toBeDisabled())
    await user.click(save)
    await screen.findByText('item 2 of 2')
    await user.click(screen.getByRole('button', { name: 'Go to item 1' }))
    await user.click(await screen.findByText('remove'))
    await waitFor(() => expect(mockDeleteItem).toHaveBeenCalledWith('c1'))

    await user.click(screen.getByRole('button', { name: 'Go to item 1' }))
    const again = await screen.findByRole('button', { name: 'save' })
    await user.click(again)
    await waitFor(() => expect(mockCreateItem).toHaveBeenCalledTimes(2))
    const keyOf = (call: number) => (mockCreateItem.mock.calls[call][2] as { idempotencyKey: string }).idempotencyKey
    expect(keyOf(1)).not.toBe(keyOf(0))
  })

  describe('billing gate (#315)', () => {
    it('self-host: no token cost, no wallet fetch, and auto-detect still runs', async () => {
      billingEnabledMock.value = false
      // /api/billing is unmounted on self-host — a fetch would 404.
      mockFetchTokenBalance.mockRejectedValue(new Error('404'))
      const user = userEvent.setup()
      render(<MemoryRouter><AddItemFlow mode="add" onClose={vi.fn()} onSaved={vi.fn()} /></MemoryRouter>)
      await uploadAndContinue(user, 1)
      expect(screen.getByRole('button', { name: /auto-detect/ }).textContent).not.toMatch(/tokens/)
      await autoDetect(user)
      expect(mockDetectBulkItems).toHaveBeenCalledTimes(1)
      expect(mockFetchTokenBalance).not.toHaveBeenCalled()
      expect(screen.queryByText(/could not verify token balance/i)).toBeNull()
    })
  })
})
