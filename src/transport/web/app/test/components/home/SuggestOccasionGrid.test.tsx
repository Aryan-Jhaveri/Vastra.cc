import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SuggestOccasionGrid } from '../../../src/components/home/SuggestOccasionGrid'

vi.mock('../../../src/api/suggestOccasions', () => ({
  getOccasions: vi.fn(),
}))

import { getOccasions } from '../../../src/api/suggestOccasions'

const mockOccasions = {
  presets: ['work', 'casual', 'date', 'formal', 'active'],
  derived: ['gym', 'beach', 'club'],
  hidden: ['brunch'],
}

beforeEach(() => {
  sessionStorage.clear()
  vi.clearAllMocks()
  vi.mocked(getOccasions).mockResolvedValue(mockOccasions)
})

function renderGrid(selected: string | null = null, onSelect = vi.fn()) {
  return render(<SuggestOccasionGrid selected={selected} onSelect={onSelect} />)
}

describe('SuggestOccasionGrid', () => {
  it('renders 5 preset chips always', async () => {
    renderGrid()
    await waitFor(() => { expect(screen.getByText('Work')).toBeInTheDocument() })
    expect(screen.getByText('Casual')).toBeInTheDocument()
    expect(screen.getByText('Date')).toBeInTheDocument()
    expect(screen.getByText('Formal')).toBeInTheDocument()
    expect(screen.getByText('Active')).toBeInTheDocument()
  })

  it('renders derived chips in a second row', async () => {
    renderGrid()
    await waitFor(() => { expect(screen.getByText('Gym')).toBeInTheDocument() })
    expect(screen.getByText('Beach')).toBeInTheDocument()
    expect(screen.getByText('Club')).toBeInTheDocument()
  })

  it('hides derived row when no derived chips', async () => {
    vi.mocked(getOccasions).mockResolvedValue({ presets: ['work', 'casual', 'date', 'formal', 'active'], derived: [], hidden: [] })

    renderGrid()
    await waitFor(() => { expect(screen.getByText('Work')).toBeInTheDocument() })
    expect(screen.queryByText('Gym')).not.toBeInTheDocument()
    expect(screen.queryByText('Beach')).not.toBeInTheDocument()
  })

  it('selects a chip on click and deselects on second click', async () => {
    const onSelect = vi.fn()
    renderGrid(null, onSelect)
    await waitFor(() => { expect(screen.getByText('Work')).toBeInTheDocument() })

    await userEvent.click(screen.getByText('Work'))
    expect(onSelect).toHaveBeenCalledWith('work')
  })

  it('deselects when tapping the selected chip', async () => {
    const onSelect = vi.fn()
    renderGrid('work', onSelect)
    await waitFor(() => { expect(screen.getByText('Work')).toBeInTheDocument() })

    await userEvent.click(screen.getByText('Work'))
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('selected chip has accent styles', async () => {
    renderGrid('work')
    await waitFor(() => { expect(screen.getByText('Work')).toBeInTheDocument() })

    const workBtn = screen.getByText('Work')
    expect(workBtn.className).toContain('bg-accent')
    expect(workBtn.className).toContain('text-accent-on')

    const casualBtn = screen.getByText('Casual')
    expect(casualBtn.className).toContain('bg-paper')
  })
})
