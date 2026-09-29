import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sheet } from '../../src/components/ui/Sheet'

describe('Sheet — pinned actions', () => {
  it('renders actions in a separate flex-none container outside the scroll region', () => {
    render(
      <Sheet open onClose={() => {}} title="test" actions={<button>action-btn</button>}>
        <div>scrollable-content</div>
      </Sheet>,
    )
    const actions = screen.getByTestId('sheet-actions')
    expect(actions).toBeInTheDocument()
    expect(actions.className).toContain('flex-none')
    expect(actions.className).toContain('border-t-2')
    expect(within(actions, 'action-btn')).toBe(true)

    // Scrollable content must not contain the actions
    const content = screen.getByText('scrollable-content')
    let cursor: HTMLElement | null = content
    while (cursor && cursor !== document.body) {
      if (cursor.getAttribute('data-testid') === 'sheet-actions') {
        throw new Error('actions are nested inside the scrollable area')
      }
      cursor = cursor.parentElement
    }
  })

  it('omits the action container when no actions prop is passed', () => {
    render(
      <Sheet open onClose={() => {}} title="test">
        <div>content</div>
      </Sheet>,
    )
    expect(screen.queryByTestId('sheet-actions')).not.toBeInTheDocument()
  })
})

function within(el: HTMLElement, text: string): boolean {
  return el.textContent?.includes(text) ?? false
}
