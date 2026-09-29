import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WearSuggestionChips, chipInstruction } from '../../src/components/WearSuggestionChips'

// #312 — refine chips name the tried-on item they restyle.

describe('WearSuggestionChips', () => {
  it('shows the item label on each chip, and tapping fills an instruction naming that garment', () => {
    const onPick = vi.fn()
    render(<WearSuggestionChips
      instruction=""
      onPick={onPick}
      suggestions={[
        { label: 'Belted', instruction: 'Belt it closed at the waist.', itemId: 'i1', itemLabel: 'trench coat' },
        { label: 'Tucked', instruction: 'Tuck the t-shirt into the jeans.', itemId: 'i2', itemLabel: 't-shirt' },
      ]}
    />)

    fireEvent.click(screen.getByRole('button', { name: 'trench coat · Belted' }))
    expect(onPick).toHaveBeenLastCalledWith('For the trench coat: Belt it closed at the waist.')
    // Already names its garment: used as-is.
    fireEvent.click(screen.getByRole('button', { name: 't-shirt · Tucked' }))
    expect(onPick).toHaveBeenLastCalledWith('Tuck the t-shirt into the jeans.')
  })

  it('still renders older chips that carry only a label and instruction', () => {
    const onPick = vi.fn()
    render(<WearSuggestionChips instruction="" onPick={onPick} suggestions={[{ label: 'Collar up', instruction: 'Pop the collar.' }]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Collar up' }))
    expect(onPick).toHaveBeenCalledWith('Pop the collar.')
  })

  it('marks the chip whose instruction is in the Refine box', () => {
    const chip = { label: 'Belted', instruction: 'Belt it.', itemId: 'i1', itemLabel: 'trench coat' }
    render(<WearSuggestionChips instruction={chipInstruction(chip)} onPick={vi.fn()} suggestions={[chip]} />)
    expect(screen.getByRole('button', { name: 'trench coat · Belted' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('renders nothing without suggestions', () => {
    const { container } = render(<WearSuggestionChips instruction="" onPick={vi.fn()} suggestions={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})
