import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// #332 / #279 — the Related section: idle until tapped, saved results free,
// every state, and select mode.
vi.mock('../../src/api/related', () => ({ findRelated: vi.fn(), fetchSavedRelated: vi.fn() }))

import { findRelated, fetchSavedRelated, type RelatedResult } from '../../src/api/related'
import { RelatedSection, foundAgo, resetsIn } from '../../src/components/RelatedSection'

type E = { id: string; name: string }
const result = (names: string[], foundAt = Date.now()): RelatedResult =>
  ({ kind: 'item', status: names.length ? 'success' : 'empty', foundAt, scores: {}, items: names.map(n => ({ id: n, name: n })) as never })

function renderSection(extra: Partial<Parameters<typeof RelatedSection<E>>[0]> = {}) {
  const onOpen = vi.fn()
  const selectActions = vi.fn((selected: E[], clear: () => void) => (
    <button onClick={() => { clear() }} disabled={!selected.length}>Act {selected.length}</button>
  ))
  render(
    <RelatedSection<E>
      kind="item"
      targetId="anchor"
      title="Related items"
      searchLabel="Find related items"
      emptyText="Nothing related yet."
      entriesOf={r => ((r.items ?? []) as unknown as E[]).map(e => ({ id: e.id, entity: e }))}
      renderCard={(e, o) => <button data-selected={o.selected} data-selectable={o.selectable} onClick={o.onClick}>{e.name}</button>}
      onOpen={onOpen}
      selectActions={selectActions}
      {...extra}
    />,
  )
  return { onOpen, selectActions }
}

beforeEach(() => {
  vi.mocked(findRelated).mockReset()
  vi.mocked(fetchSavedRelated).mockReset().mockResolvedValue(null)
})

describe('RelatedSection', () => {
  it('starts idle and makes no find request until the magnifier is tapped', async () => {
    renderSection()
    await waitFor(() => expect(fetchSavedRelated).toHaveBeenCalledWith('item', 'anchor'))
    expect(findRelated).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Find related items' })).toBeEnabled()
    expect(screen.queryByText(/limit|finds left|\d+\s*\/\s*\d+/i)).toBeNull()
  })

  it('tap → Finding… → results, with "Found just now"', async () => {
    let resolve!: (v: Awaited<ReturnType<typeof findRelated>>) => void
    vi.mocked(findRelated).mockReturnValue(new Promise(r => { resolve = r }))
    renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Find related items' }))
    expect(await screen.findByText('Finding…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Find related items' })).toBeDisabled()
    resolve({ kind: 'result', result: result(['Pants', 'Shoes']) })
    expect(await screen.findByText('Pants')).toBeInTheDocument()
    expect(screen.getByText('Found just now')).toBeInTheDocument()
    expect(findRelated).toHaveBeenCalledExactlyOnceWith('item', 'anchor')
  })

  it('shows a saved, still-current result on open for free', async () => {
    vi.mocked(fetchSavedRelated).mockResolvedValue(result(['Old pick'], Date.now() - 2 * 3_600_000))
    renderSection()
    expect(await screen.findByText('Old pick')).toBeInTheDocument()
    expect(screen.getByText('Found 2h ago')).toBeInTheDocument()
    expect(findRelated).not.toHaveBeenCalled()
  })

  it('shows the empty, error and capped states', async () => {
    vi.mocked(findRelated).mockResolvedValueOnce({ kind: 'result', result: result([]) })
    renderSection()
    const search = screen.getByRole('button', { name: 'Find related items' })
    fireEvent.click(search)
    expect(await screen.findByText('Nothing related yet.')).toBeInTheDocument()

    vi.mocked(findRelated).mockResolvedValueOnce({ kind: 'error' })
    fireEvent.click(search)
    expect(await screen.findByText(/Couldn't find related · tap search to try again/)).toBeInTheDocument()

    vi.mocked(findRelated).mockResolvedValueOnce({ kind: 'capped', resetsAt: Date.now() + (5 * 60 + 12) * 60_000 })
    fireEvent.click(search)
    expect(await screen.findByText(/Daily limit reached · resets in 5h 1[12]m/)).toBeInTheDocument()
    expect(search).toBeDisabled()
  })

  it('opens an entity on tap outside select mode', async () => {
    vi.mocked(findRelated).mockResolvedValue({ kind: 'result', result: result(['Pants']) })
    const { onOpen } = renderSection()
    fireEvent.click(screen.getByRole('button', { name: 'Find related items' }))
    fireEvent.click(await screen.findByText('Pants'))
    expect(onOpen).toHaveBeenCalledWith({ id: 'Pants', name: 'Pants' })
  })

  it('Select appears only with results; cards toggle; actions get the selection; Cancel clears', async () => {
    vi.mocked(findRelated).mockResolvedValue({ kind: 'result', result: result(['Pants', 'Shoes']) })
    const { onOpen, selectActions } = renderSection()
    expect(screen.queryByRole('button', { name: 'Select' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Find related items' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Select' }))

    fireEvent.click(screen.getByText('Pants'))
    expect(screen.getByText('Pants')).toHaveAttribute('data-selected', 'true')
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(selectActions.mock.lastCall![0]).toEqual([{ id: 'Pants', name: 'Pants' }])
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
    expect(screen.getByText('Pants')).toHaveAttribute('data-selected', 'false')
    expect(screen.getByText('Pants')).toHaveAttribute('data-selectable', 'false')
  })

  it('drops hidden ids from the results', async () => {
    vi.mocked(findRelated).mockResolvedValue({ kind: 'result', result: result(['Pants', 'Shoes']) })
    renderSection({ hiddenIds: new Set(['Pants']) })
    fireEvent.click(screen.getByRole('button', { name: 'Find related items' }))
    expect(await screen.findByText('Shoes')).toBeInTheDocument()
    expect(screen.queryByText('Pants')).toBeNull()
  })
})

describe('time labels', () => {
  it('formats found-ago and resets-in', () => {
    const now = 1_000_000_000
    expect(foundAgo(now - 30_000, now)).toBe('Found just now')
    expect(foundAgo(now - 5 * 60_000, now)).toBe('Found 5m ago')
    expect(foundAgo(now - 3 * 86_400_000, now)).toBe('Found 3d ago')
    expect(resetsIn(now + 72 * 60_000, now)).toBe('resets in 1h 12m')
    expect(resetsIn(null, now)).toBe('resets within 24h')
  })
})
