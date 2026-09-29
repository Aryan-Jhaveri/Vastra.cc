import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

// #315 — Settings › Instance is read-only and shows secrets as "set" only.
vi.mock('../../src/api/auth', () => ({
  getInstanceConfig: vi.fn().mockResolvedValue({
    hostedMode: false, signupsOpen: false, chatEnabled: true, decisions: null,
    groups: [
      { title: 'Google', entries: [{ key: 'GEMINI_API_KEY', set: true, value: null, secret: true }, { key: 'GCP_PROJECT_ID', set: false, value: null }] },
      { title: 'Chat + vision', entries: [{ key: 'TEXT_MODEL', set: true, value: 'local/qwen3-vl:8b' }] },
    ],
  }),
}))

const { SettingsInstance } = await import('../../src/pages/SettingsInstance')

describe('SettingsInstance', () => {
  it('summarises what is in effect and lists each key without editing controls', async () => {
    render(<MemoryRouter><SettingsInstance /></MemoryRouter>)
    expect(await screen.findByText('Self-hosted')).toBeInTheDocument()
    expect(screen.getByText('Only accounts you create')).toBeInTheDocument()
    expect(within(screen.getByTestId('config-GEMINI_API_KEY')).getByText('set')).toBeInTheDocument()
    expect(within(screen.getByTestId('config-GCP_PROJECT_ID')).getByText('not set')).toBeInTheDocument()
    expect(within(screen.getByTestId('config-TEXT_MODEL')).getByText('local/qwen3-vl:8b')).toBeInTheDocument()
    expect(screen.getByText('make setup')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })
})
