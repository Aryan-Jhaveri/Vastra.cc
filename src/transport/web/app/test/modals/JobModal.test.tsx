import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/api/jobs', () => ({
  createJob: vi.fn(),
  updateJob: vi.fn(),
}))
vi.mock('../../src/api/weather', () => ({
  geocodeCity: vi.fn(),
}))

import { JobModal } from '../../src/modals/JobModal'
import * as jobsApi from '../../src/api/jobs'
import * as weatherApi from '../../src/api/weather'

// This jsdom build ships a localStorage object without Storage methods; the app
// tolerates that via try/catch, but the test seeds it directly, so stub one.
const lsStore: Record<string, string> = {}
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => { lsStore[k] = v },
  removeItem: (k: string) => { delete lsStore[k] },
  clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
})

const savedJob = {
  id: 'j1', name: 'Morning', type: 'daily_outfit', schedule: '0 8 * * *',
  params: {}, enabled: 1, lastRunAt: null, createdAt: 0,
}

function renderModal() {
  const onSaved = vi.fn()
  const onClose = vi.fn()
  render(<JobModal onClose={onClose} onSaved={onSaved} />)
  return { onSaved, onClose }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(lsStore)) delete lsStore[k]
  vi.mocked(jobsApi.createJob).mockResolvedValue(savedJob as Awaited<ReturnType<typeof jobsApi.createJob>>)
})

describe('JobModal — daily_outfit location handling', () => {
  it('creates the job without blocking or geocoding when no location is set and the field is empty', async () => {
    const { onSaved } = renderModal()

    fireEvent.change(screen.getByPlaceholderText('e.g. Morning Outfit'), { target: { value: 'Morning' } })
    fireEvent.click(screen.getByRole('button', { name: /create job/i }))

    await waitFor(() => expect(jobsApi.createJob).toHaveBeenCalled())
    expect(weatherApi.geocodeCity).not.toHaveBeenCalled()

    const arg = vi.mocked(jobsApi.createJob).mock.calls[0][0]
    expect(arg.type).toBe('daily_outfit')
    expect(arg.params).toEqual({}) // no-location fallback — not blocked
    expect(onSaved).toHaveBeenCalled()
  })

  it('defaults the field to the current location and uses it without geocoding', async () => {
    localStorage.setItem('closet-location', JSON.stringify({ lat: 43.7, lon: -79.4, name: 'Toronto' }))
    renderModal()

    expect(screen.getByDisplayValue('Toronto')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('e.g. Morning Outfit'), { target: { value: 'Morning' } })
    fireEvent.click(screen.getByRole('button', { name: /create job/i }))

    await waitFor(() => expect(jobsApi.createJob).toHaveBeenCalled())
    expect(weatherApi.geocodeCity).not.toHaveBeenCalled()

    const arg = vi.mocked(jobsApi.createJob).mock.calls[0][0]
    expect(arg.params).toMatchObject({ lat: 43.7, lon: -79.4, locationName: 'Toronto' })
  })

  it('geocodes only when the user types a different city', async () => {
    localStorage.setItem('closet-location', JSON.stringify({ lat: 43.7, lon: -79.4, name: 'Toronto' }))
    vi.mocked(weatherApi.geocodeCity).mockResolvedValue({ lat: 48.85, lon: 2.35, name: 'Paris' })
    renderModal()

    fireEvent.change(screen.getByPlaceholderText('e.g. Morning Outfit'), { target: { value: 'Morning' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. Toronto'), { target: { value: 'Paris' } })
    fireEvent.click(screen.getByRole('button', { name: /create job/i }))

    await waitFor(() => expect(jobsApi.createJob).toHaveBeenCalled())
    expect(weatherApi.geocodeCity).toHaveBeenCalledWith('Paris')

    const arg = vi.mocked(jobsApi.createJob).mock.calls[0][0]
    expect(arg.params).toMatchObject({ lat: 48.85, lon: 2.35, locationName: 'Paris' })
  })
})
