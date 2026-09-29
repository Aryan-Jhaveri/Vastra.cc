import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../../src/api/items', () => ({ fetchItems: vi.fn().mockResolvedValue({ items: [] }) }))
const { OccasionPicker } = await import('../../src/components/ui/OccasionPicker')

// #371 — an outfit's occasion (preset or custom) has an explicit remove.
describe('OccasionPicker — remove', () => {
  it.each(['date night', 'work'])('"%s" shows a × that clears it', value => {
    const onChange = vi.fn()
    render(<OccasionPicker value={value} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: `Remove ${value}` }))
    expect(onChange).toHaveBeenCalledWith('')
  })

  it('no remove control when nothing is set', () => {
    render(<OccasionPicker value={null} onChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument()
  })
})
