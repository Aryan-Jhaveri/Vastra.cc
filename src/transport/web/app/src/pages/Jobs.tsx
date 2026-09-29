import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { toggleJob, deleteJob } from '../api/jobs'
import type { ScheduledJob } from '../api/jobs'
import { apiFetchJSON } from '../api/client'
import { JobModal } from '../modals/JobModal'
import { Button } from '../components/ui/Button'
import { Spinner } from '../components/ui/Spinner'
import type { Outfit } from '../api/outfits'

// HydratedJob extends ScheduledJob with an optional embedded outfit
interface HydratedJob extends ScheduledJob {
  outfit: Outfit | null
}

async function fetchJobsHydrated(): Promise<HydratedJob[]> {
  return apiFetchJSON('/api/jobs?hydrate=true')
}

function formatLastRun(ts: number | null): string {
  if (!ts) return 'Never'
  const d = new Date(ts)
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

function formatSchedule(s: string): string {
  // Human-readable hint for common cron expressions
  const MAP: Record<string, string> = {
    '0 8 * * *': 'Daily at 8am',
    '0 9 * * *': 'Daily at 9am',
    '0 7 * * *': 'Daily at 7am',
    '0 8 * * 1': 'Mondays at 8am',
    '0 9 * * 1': 'Mondays at 9am',
  }
  return MAP[s.trim()] ?? s
}

const TYPE_LABELS: Record<string, string> = {
  daily_outfit: 'Daily Outfit',
  outfit_reminder: 'Outfit reminder',
}

interface JobCardProps {
  job: HydratedJob
  onEdit: (job: HydratedJob) => void
  onToggle: (job: HydratedJob) => void
  toggling: boolean
  selectable?: boolean
  selected?: boolean
  onSelect?: () => void
}

function JobCard({ job, onEdit, onToggle, toggling, selectable, selected, onSelect }: JobCardProps) {

  const thumbnailUri = job.outfit?.coverImageUri
    ?? (job.outfit as (Outfit & { items?: Array<{ imageUri?: string }> }) | null)?.items?.[0]?.imageUri

  const borderClass = selectable
    ? (selected
      ? 'border-transparent animate-border-march'
      : job.enabled ? 'border-ink' : 'border-outline-variant')
    : (selected
      ? 'border-accent ring-2 ring-accent ring-offset-1'
      : job.enabled ? 'border-ink' : 'border-outline-variant')

  return (
    <div
      className={`relative border-2 ${borderClass} p-4 flex flex-col gap-2 ${selectable ? 'cursor-pointer' : ''} rounded-base`}
      onClick={selectable ? onSelect : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {/* Thumbnail or clock icon */}
          {job.type === 'outfit_reminder' && thumbnailUri ? (
            <img
              src={`/${thumbnailUri}`}
              alt="Outfit"
              className="w-10 h-10 object-cover border border-outline-variant flex-shrink-0"
            />
          ) : (
            <div className="w-10 h-10 border border-outline-variant flex items-center justify-center flex-shrink-0 text-muted">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-5 h-5">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </div>
          )}
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${job.enabled ? 'bg-success' : 'bg-outline-variant'}`} />
              <p className="text-sm font-bold truncate">{job.name}</p>
            </div>
            <p className="text-[14px] font-mono text-muted pl-3.5">
              {TYPE_LABELS[job.type] ?? job.type}
            </p>
            {typeof job.params?.theme === 'string' && (
              <p className="text-[14px] font-mono text-muted pl-3.5 truncate">{job.params.theme}</p>
            )}
          </div>
        </div>

        {!selectable && (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => onEdit(job)}
              className="text-[14px] font-bold font-mono uppercase tracking-[0.06em] text-muted hover:text-ink px-1.5 py-1 border border-outline-variant hover:border-ink"
            >
              Edit
            </button>
            <button
              onClick={() => onToggle(job)}
              disabled={toggling}
              className="text-[14px] font-bold font-mono uppercase tracking-[0.06em] text-muted hover:text-ink px-1.5 py-1 border border-outline-variant hover:border-ink disabled:opacity-40"
            >
              {toggling ? '…' : job.enabled ? 'Pause' : 'Resume'}
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-outline-variant pt-2">
        <p className="text-[14px] font-mono text-muted">{formatSchedule(job.schedule)}</p>
        <p className="text-[14px] font-mono text-muted">Last run: {formatLastRun(job.lastRunAt)}</p>
      </div>
    </div>
  )
}

export function Jobs() {
  const navigate = useNavigate()
  const [jobs, setJobs] = useState<HydratedJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalJob, setModalJob] = useState<HydratedJob | 'new' | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)

  const load = useCallback(async () => {
    try {
      const j = await fetchJobsHydrated()
      setJobs(j)
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  async function handleToggle(job: HydratedJob) {
    setToggling(job.id)
    try {
      const updated = await toggleJob(job.id)
      setJobs(prev => prev.map(j => j.id === job.id ? { ...updated, outfit: job.outfit } : j))
    } catch (err) {
      setError(String(err))
    } finally {
      setToggling(null)
    }
  }

  function handleSaved(saved: ScheduledJob) {
    setJobs(prev => {
      const exists = prev.find(j => j.id === saved.id)
      const hydratedSaved: HydratedJob = { ...saved, outfit: prev.find(j => j.id === saved.id)?.outfit ?? null }
      return exists ? prev.map(j => j.id === saved.id ? hydratedSaved : j) : [hydratedSaved, ...prev]
    })
    setModalJob(null)
    // Reload to get fresh hydrated data
    void load()
  }

  function toggleSelect(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function exitSelectMode() {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  const prevSelSizeRef = useRef(0)
  useEffect(() => {
    if (selectMode && selectedIds.size === 0 && prevSelSizeRef.current > 0) {
      setSelectMode(false)
    }
    prevSelSizeRef.current = selectedIds.size
  }, [selectMode, selectedIds.size])

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return
    setBulkDeleting(true)
    try {
      await Promise.all([...selectedIds].map(id => deleteJob(id)))
      setJobs(prev => prev.filter(j => !selectedIds.has(j.id)))
      exitSelectMode()
    } catch (err) {
      setError(String(err))
    } finally {
      setBulkDeleting(false)
    }
  }

  return (
    <div className="flex flex-col p-4 pb-24">
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1 text-[14px] font-bold font-mono uppercase tracking-[0.08em] text-muted hover:text-ink mb-3 w-fit"
      >
        <ChevronLeft className="w-3 h-3" strokeWidth={2.5} />
        Back
      </button>
      <div className="flex items-end justify-between border-b-2 border-ink pb-2 mb-1">
        <div>
          <h1 className="text-[22px] font-bold leading-none">Jobs.</h1>
          <p className="text-[14px] font-mono text-muted mt-0.5">
            {selectMode
              ? (selectedIds.size > 0 ? `${selectedIds.size} selected` : 'select jobs')
              : 'Scheduled tasks · changes apply on next bot restart'}
          </p>
        </div>
        {selectMode ? (
          <div className="flex gap-2">
            <button
              onClick={() => { void handleBulkDelete() }}
              disabled={selectedIds.size === 0 || bulkDeleting}
              className="bg-error text-white border-2 border-error px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] transition-colors disabled:opacity-30"
            >
              {bulkDeleting ? '…' : `Delete${selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}`}
            </button>
            <button
              onClick={exitSelectMode}
              className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim transition-colors rounded-base"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => setSelectMode(true)}
              className="border-2 border-ink px-3 py-1.5 text-[14px] font-bold font-mono uppercase tracking-[0.08em] hover:bg-surface-dim transition-colors rounded-base"
            >
              Select
            </button>
            <Button variant="secondary" onClick={() => setModalJob('new')} className="flex items-center gap-1"><Plus className="w-3.5 h-3.5" strokeWidth={2.5} /> Add</Button>
          </div>
        )}
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {error && (
        <p className="text-[14px] font-mono text-error mb-4">{error}</p>
      )}

      {!loading && jobs.length === 0 && (
        <div className="border-2 border-dashed border-outline-variant p-8 text-center">
          <p className="text-sm font-mono text-muted">No scheduled jobs yet.</p>
          <button
            onClick={() => setModalJob('new')}
            className="mt-3 text-[14px] font-bold font-mono uppercase tracking-[0.08em] text-ink underline"
          >
            Create your first job <ChevronRight className="w-3 h-3 inline-block" />
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3 mt-5">
        {jobs.map(job => (
          <JobCard
            key={job.id}
            job={job}
            onEdit={j => setModalJob(j)}
            onToggle={handleToggle}
            toggling={toggling === job.id}
            selectable={selectMode}
            selected={selectMode && selectedIds.has(job.id)}
            onSelect={() => toggleSelect(job.id)}
          />
        ))}
      </div>

      {modalJob !== null && (
        <JobModal
          job={modalJob === 'new' ? undefined : modalJob}
          onClose={() => setModalJob(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  )
}
