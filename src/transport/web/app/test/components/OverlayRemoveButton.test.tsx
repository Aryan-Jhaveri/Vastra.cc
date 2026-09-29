import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { OverlayRemoveButton } from '../../src/components/ui/OverlayRemoveButton'

describe('OverlayRemoveButton', () => {
  it('renders a themed Remove button that fires onClick', () => {
    const onClick = vi.fn()
    render(<OverlayRemoveButton onClick={onClick} />)

    const btn = screen.getByRole('button', { name: /remove/i })
    expect(btn.className).toContain('border-error')
    expect(btn.className).toContain('bg-paper')
    expect(btn.className).toContain('text-error')
    expect(btn.className).toContain('rounded-base')
    expect(btn.className).toContain('shadow-flat-xs')
    expect(btn.className).not.toContain('bg-black')
    expect(btn.className).not.toContain('border-white')
    expect(btn.className).not.toContain('text-white')

    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('shows a spinner and blocks clicks while busy', () => {
    const onClick = vi.fn()
    render(<OverlayRemoveButton onClick={onClick} busy />)

    const btn = screen.getByRole('button', { name: /remove/i })
    expect(btn).toBeDisabled()
    expect(btn.querySelector('svg.animate-spin')).not.toBeNull()
    expect(btn.querySelectorAll('svg')).toHaveLength(1)

    fireEvent.click(btn)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders the trash icon when idle', () => {
    render(<OverlayRemoveButton onClick={() => {}} />)

    const btn = screen.getByRole('button', { name: /remove/i })
    expect(btn.querySelector('svg.animate-spin')).toBeNull()
    expect(btn.querySelectorAll('svg')).toHaveLength(1)
  })
})
