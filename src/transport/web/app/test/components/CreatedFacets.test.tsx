import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// #372 — "Your tags" / "Your occasions": Select → pick → confirm says how
// many items, outfits and collections lose it → delete everywhere.
const api = vi.hoisted(() => ({
  fetchFacets: vi.fn(),
  deleteFacets: vi.fn(),
}))
vi.mock('../../src/api/tags', () => api)

const { CreatedFacets, describeUsage } = await import('../../src/components/ui/CreatedFacets')

beforeEach(() => {
  vi.clearAllMocks()
  api.fetchFacets.mockResolvedValue([
    { value: 'festival', items: 2, outfits: 1, collections: 0 },
    { value: 'linen', items: 1, outfits: 0, collections: 0 },
    { value: 'work', items: 3, outfits: 0, collections: 0 },
  ])
  api.deleteFacets.mockResolvedValue({ items: 2, outfits: 1, collections: 0 })
})

describe('CreatedFacets', () => {
  it('lists created values; tapping one adds it; values on the card are shown as added', async () => {
    const onAdd = vi.fn()
    render(<CreatedFacets kind="tag" current={['linen']} onAdd={onAdd} />)
    fireEvent.click(await screen.findByRole('button', { name: 'festival' }))
    expect(onAdd).toHaveBeenCalledWith('festival')
    fireEvent.click(screen.getByRole('button', { name: 'linen' }))
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  it('Select → pick → confirmation names the counts → Delete removes everywhere', async () => {
    const onDeleted = vi.fn()
    render(<CreatedFacets kind="tag" current={['festival']} onAdd={vi.fn()} onDeleted={onDeleted} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByRole('button', { name: 'festival', pressed: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 tag…' }))
    expect(screen.getByRole('status')).toHaveTextContent('“festival” will be removed from 2 items and 1 outfit.')
    expect(api.deleteFacets).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 tag' }))
    await waitFor(() => expect(api.deleteFacets).toHaveBeenCalledWith('tag', ['festival']))
    expect(onDeleted).toHaveBeenCalledWith(['festival'])
    expect(await screen.findByRole('button', { name: 'Select' })).toBeInTheDocument()
  })

  it('Keep and Cancel back out without deleting', async () => {
    render(<CreatedFacets kind="tag" current={[]} onAdd={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }))
    fireEvent.click(screen.getByRole('button', { name: 'linen' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete 1 tag…' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(api.deleteFacets).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument()
  })

  it('occasions leave out the built-in presets', async () => {
    render(<CreatedFacets kind="occasion" current={[]} onAdd={vi.fn()} exclude={new Set(['work'])} />)
    const list = await screen.findByTestId('created-occasions')
    expect(within(list).queryByRole('button', { name: 'work' })).not.toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'festival' })).toBeInTheDocument()
    expect(api.fetchFacets).toHaveBeenCalledWith('occasion')
  })

  it('describeUsage reads naturally', () => {
    expect(describeUsage([{ items: 1, outfits: 0, collections: 0 }])).toBe('1 item')
    expect(describeUsage([{ items: 2, outfits: 1, collections: 1 }])).toBe('2 items, 1 outfit and 1 collection')
    expect(describeUsage([{ items: 0, outfits: 0, collections: 0 }])).toBe('nothing')
  })
})
