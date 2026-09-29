import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { ConnectionsSection } from '../../src/components/settings/ConnectionsSection'
import * as tokensApi from '../../src/api/tokens'

function mockList(tokens: tokensApi.ApiTokenView[] = []) {
  vi.spyOn(tokensApi, 'listTokens').mockResolvedValue(tokens)
}

describe('ConnectionsSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    mockList([])
  })

  it('renders the section header and create form', async () => {
    render(<ConnectionsSection />)
    expect(screen.getByText('Connections')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('e.g. Home Assistant')).toBeInTheDocument()
    // Read scope is always on and locked.
    const readCheckbox = screen.getByLabelText(/Read/) as HTMLInputElement
    expect(readCheckbox.checked).toBe(true)
    expect(readCheckbox.disabled).toBe(true)
  })

  it('shows the plaintext once after create, with a Copy button', async () => {
    const created = {
      token: {
        id: 't1', name: 'My bot', prefix: 'vst_abc123', scopes: ['read', 'write'],
        createdAt: Date.now(), lastUsedAt: null, expiresAt: null, revokedAt: null,
      },
      plaintext: 'vst_secretplaintextvalue',
    }
    vi.spyOn(tokensApi, 'createToken').mockResolvedValue(created)
    mockList([])

    render(<ConnectionsSection />)
    const input = screen.getByPlaceholderText('e.g. Home Assistant')
    fireEvent.change(input, { target: { value: 'My bot' } })
    fireEvent.click(screen.getByLabelText(/Write/))
    fireEvent.click(screen.getByText('Create token'))

    await waitFor(() => {
      expect(screen.getByText('Copy your token — you won’t see it again')).toBeInTheDocument()
      expect(screen.getByText('vst_secretplaintextvalue')).toBeInTheDocument()
    })
  })

  it('does not load tokens until Manage tokens is expanded', async () => {
    render(<ConnectionsSection />)
    expect(tokensApi.listTokens).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Manage tokens'))
    await waitFor(() => expect(tokensApi.listTokens).toHaveBeenCalledTimes(1))
  })

  it('lists tokens and removes a token from the list once revoked', async () => {
    const token: tokensApi.ApiTokenView = {
      id: 't1', name: 'HA', prefix: 'vst_xyz789', scopes: ['read', 'ai'],
      createdAt: 1700000000000, lastUsedAt: 1700000001000, expiresAt: null, revokedAt: null,
    }
    mockList([token])
    vi.spyOn(tokensApi, 'revokeToken').mockResolvedValue(undefined)

    render(<ConnectionsSection />)
    fireEvent.click(screen.getByText('Manage tokens'))
    await waitFor(() => expect(screen.getByText('HA')).toBeInTheDocument())
    expect(screen.getByText(/vst_xyz789/)).toBeInTheDocument()
    expect(screen.getByText(/read, ai/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('Revoke'))
    await waitFor(() => expect(tokensApi.revokeToken).toHaveBeenCalledWith('t1'))
    await waitFor(() => expect(screen.queryByText('HA')).not.toBeInTheDocument())
    expect(screen.queryByText(/Revoked/)).not.toBeInTheDocument()
    expect(screen.getByText('No active tokens.')).toBeInTheDocument()
  })

  it('shows empty state when there are no active tokens', async () => {
    mockList([])
    render(<ConnectionsSection />)
    fireEvent.click(screen.getByText('Manage tokens'))
    await waitFor(() => expect(screen.getByText('No active tokens.')).toBeInTheDocument())
  })

  it('expands the list after creating a token so the new token is visible', async () => {
    const view: tokensApi.ApiTokenView = {
      id: 't2', name: 'New bot', prefix: 'vst_new000', scopes: ['read'],
      createdAt: Date.now(), lastUsedAt: null, expiresAt: null, revokedAt: null,
    }
    vi.spyOn(tokensApi, 'createToken').mockResolvedValue({ token: view, plaintext: 'vst_plain' })
    mockList([view])

    render(<ConnectionsSection />)
    fireEvent.change(screen.getByPlaceholderText('e.g. Home Assistant'), { target: { value: 'New bot' } })
    fireEvent.click(screen.getByText('Create token'))
    await waitFor(() => expect(screen.getByText('New bot')).toBeInTheDocument())
  })
})
