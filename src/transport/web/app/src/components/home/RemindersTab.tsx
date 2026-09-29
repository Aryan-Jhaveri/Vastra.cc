import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Clock, Settings2 } from 'lucide-react'
import { Spinner } from '../ui/Spinner'
import { OutfitCard } from '../OutfitCard'
import { useReminders } from '../../hooks/useReminders'
import { createOutfit } from '../../api/outfits'
import { clearJobHistory } from '../../api/jobs'
import type { UpcomingJob, JobRun } from '../../api/jobs'
import type { OutfitSuggestion, HydratedOutfit } from '../../api/outfits'

function relativeTime(ts: number): string {
  const diff = ts - Date.now()
  const days = Math.round(diff / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  return new Date(ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function relativePast(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(diff / 3600000)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(diff / 86400000)
  if (days === 1) return 'Yesterday'
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function jobDescription(job: UpcomingJob): string {
  if (job.type === 'outfit_reminder' && job.outfit) return `Wear: ${job.outfit.name}`
  if (job.type === 'daily_outfit') {
    const theme = job.params.theme as string | undefined
    return theme ? `Daily suggestion — ${theme}` : 'Daily outfit suggestion'
  }
  return job.name
}

function UpcomingCard({ job }: { job: UpcomingJob }) {
  const fireTime = new Date(job.nextRunAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  return (
    <div className="border-2 border-ink p-3 flex items-start gap-3">
      <div className="shrink-0 mt-0.5">
        <Clock className="w-3.5 h-3.5 text-muted" strokeWidth={2} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em] truncate">{job.name}</span>
        <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">{jobDescription(job)}</span>
      </div>
      <div className="shrink-0 text-right flex flex-col gap-0.5">
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.06em]">{relativeTime(job.nextRunAt)}</span>
        <span className="text-[14px] font-mono text-muted">{fireTime}</span>
      </div>
    </div>
  )
}

function hydratedOutfitToSuggestion(outfit: HydratedOutfit): OutfitSuggestion {
  let item_ids: string[] = []
  try { item_ids = JSON.parse(outfit.itemIds) as string[] } catch { /* ignore */ }
  return {
    item_ids,
    name: outfit.name,
    occasion: outfit.occasion ?? '',
    reasoning: outfit.notes ?? '',
    items: outfit.items,
  }
}

function RecentRunCard({ run, savedIds, savingId, onSave }: {
  run: JobRun
  savedIds: Set<string>
  savingId: string | null
  onSave: (suggestion: OutfitSuggestion, key: string) => void
}) {
  const label = run.job?.name ?? 'Job'

  if (run.status === 'failed') {
    return (
      <div className="border-2 border-outline-variant p-3 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em] text-muted">{label}</span>
          <span className="text-[14px] font-mono text-muted">{relativePast(run.firedAt)}</span>
        </div>
        <span className="text-[14px] font-mono text-error">Failed to run</span>
      </div>
    )
  }

  if (run.suggestions.length === 0) {
    if (run.reminderOutfit) {
      const suggestion = hydratedOutfitToSuggestion(run.reminderOutfit)
      const key = `${run.id}-reminder`
      return (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">{label}</span>
            <span className="text-[14px] font-mono text-muted">{relativePast(run.firedAt)}</span>
          </div>
          <OutfitCard
            suggestion={suggestion}
            onSave={savedIds.has(key) ? undefined : () => onSave(suggestion, key)}
            saving={savingId === key}
            showShare
          />
        </div>
      )
    }
    return (
      <div className="border-2 border-outline-variant p-3 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em] text-muted">{label}</span>
          <span className="text-[14px] font-mono text-muted">{relativePast(run.firedAt)}</span>
        </div>
        <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">No results</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">{label}</span>
        <span className="text-[14px] font-mono text-muted">{relativePast(run.firedAt)}</span>
      </div>
      {run.suggestions.map((s, i) => {
        const key = `${run.id}-${i}`
        return (
          <OutfitCard
            key={key}
            suggestion={{ ...s, name: s.name || `Outfit #${String(i + 1).padStart(2, '0')}` }}
            onSave={savedIds.has(key) ? undefined : () => onSave(s, key)}
            saving={savingId === key}
            showShare
          />
        )
      })}
    </div>
  )
}

// Pick the renderable suggestion for a run: the durable resultJson snapshot
// first, falling back to the rehydrated source outfit for legacy rows.
function runToSuggestion(run: JobRun): OutfitSuggestion | null {
  if (run.suggestions.length > 0) return run.suggestions[0]
  if (run.reminderOutfit) return hydratedOutfitToSuggestion(run.reminderOutfit)
  return null
}

// A fired outfit_reminder run. The outfit already exists in the closet, so this
// offers View + Share (no Save). Renders from resultJson so it survives deletion
// of the source outfit; the View link just won't resolve once it's gone.
function ScheduledReminderCard({ run, onView }: {
  run: JobRun
  onView: (outfitId: string) => void
}) {
  const label = run.job?.name ?? 'Reminder'
  const suggestion = runToSuggestion(run)

  if (!suggestion) {
    return (
      <div className="border-2 border-outline-variant p-3 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-bold font-mono uppercase tracking-[0.08em] text-muted">{label}</span>
          <span className="text-[14px] font-mono text-muted">{relativePast(run.firedAt)}</span>
        </div>
        <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">Outfit no longer available</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-mono text-muted uppercase tracking-[0.06em]">{label}</span>
        <span className="text-[14px] font-mono text-muted">{relativePast(run.firedAt)}</span>
      </div>
      <OutfitCard
        suggestion={suggestion}
        saved={!!run.reminderOutfitId}
        onView={run.reminderOutfitId ? () => onView(run.reminderOutfitId!) : undefined}
        showShare
      />
    </div>
  )
}

export function RemindersTab() {
  const { upcoming, history, loading, error, refetch } = useReminders()
  const navigate = useNavigate()
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [savingId, setSavingId] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)

  async function handleSave(suggestion: OutfitSuggestion, key: string) {
    setSavingId(key)
    setSaveError(null)
    try {
      await createOutfit({
        name: suggestion.name,
        itemIds: suggestion.item_ids,
        occasion: suggestion.occasion,
        aiGenerated: true,
      })
      setSavedIds(prev => new Set([...prev, key]))
    } catch (err) {
      setSaveError(String(err))
    } finally {
      setSavingId(null)
    }
  }

  async function handleClearHistory() {
    setClearing(true)
    try {
      await clearJobHistory()
      refetch()
    } finally {
      setClearing(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )
  }

  if (error) {
    return (
      <p className="text-[14px] font-mono text-error uppercase tracking-[0.06em] text-center py-6">
        Could not load reminders.
      </p>
    )
  }

  const sorted = [...upcoming].sort((a, b) => a.nextRunAt - b.nextRunAt)
  const recentRuns = history.filter(r => r.status !== 'skipped')
  // Fired outfit reminders get their own section (View + Share); everything else
  // (daily_outfit suggestions, failures) stays in Recent Results.
  const scheduledReminders = recentRuns.filter(r => r.status === 'success' && r.job?.type === 'outfit_reminder')
  const otherRuns = recentRuns.filter(r => !(r.status === 'success' && r.job?.type === 'outfit_reminder'))

  function viewOutfit(outfitId: string) {
    navigate('/outfits', { state: { openOutfitId: outfitId } })
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Manage Jobs link */}
      <Link
        to="/jobs"
        className="flex items-center gap-2 border-2 border-ink px-3 py-2.5 hover:bg-surface-dim transition-colors"
      >
        <Settings2 className="w-3.5 h-3.5" strokeWidth={2} />
        <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Manage Scheduled Jobs</span>
      </Link>

      {/* Upcoming section */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center border-b-2 border-ink pb-2">
          <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Upcoming (next 7 days)</span>
        </div>

        {sorted.length === 0 ? (
          <p className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] text-center py-4">
            No scheduled jobs in the next 7 days.
          </p>
        ) : (
          sorted.map(job => <UpcomingCard key={job.id} job={job} />)
        )}
      </div>

      {/* Scheduled Reminders section — fired outfit reminders */}
      {scheduledReminders.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center border-b-2 border-ink pb-2">
            <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Scheduled Reminders</span>
          </div>
          {scheduledReminders.map(run => (
            <ScheduledReminderCard key={run.id} run={run} onView={viewOutfit} />
          ))}
        </div>
      )}

      {/* Recent results section */}
      {otherRuns.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between border-b-2 border-ink pb-2">
            <span className="text-[14px] font-bold font-mono uppercase tracking-[0.1em]">Recent Results</span>
            <button
              onClick={() => void handleClearHistory()}
              disabled={clearing}
              className="text-[14px] font-mono text-muted uppercase tracking-[0.06em] hover:text-ink transition-colors disabled:opacity-40"
            >
              {clearing ? '…' : 'Clear All'}
            </button>
          </div>

          {saveError && (
            <p className="text-[14px] font-mono text-error uppercase tracking-[0.06em]">
              Failed to save: {saveError}
            </p>
          )}

          {otherRuns.map(run => (
            <RecentRunCard
              key={run.id}
              run={run}
              savedIds={savedIds}
              savingId={savingId}
              onSave={handleSave}
            />
          ))}
        </div>
      )}
    </div>
  )
}
