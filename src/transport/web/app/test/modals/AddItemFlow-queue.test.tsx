import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import userEvent from '@testing-library/user-event'
import { AddItemFlow } from '../../src/modals/AddItemFlow'
import type { Detection } from '../../src/components/DetectionOverlay'
import { RateLimitedError } from '../../src/lib/rateLimitRetry'

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

// Billing is off below, so the hosted index is only ever the open-source stub.
vi.mock('../../src/hosted', () => import('../helpers/hostedStub'))

// #315 — billing off (self-host) for the queue tests.
const billingEnabledMock = { value: false }
vi.mock('../../src/hooks/useBillingEnabled', () => ({
  useBillingEnabled: () => billingEnabledMock.value,
}))

vi.mock('../../src/lib/cropToBbox', () => ({
  cropToBbox: vi.fn().mockResolvedValue(new File(['crop'], 'crop.jpg', { type: 'image/jpeg' })),
}))

vi.mock('../../src/lib/analytics', () => ({ track: vi.fn() }))

// jsdom has no createImageBitmap, so the real helper would always return null;
// mocked so a test can opt into thumbnails.
const mockMakeThumb = vi.fn()
vi.mock('../../src/lib/photoThumbnail', () => ({
  makePhotoThumbnail: (...args: unknown[]) => mockMakeThumb(...args),
}))

vi.mock('../../src/components/AuthImage', () => ({
  AuthImage: ({ src, alt }: { src: string; alt?: string }) => <img data-src={src} alt={alt ?? ''} />,
}))

vi.mock('../../src/components/MakePrettySheet', () => ({
  MakePrettySheet: ({ open }: { open: boolean }) =>
    open ? <div data-testid="make-pretty-sheet" /> : null,
}))

let urlSeq = 0
const createObjectURL = vi.fn(() => `blob:test-${++urlSeq}`)
const revokeObjectURL = vi.fn()
Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
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

function renderFlow() {
  return render(
    <MemoryRouter>
      <AddItemFlow mode="closet-add" onClose={vi.fn()} onSaved={vi.fn()} />
    </MemoryRouter>,
  )
}

async function upload(user: ReturnType<typeof userEvent.setup>, count: number) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  await user.upload(input, Array.from({ length: count }, (_, i) => imgFile(`p${i}.jpg`)))
}

/** A mock whose calls stay pending until released; tracks peak concurrency. */
function gatedMock<T>(value: (call: number) => T) {
  let active = 0
  let calls = 0
  const state = { peak: 0, pending: [] as Array<() => void> }
  const impl = () => {
    const call = ++calls
    active++
    state.peak = Math.max(state.peak, active)
    return new Promise<T>(resolve => {
      state.pending.push(() => { active--; resolve(value(call)) })
    })
  }
  const releaseAll = async () => {
    while (state.pending.length) {
      state.pending.splice(0).forEach(r => r())
      await new Promise(r => setTimeout(r, 0))
    }
  }
  return { impl, state, releaseAll, get calls() { return calls } }
}

describe('AddItemFlow bulk queue + object URL cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    billingEnabledMock.value = false
    mockMakeThumb.mockResolvedValue(null)
    mockFetchItemMeta.mockResolvedValue({ categories: [] })
    mockAnalyzeItem.mockResolvedValue({
      category: 'tops', subcategory: 't-shirt', primary_color: 'blue',
      colors: ['blue'], material: 'cotton', season: ['summer'],
      ai_description: 'A tee', suggested_tags: [], wear_context: null,
    })
  })

  it('auto-detect keeps at most 2 photos in flight and shows each result as it lands', async () => {
    const detect = gatedMock(call => ({ sourceUri: `images/source/s${call}.jpg`, detections: makeDetections(call, 1), cost: null }))
    mockDetectBulkItems.mockImplementation(detect.impl)
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 3)
    await user.click(await screen.findByText('continue'))
    await user.click(screen.getByRole('button', { name: /auto-detect/ }))

    await waitFor(() => expect(detect.calls).toBe(2))
    expect(detect.state.peak).toBe(2)

    // Releasing one photo lets the third start while the second is still pending.
    detect.state.pending.shift()!()
    await waitFor(() => expect(detect.calls).toBe(3))
    expect(detect.state.peak).toBe(2)

    await detect.releaseAll()
    await waitFor(() => expect(screen.getByText('skip to review →')).toBeInTheDocument())
  })

  it('crop → classify runs at most 3 boxes at a time and finishes all of them', async () => {
    mockDetectBulkItems.mockResolvedValue({ sourceUri: 'images/source/s1.jpg', detections: makeDetections(1, 8), cost: null })
    const classify = gatedMock(() => ({
      category: 'tops', subcategory: 't-shirt', primary_color: 'blue', colors: ['blue'],
      material: 'cotton', season: ['summer'], ai_description: 'A tee', suggested_tags: [], wear_context: null,
    }))
    mockAnalyzeItem.mockImplementation(classify.impl)
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 1)
    await user.click(await screen.findByText('continue'))
    await user.click(screen.getByRole('button', { name: /auto-detect/ }))
    await user.click(await screen.findByRole('button', { name: /^review \d/ }))

    await waitFor(() => expect(classify.calls).toBe(3))
    expect(classify.state.peak).toBe(3)
    await classify.releaseAll()
    await waitFor(() => expect(classify.calls).toBe(8))
    await classify.releaseAll()
    expect(classify.state.peak).toBe(3)
    // Crops come from the server copy of the photo, never the browser canvas.
    const { cropDetectedBox } = await import('../../src/api/bulkItems')
    const { cropToBbox } = await import('../../src/lib/cropToBbox')
    expect(vi.mocked(cropDetectedBox)).toHaveBeenCalledTimes(8)
    expect(vi.mocked(cropDetectedBox).mock.calls[0][0]).toBe('images/source/s1.jpg')
    expect(vi.mocked(cropDetectedBox).mock.calls[0][1]).toMatchObject({ x: expect.any(Number), w: expect.any(Number) })
    expect(vi.mocked(cropToBbox)).not.toHaveBeenCalled()
  })

  it('a photo with no server copy (hand-drawn boxes) is staged once, then every box is cropped on the server', async () => {
    mockDetectBulkItems.mockResolvedValue({ sourceUri: undefined, detections: makeDetections(1, 3), cost: null })
    mockAnalyzeItem.mockResolvedValue({
      category: 'shoes', subcategory: 'sneakers', primary_color: 'white', colors: ['white'],
      material: null, season: [], ai_description: 'Sneakers', suggested_tags: [], wear_context: null,
    })
    const { cropDetectedBox, stageSourcePhoto } = await import('../../src/api/bulkItems')
    const { cropToBbox } = await import('../../src/lib/cropToBbox')
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 1)
    await user.click(await screen.findByText('continue'))
    await user.click(screen.getByRole('button', { name: /auto-detect/ }))
    await user.click(await screen.findByRole('button', { name: /^review \d/ }))
    await waitFor(() => expect(mockAnalyzeItem).toHaveBeenCalledTimes(3))
    expect(vi.mocked(stageSourcePhoto)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(cropDetectedBox).mock.calls.map(c => c[0])).toEqual(Array(3).fill('images/source/staged.jpg'))
    expect(vi.mocked(cropToBbox)).not.toHaveBeenCalled()
  })

  it('removing a photo revokes its preview URL', async () => {
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 2)
    const first = (await screen.findByAltText('photo 1')).getAttribute('src')
    await user.click(screen.getByRole('button', { name: 'Remove photo 1' }))
    expect(revokeObjectURL).toHaveBeenCalledWith(first)
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
  })

  it('unmount revokes every photo and crop preview the flow created', async () => {
    mockDetectBulkItems.mockResolvedValue({ sourceUri: 'images/source/s1.jpg', detections: makeDetections(1, 2), cost: null })
    const user = userEvent.setup()
    const { unmount } = renderFlow()
    await upload(user, 1)
    await user.click(await screen.findByText('continue'))
    await user.click(screen.getByRole('button', { name: /auto-detect/ }))
    await user.click(await screen.findByRole('button', { name: /^review \d/ }))
    await waitFor(() => expect(mockAnalyzeItem).toHaveBeenCalledTimes(2))

    const created = createObjectURL.mock.results.map(r => r.value as string)
    expect(created.length).toBe(3) // 1 photo preview + 2 crop previews
    unmount()
    const revoked = revokeObjectURL.mock.calls.map(c => c[0])
    for (const url of created) expect(revoked).toContain(url)
  })
})

const tee = {
  category: 'tops', subcategory: 't-shirt', primary_color: 'blue', colors: ['blue'],
  material: 'cotton', season: ['summer'], ai_description: 'A tee', suggested_tags: [], wear_context: null,
}

/** Flush pending promise chains and timers up to `ms` under fake timers. */
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

describe('AddItemFlow large batches (no 3-photo cap)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    billingEnabledMock.value = false
    mockMakeThumb.mockResolvedValue(null)
    mockFetchItemMeta.mockResolvedValue({ categories: [] })
    mockAnalyzeItem.mockResolvedValue(tee)
    vi.spyOn(Math, 'random').mockReturnValue(0) // no retry jitter
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('accepts more than 3 photos and says so in the copy', async () => {
    const user = userEvent.setup()
    renderFlow()
    expect(screen.getByText(/up to 10 photos/)).toBeInTheDocument()
    await upload(user, 6)
    expect(await screen.findByAltText('photo 6')).toBeInTheDocument()
    expect(screen.getByText('6 photos selected · up to 10')).toBeInTheDocument()
    await upload(user, 3)
    expect(await screen.findByAltText('photo 9')).toBeInTheDocument()
    expect(screen.queryByText(/of 3/)).not.toBeInTheDocument()
  })

  it('stops at the batch ceiling and explains why', async () => {
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 12)
    expect(await screen.findByAltText('photo 10')).toBeInTheDocument()
    expect(screen.queryByAltText('photo 11')).not.toBeInTheDocument()
    expect(screen.getByText(/Added 10 of 12/)).toBeInTheDocument()
    expect(screen.queryByText('add photo')).not.toBeInTheDocument()
  })

  it('detect keeps at most 2 photos in flight across a 10-photo batch and reports progress', async () => {
    const detect = gatedMock(call => ({ sourceUri: `images/source/s${call}.jpg`, detections: makeDetections(call, 1), cost: null }))
    mockDetectBulkItems.mockImplementation(detect.impl)
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 10)
    await user.click(await screen.findByText('continue'))
    await user.click(screen.getByRole('button', { name: /auto-detect/ }))

    await waitFor(() => expect(detect.calls).toBe(2))
    expect(screen.getByText('detecting · 0 of 10 done')).toBeInTheDocument()
    detect.state.pending.shift()!()
    await waitFor(() => expect(screen.getByText('detecting · 1 of 10 done')).toBeInTheDocument())

    await detect.releaseAll()
    await waitFor(() => expect(detect.calls).toBe(10))
    expect(detect.state.peak).toBe(2)
    await waitFor(() => expect(screen.getByText('skip to review →')).toBeInTheDocument())
  })

  it('a 429 on one photo pauses the queue, retries that photo after Retry-After, and the batch completes', async () => {
    const attempts = new Map<string, number>()
    let active = 0
    let peak = 0
    mockDetectBulkItems.mockImplementation(async (file: File) => {
      const n = (attempts.get(file.name) ?? 0) + 1
      attempts.set(file.name, n)
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise(r => setTimeout(r, 10))
        if (file.name === 'p0.jpg' && n === 1) throw new RateLimitedError(5_000)
        return { sourceUri: 'images/source/x.jpg', detections: makeDetections(n, 1), cost: null }
      } finally {
        active--
      }
    })
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 5)
    await user.click(await screen.findByText('continue'))

    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: /auto-detect/ }))
    await advance(10) // p0 → 429, p1 → ok

    expect(screen.getByText(/pacing to stay under limits/)).toBeInTheDocument()
    expect(screen.queryByText(/couldn't be scanned/)).not.toBeInTheDocument()
    // The gate holds every queued photo while paused — nothing new is uploaded.
    await advance(4_000)
    expect(mockDetectBulkItems).toHaveBeenCalledTimes(2)

    await advance(1_000) // Retry-After elapsed → p0 retried, queue drains
    await advance(100)
    expect(attempts.get('p0.jpg')).toBe(2)
    expect(mockDetectBulkItems).toHaveBeenCalledTimes(6) // 5 photos + 1 retry
    expect(peak).toBeLessThanOrEqual(2)
    expect(screen.queryByText(/pacing to stay under limits/)).not.toBeInTheDocument()
    expect(screen.queryByText(/couldn't be scanned/)).not.toBeInTheDocument()
    expect(screen.getByText('skip to review →')).toBeInTheDocument()
    expect(screen.getByText('1 selected · 1 detected')).toBeInTheDocument()
  })

  it('a hard failure on one photo leaves the others intact and can be retried', async () => {
    let failP1 = true
    mockDetectBulkItems.mockImplementation(async (file: File) => {
      if (file.name === 'p1.jpg' && failP1) throw new Error('model exploded')
      return { sourceUri: 'images/source/x.jpg', detections: makeDetections(1, 2), cost: null }
    })
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 4)
    await user.click(await screen.findByText('continue'))
    await user.click(screen.getByRole('button', { name: /auto-detect/ }))

    expect(await screen.findByText("1 photo couldn't be scanned")).toBeInTheDocument()
    expect(mockDetectBulkItems).toHaveBeenCalledTimes(4) // not retried: not a 429
    expect(screen.getByText('2 selected · 2 detected')).toBeInTheDocument() // photo 1 intact

    await user.click(screen.getByRole('button', { name: /next photo/ }))
    expect(screen.getByText('0 selected · 0 detected')).toBeInTheDocument()
    failP1 = false
    await user.click(screen.getByRole('button', { name: 'detection failed · retry' }))
    await waitFor(() => expect(screen.getByText('2 selected · 2 detected')).toBeInTheDocument())
    expect(screen.queryByText(/couldn't be scanned/)).not.toBeInTheDocument()
    expect(mockDetectBulkItems).toHaveBeenCalledTimes(5)
  })

  it('classify: a 429 is retried after backoff and a hard failure marks only that item, with a retry', async () => {
    mockDetectBulkItems.mockResolvedValue({ sourceUri: 'images/source/s1.jpg', detections: makeDetections(1, 6), cost: null })
    let call = 0
    let active = 0
    let peak = 0
    mockAnalyzeItem.mockImplementation(async () => {
      const n = ++call
      active++
      peak = Math.max(peak, active)
      try {
        await new Promise(r => setTimeout(r, 10))
        if (n === 1) throw new RateLimitedError(3_000)
        if (n === 2) throw new Error('boom')
        return tee
      } finally {
        active--
      }
    })
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 1)
    await user.click(await screen.findByText('continue'))
    await user.click(screen.getByRole('button', { name: /auto-detect/ }))
    const reviewBtn = await screen.findByRole('button', { name: /^review \d/ })

    vi.useFakeTimers()
    fireEvent.click(reviewBtn)
    await advance(10)
    expect(screen.getByText(/pacing to stay under limits/)).toBeInTheDocument()
    await advance(3_000)
    await advance(200)

    expect(call).toBe(7) // 6 boxes + 1 retried 429; the hard failure is not auto-retried
    expect(peak).toBeLessThanOrEqual(3)
    expect(screen.queryByText(/analysing ·/)).not.toBeInTheDocument()

    // Item 2 hit the hard failure; the rest classified.
    fireEvent.click(screen.getByRole('button', { name: 'Go to item 2' }))
    expect(screen.getByText(/AI failed/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'retry' }))
    await advance(20)
    expect(call).toBe(8)
    expect(screen.queryByText(/AI failed/)).not.toBeInTheDocument()
  })

  it('tiles use downscaled thumbnails, and removing a photo revokes both URLs', async () => {
    mockMakeThumb.mockImplementation(async () => ({ blob: new Blob(['t']), width: 400, height: 500 }))
    const user = userEvent.setup()
    renderFlow()
    await upload(user, 5)
    const tile = await screen.findByAltText('photo 1')
    const created = createObjectURL.mock.results.map(r => r.value as string)
    expect(created).toHaveLength(10) // full-res preview + thumbnail per photo
    // Previews are created up front (0–4), thumbnails as each finishes (5–9).
    const [preview1, thumb1] = [created[0], created[5]]
    // The tile renders the thumbnail, never the full-res preview.
    expect(tile.getAttribute('src')).toBe(thumb1)

    await user.click(screen.getByRole('button', { name: 'Remove photo 1' }))
    expect(revokeObjectURL).toHaveBeenCalledWith(preview1)
    expect(revokeObjectURL).toHaveBeenCalledWith(thumb1)
    expect(revokeObjectURL).toHaveBeenCalledTimes(2)
  })
})
