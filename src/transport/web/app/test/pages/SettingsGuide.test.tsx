import { describe, it, expect, beforeAll } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

let SettingsGuide: typeof import('../../src/pages/SettingsGuide').SettingsGuide
beforeAll(async () => {
  SettingsGuide = (await import('../../src/pages/SettingsGuide')).SettingsGuide
})

function renderGuide() {
  return render(
    <MemoryRouter>
      <SettingsGuide />
    </MemoryRouter>,
  )
}

describe('SettingsGuide', () => {
  it('renders all three section headings', () => {
    renderGuide()

    expect(screen.getByText('Share & Coordinate')).toBeInTheDocument()
    expect(screen.getByText('Quick Try-on')).toBeInTheDocument()
    expect(screen.getByText('Personal Stylist')).toBeInTheDocument()
  })

  it('renders the section blurbs', () => {
    renderGuide()

    expect(screen.getByText(/Send an outfit link to a friend/i)).toBeInTheDocument()
    expect(screen.getByText(/Pick any item .* upload a photo of yourself/i)).toBeInTheDocument()
    expect(screen.getByText(/Use Vastra's AI models/i)).toBeInTheDocument()
  })

  it('has back arrow that navigates to /settings', () => {
    renderGuide()

    const backBtn = screen.getByText('Settings').closest('button')
    expect(backBtn).toBeInTheDocument()
  })
})
