import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'

const mockNavigate = vi.fn()
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return { ...actual, useNavigate: () => mockNavigate }
})

import { ShareInboxChooser } from '../../src/modals/ShareInboxChooser'

function setUrl(url: string) {
  window.history.replaceState({}, '', url)
}

function renderChooser() {
  return render(
    <MemoryRouter>
      <ShareInboxChooser />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setUrl('/')
})

describe('ShareInboxChooser', () => {
  it('renders nothing without an inbox share in the URL', () => {
    setUrl('/?foo=bar')
    renderChooser()
    expect(screen.queryByRole('button', { name: /send to try-on/i })).not.toBeInTheDocument()
  })

  it('renders both actions when ?share=<id>&kind=inbox is present', () => {
    setUrl('/?share=abc&kind=inbox')
    renderChooser()
    expect(screen.getByRole('button', { name: /send to try-on/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /find similar items/i })).toBeInTheDocument()
  })

  it('Send to try-on → navigates to /tryon?inboxId=<id>', async () => {
    setUrl('/?share=abc&kind=inbox')
    renderChooser()
    await userEvent.click(screen.getByRole('button', { name: /send to try-on/i }))
    expect(mockNavigate).toHaveBeenCalledWith('/tryon?inboxId=abc')
  })

  it('Find similar items → navigates to /home?inboxId=<id>#discover', async () => {
    setUrl('/?share=abc&kind=inbox')
    renderChooser()
    await userEvent.click(screen.getByRole('button', { name: /find similar items/i }))
    expect(mockNavigate).toHaveBeenCalledWith('/home?inboxId=abc#discover')
  })
})
