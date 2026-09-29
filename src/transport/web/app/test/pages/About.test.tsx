import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

const FOUNDERS = [
  { tab: 'aryan',  name: 'Aryan Jhaveri', handle: 'Aryan-Jhaveri' },
  { tab: 'harsh',  name: 'Harsh Kapoor',  handle: 'harashkapoor' },
  { tab: 'tarang', name: 'Tarang Soni',   handle: 'tarang-soni' },
] as const

let About: typeof import('../../src/pages/About').About
beforeAll(async () => {
  About = (await import('../../src/pages/About')).About
})

beforeEach(() => {
  // README fetch is fired on mount/tab-change; stub so tests don't hit GitHub.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, text: async () => '' }))
})

function renderAbout() {
  return render(
    <MemoryRouter>
      <About />
    </MemoryRouter>,
  )
}

function clickTab(tab: string) {
  fireEvent.click(screen.getByRole('button', { name: tab }))
}

describe('About', () => {
  it('renders "Made with love" heading', () => {
    renderAbout()

    expect(screen.getByText('Made with love')).toBeInTheDocument()
  })

  it('renders Vastra description', () => {
    renderAbout()

    expect(screen.getByText(/Made with love and appreciation for artisans/i)).toBeInTheDocument()
  })

  it('renders a tab button for every founder', () => {
    renderAbout()

    for (const { tab } of FOUNDERS) {
      expect(screen.getByRole('button', { name: tab })).toBeInTheDocument()
    }
  })

  it('shows each founder name when their tab is active', () => {
    renderAbout()

    for (const { tab, name } of FOUNDERS) {
      clickTab(tab)
      expect(screen.getByText(name)).toBeInTheDocument()
    }
  })

  it('shows each GitHub handle when their tab is active', () => {
    renderAbout()

    for (const { tab, handle } of FOUNDERS) {
      clickTab(tab)
      expect(screen.getByText(`@${handle}`)).toBeInTheDocument()
    }
  })

  it('renders a correct GitHub link for the active founder', () => {
    renderAbout()

    for (const { tab, handle } of FOUNDERS) {
      clickTab(tab)
      const link = screen.getByRole('link', { name: `@${handle}` })
      expect(link).toHaveAttribute('href', `https://github.com/${handle}`)
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
    }
  })

  it('renders the active founder avatar with correct GitHub URL', () => {
    renderAbout()

    for (const { tab, name, handle } of FOUNDERS) {
      clickTab(tab)
      const avatar = screen.getByAltText(name) as HTMLImageElement
      expect(avatar.src).toBe(`https://github.com/${handle}.png`)
    }
  })

  it('has back arrow that navigates to /settings', () => {
    renderAbout()

    const backBtn = screen.getByText('Settings').closest('button')
    expect(backBtn).toBeInTheDocument()
  })
})
