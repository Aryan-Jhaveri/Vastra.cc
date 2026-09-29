import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { JobRun, UpcomingJob } from '../../src/api/jobs'

// Hoisted so the (hoisted) vi.mock factories below can reference them safely.
const { navigateMock, remindersState } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  remindersState: {
    upcoming: [] as unknown[],
    history: [] as unknown[],
    loading: false,
    error: null as string | null,
    refetch: vi.fn(),
  },
}))

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return { ...actual, useNavigate: () => navigateMock }
})

// Stub OutfitCard so we test RemindersTab's wiring, not AuthImage/ShareButton.
vi.mock('../../src/components/OutfitCard', () => ({
  OutfitCard: ({ suggestion, onView, onSave, showShare, saved }: {
    suggestion: { name: string }
    onView?: () => void
    onSave?: () => void
    showShare?: boolean
    saved?: boolean
  }) => (
    <div data-testid="outfit-card">
      <span>{suggestion.name}</span>
      {saved && onView ? <button onClick={onView}>View outfit</button> : null}
      {!saved && onSave ? <button onClick={onSave}>Save outfit</button> : null}
      {showShare ? <button>Share</button> : null}
    </div>
  ),
}))

vi.mock('../../src/hooks/useReminders', () => ({
  useReminders: () => remindersState,
}))

import { RemindersTab } from '../../src/components/home/RemindersTab'

function makeRun(over: Partial<JobRun>): JobRun {
  return {
    id: 'run',
    jobId: 'job',
    firedAt: Date.now(),
    status: 'success',
    error: null,
    job: { id: 'job', name: 'Job', type: 'daily_outfit' },
    suggestions: [],
    reminderOutfit: null,
    reminderOutfitId: null,
    ...over,
  }
}

const reminderRun = makeRun({
  id: 'run-rem',
  jobId: 'job-rem',
  job: { id: 'job-rem', name: 'Wear Summer Vibes', type: 'outfit_reminder' },
  suggestions: [{ item_ids: ['i1'], name: 'Summer Vibes', occasion: 'casual', reasoning: 'breezy', items: [] }],
  reminderOutfitId: 'outfit-9',
})

const dailyRun = makeRun({
  id: 'run-daily',
  jobId: 'job-daily',
  job: { id: 'job-daily', name: 'Daily Suggestion', type: 'daily_outfit' },
  suggestions: [{ item_ids: ['i2'], name: 'Daily Pick', occasion: 'work', reasoning: 'sharp', items: [] }],
})

function setHistory(runs: JobRun[]) {
  remindersState.history = runs
}

function renderTab() {
  return render(<MemoryRouter><RemindersTab /></MemoryRouter>)
}

describe('RemindersTab — Scheduled Reminders section', () => {
  beforeEach(() => {
    navigateMock.mockClear()
    remindersState.upcoming = []
    remindersState.history = []
  })

  it('shows a Scheduled Reminders section for fired outfit reminders, separate from Recent Results', () => {
    setHistory([reminderRun, dailyRun])
    renderTab()

    expect(screen.getByText('Scheduled Reminders')).toBeInTheDocument()
    expect(screen.getByText('Recent Results')).toBeInTheDocument()
    expect(screen.getByText('Summer Vibes')).toBeInTheDocument()
    expect(screen.getByText('Daily Pick')).toBeInTheDocument()
  })

  it('renders View outfit + Share (no Save) for a scheduled reminder and deep-links on view', () => {
    setHistory([reminderRun])
    renderTab()

    expect(screen.queryByText('Save outfit')).not.toBeInTheDocument()
    expect(screen.getByText('Share')).toBeInTheDocument()

    fireEvent.click(screen.getByText('View outfit'))
    expect(navigateMock).toHaveBeenCalledWith('/outfits', { state: { openOutfitId: 'outfit-9' } })
  })

  it('omits the Scheduled Reminders section when there are no outfit reminders', () => {
    setHistory([dailyRun])
    renderTab()

    expect(screen.queryByText('Scheduled Reminders')).not.toBeInTheDocument()
    expect(screen.getByText('Recent Results')).toBeInTheDocument()
  })
})
