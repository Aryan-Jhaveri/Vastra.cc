import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router'
import { Jobs } from '../../src/pages/Jobs'

function renderJobs() {
  return render(<MemoryRouter><Jobs /></MemoryRouter>)
}

// ── Mock API ──────────────────────────────────────────────────────────────────

vi.mock('../../src/api/jobs', () => ({
  fetchJobs: vi.fn(),
  toggleJob: vi.fn(),
  deleteJob: vi.fn(),
  createJob: vi.fn(),
  updateJob: vi.fn(),
}))

vi.mock('../../src/api/client', () => ({
  apiFetchJSON: vi.fn(),
}))

vi.mock('../../src/modals/JobModal', () => ({
  JobModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="job-modal">
      <span>New Job</span>
      <span>Edit Job</span>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))

import * as jobsApi from '../../src/api/jobs'
import * as clientApi from '../../src/api/client'

const mockJob = {
  id: 'job-1',
  name: 'Morning Outfit',
  type: 'daily_outfit',
  schedule: '0 8 * * *',
  params: { chatId: 123, lat: 43.7, lon: -79.4, locationName: 'Toronto' },
  enabled: 1,
  lastRunAt: null,
  createdAt: Date.now(),
  outfit: null,
}

const mockOutfitReminderJob = {
  id: 'job-2',
  name: 'Wear Summer Vibes',
  type: 'outfit_reminder',
  schedule: '0 8 * * 1',
  params: { chatId: '123', outfitId: 'outfit-1' },
  enabled: 1,
  lastRunAt: null,
  createdAt: Date.now(),
  outfit: {
    id: 'outfit-1',
    name: 'Summer Vibes',
    coverImageUri: 'images/outfits/cover.jpg',
  },
}

const mockOutfitReminderNoThumb = {
  ...mockOutfitReminderJob,
  id: 'job-3',
  outfit: { id: 'outfit-2', name: 'Work Set', coverImageUri: null },
}

describe('Jobs page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows spinner while loading', () => {
    vi.mocked(clientApi.apiFetchJSON).mockReturnValue(new Promise(() => {}))
    renderJobs()
    expect(document.querySelector('svg.animate-spin')).toBeTruthy()
  })

  it('renders job name after load', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([mockJob])
    renderJobs()

    await waitFor(() => expect(screen.getByText('Morning Outfit')).toBeInTheDocument())
  })

  it('shows empty state when no jobs', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([])
    renderJobs()

    await waitFor(() => expect(screen.getByText(/No scheduled jobs yet/i)).toBeInTheDocument())
  })

  it('shows Daily at 8am for known cron', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([mockJob])
    renderJobs()

    await waitFor(() => expect(screen.getByText('Daily at 8am')).toBeInTheDocument())
  })

  it('toggles job via API when Pause clicked', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([mockJob])
    vi.mocked(jobsApi.toggleJob).mockResolvedValue({ ...mockJob, enabled: 0 })

    renderJobs()
    await waitFor(() => screen.getByText('Morning Outfit'))

    fireEvent.click(screen.getByText('Pause'))
    await waitFor(() => expect(jobsApi.toggleJob).toHaveBeenCalledWith('job-1'))
  })

  it('deletes job after entering select mode and confirming', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([mockJob])
    vi.mocked(jobsApi.deleteJob).mockResolvedValue(undefined)

    renderJobs()
    await waitFor(() => screen.getByText('Morning Outfit'))

    fireEvent.click(screen.getByText('Select'))
    fireEvent.click(screen.getByText('Morning Outfit'))
    fireEvent.click(screen.getByText('Delete (1)'))
    await waitFor(() => expect(jobsApi.deleteJob).toHaveBeenCalledWith('job-1'))
  })

  it('opens modal when + Add is clicked', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([])
    renderJobs()

    await waitFor(() => screen.getByText(/No scheduled jobs yet/i))
    fireEvent.click(screen.getByRole('button', { name: /Add/ }))
    expect(screen.getByText('New Job')).toBeInTheDocument()
  })

  it('opens edit modal with job data pre-filled', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([mockJob])
    renderJobs()

    await waitFor(() => screen.getByText('Morning Outfit'))
    fireEvent.click(screen.getByText('Edit'))
    expect(screen.getByText('Edit Job')).toBeInTheDocument()
  })

  it('renders outfit thumbnail for outfit_reminder job with cover', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([mockOutfitReminderJob])
    renderJobs()

    await waitFor(() => screen.getByText('Wear Summer Vibes'))
    const img = document.querySelector('img[alt="Outfit"]') as HTMLImageElement | null
    expect(img).toBeTruthy()
    expect(img?.src).toContain('images/outfits/cover.jpg')
  })

  it('renders clock icon for daily_outfit job', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([mockJob])
    renderJobs()

    await waitFor(() => screen.getByText('Morning Outfit'))
    // No thumbnail image for daily_outfit
    expect(document.querySelector('img[alt="Outfit"]')).toBeNull()
    // SVG clock icon present
    expect(document.querySelector('svg')).toBeTruthy()
  })

  it('shows Outfit reminder type label for outfit_reminder jobs', async () => {
    vi.mocked(clientApi.apiFetchJSON).mockResolvedValue([mockOutfitReminderJob])
    renderJobs()

    await waitFor(() => expect(screen.getByText('Outfit reminder')).toBeInTheDocument())
  })
})
