import { useState, useEffect } from 'react'
import { X, ChevronDown, Check } from 'lucide-react'
import * as RadixSelect from '@radix-ui/react-select'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { geocodeCity } from '../api/weather'
import { createJob, updateJob } from '../api/jobs'
import { useLocation } from '../hooks/useLocation'
import type { ScheduledJob } from '../api/jobs'

// ── Schedule builder (croner 5-field format: minute hour dom month dow) ───────

type Mode = 'recurring' | 'one-time'

const DAYS = [
  { label: 'Mon', value: '1' },
  { label: 'Tue', value: '2' },
  { label: 'Wed', value: '3' },
  { label: 'Thu', value: '4' },
  { label: 'Fri', value: '5' },
  { label: 'Sat', value: '6' },
  { label: 'Sun', value: '0' },
]

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: `${String(i).padStart(2, '0')}:00`,
}))

const MINUTES = ['00', '15', '30', '45'].map(m => ({ value: m === '00' ? '0' : String(parseInt(m)), label: `:${m}` }))

function buildCron(mode: Mode, hour: string, minute: string, days: string[], oneTimeDate: string): string {
  if (mode === 'one-time') return oneTimeDate
  const dow = days.length === 0 ? '*' : days.join(',')
  return `${minute} ${hour} * * ${dow}`
}

function parseCron(schedule: string): { mode: Mode; hour: string; minute: string; days: string[]; oneTimeDate: string } {
  if (/^\d{4}-\d{2}-\d{2}T/.test(schedule)) {
    return { mode: 'one-time', hour: '8', minute: '0', days: [], oneTimeDate: schedule }
  }
  const parts = schedule.trim().split(/\s+/)
  if (parts.length === 5) {
    const [min, hr, , , dow] = parts
    const days = dow === '*' ? [] : dow.split(',').filter(Boolean)
    return { mode: 'recurring', hour: hr, minute: min, days, oneTimeDate: '' }
  }
  return { mode: 'recurring', hour: '8', minute: '0', days: [], oneTimeDate: '' }
}

function InlineSelect({ value, onValueChange, options, className = '' }: {
  value: string
  onValueChange: (v: string) => void
  options: { value: string; label: string }[]
  className?: string
}) {
  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange}>
      <RadixSelect.Trigger className={`flex items-center justify-between border-2 border-ink px-2 py-1.5 text-sm font-mono outline-none focus:bg-surface-dim bg-paper cursor-pointer rounded-base ${className}`}>
        <RadixSelect.Value />
        <RadixSelect.Icon asChild>
          <ChevronDown size={10} className="shrink-0 ml-1" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={2}
          style={{ maxHeight: 'min(var(--radix-select-content-available-height), 240px)' }}
          className="z-50 w-[var(--radix-select-trigger-width)] border-2 border-ink bg-paper shadow-[4px_4px_0px_0px_var(--color-shadow)] rounded-base"
        >
          <RadixSelect.Viewport
            style={{ overscrollBehavior: 'contain', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}
            className="overflow-y-auto max-h-[inherit]"
          >
            {options.map(o => (
              <RadixSelect.Item
                key={o.value}
                value={o.value}
                className="flex items-center justify-between px-2 py-1.5 text-sm font-mono text-ink cursor-pointer select-none outline-none data-[highlighted]:bg-surface-dim data-[state=checked]:font-bold"
              >
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                <RadixSelect.ItemIndicator>
                  <Check size={8} strokeWidth={2.5} />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}

interface SchedulePickerProps {
  value: string
  onChange: (cron: string) => void
}

function SchedulePicker({ value, onChange }: SchedulePickerProps) {
  const parsed = parseCron(value)
  const [mode, setMode] = useState<Mode>(parsed.mode)
  const [hour, setHour] = useState(parsed.hour)
  const [minute, setMinute] = useState(parsed.minute)
  const [days, setDays] = useState<string[]>(parsed.days)
  const [oneTimeDate, setOneTimeDate] = useState(parsed.oneTimeDate)

  function emit(mo = mode, h = hour, m = minute, d = days, dt = oneTimeDate) {
    onChange(buildCron(mo, h, m, d, dt))
  }

  function toggleDay(val: string) {
    const next = days.includes(val) ? days.filter(d => d !== val) : [...days, val]
    setDays(next)
    emit(mode, hour, minute, next)
  }

  const labelClass = 'text-[12px] font-bold font-mono uppercase tracking-[0.1em] text-muted mb-1 block'

  return (
    <div className="flex flex-col gap-3">
      {/* Mode */}
      <div>
        <span className={labelClass}>Mode</span>
        <div className="flex gap-1">
          {(['recurring', 'one-time'] as Mode[]).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); emit(m) }}
              className={`flex-1 py-2 text-[13px] font-bold font-sans uppercase tracking-[0.06em] border-2 border-ink shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base ${
                mode === m ? 'bg-accent text-accent-on' : 'bg-paper text-ink hover:bg-surface-dim'
              }`}
            >
              {m === 'one-time' ? 'One-time' : 'Recurring'}
            </button>
          ))}
        </div>
      </div>

      {mode === 'one-time' ? (
        <div>
          <span className={labelClass}>Date & Time</span>
          <input
            type="datetime-local"
            value={oneTimeDate}
            onChange={e => { setOneTimeDate(e.target.value); emit(mode, hour, minute, days, e.target.value) }}
            className="border-2 border-ink px-2 py-1.5 text-sm font-mono outline-none focus:bg-surface-dim bg-paper w-full"
          />
        </div>
      ) : (
        <>
          {/* Day-of-week multi-select (inspired by n8n ScheduleTrigger) */}
          <div>
            <span className={labelClass}>Days — leave all off for every day</span>
            <div className="flex gap-1 flex-wrap">
              {DAYS.map(d => (
                <button
                  key={d.value}
                  type="button"
                  onClick={() => toggleDay(d.value)}
                  className={`px-2 py-1.5 text-[13px] font-bold font-sans border-2 border-ink shadow-flat-xs active:translate-x-[2px] active:translate-y-[2px] active:shadow-none transition-[transform,box-shadow,colors] rounded-base ${
                    days.includes(d.value)
                      ? 'bg-accent text-accent-on'
                      : 'bg-paper text-ink hover:bg-surface-dim'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <span className={labelClass}>Hour</span>
              <InlineSelect
                value={hour}
                onValueChange={v => { setHour(v); emit(mode, v, minute, days) }}
                options={HOURS}
                className="w-full"
              />
            </div>

            <div>
              <span className={labelClass}>Min</span>
              <InlineSelect
                value={minute}
                onValueChange={v => { setMinute(v); emit(mode, hour, v, days) }}
                options={MINUTES}
              />
            </div>
          </div>
        </>
      )}

      {/* Preview */}
      <p className="text-[12px] font-mono text-muted">
        Schedule: <span className="text-muted">{value || '—'}</span>
      </p>
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export interface JobFormState {
  name: string
  type: string
  schedule: string
  params: Record<string, unknown>
}

interface JobModalProps {
  job?: ScheduledJob
  initialValues?: Partial<JobFormState>
  onClose: () => void
  onSaved: (job: ScheduledJob) => void
}

export function JobModal({ job, initialValues, onClose, onSaved }: JobModalProps) {
  const isEdit = !!job
  const isTypeLocked = !isEdit && !!initialValues?.type
  const type = job?.type ?? initialValues?.type ?? 'daily_outfit'

  const [name, setName] = useState(job?.name ?? initialValues?.name ?? '')
  const [schedule, setSchedule] = useState(job?.schedule ?? '0 8 * * *')

  const existingParams = job?.params ?? (initialValues?.params as Record<string, unknown> | undefined) ?? {}
  const { location: currentLocation } = useLocation()
  const [city, setCity] = useState(
    (existingParams.locationName as string) ?? currentLocation?.name ?? '',
  )
  const [theme, setTheme] = useState((existingParams.theme as string) ?? '')
  const [geoError, setGeoError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isEdit) setSchedule('0 8 * * *')
  }, [type, isEdit])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim() || !schedule) return
    setSaving(true)
    setError(null)

    try {
      let params: Record<string, unknown> = {}

      if (type === 'daily_outfit' || (isEdit && job?.type === 'daily_outfit')) {
        setGeoError(null)
        // Default to the current/saved location; only geocode when the user has
        // typed a different city. An empty field keeps the current location, or
        // falls back to no location — the job still creates (just no weather)
        // instead of blocking the whole form.
        let loc: { lat: number; lon: number; name: string } | null = currentLocation
        const typed = city.trim()

        if (typed && typed !== loc?.name) {
          try {
            const result = await geocodeCity(typed)
            loc = { lat: result.lat, lon: result.lon, name: result.name }
          } catch {
            setGeoError('Could not find that city. Check the spelling, or clear the field to use your current location.')
            setSaving(false)
            return
          }
        }

        params = {
          ...(loc ? { lat: loc.lat, lon: loc.lon, locationName: loc.name } : {}),
          ...(theme.trim() ? { theme: theme.trim() } : {}),
        }
      } else if (type === 'outfit_reminder') {
        params = {
          outfitId: existingParams.outfitId as string,
        }
      }

      const saved = isEdit
        ? await updateJob(job!.id, { name: name.trim(), schedule, params })
        : await createJob({ name: name.trim(), type, schedule, params })

      onSaved(saved)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const TYPE_LABELS: Record<string, string> = {
    daily_outfit: 'Daily Outfit',
    outfit_reminder: 'Outfit Reminder',
  }

  return (
    <div
      className="fixed inset-0 nav-anchor-right z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-lg bg-paper border-2 border-ink p-5 flex flex-col gap-4 max-h-[90vh] overflow-y-auto rounded-base" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-[17px] font-bold leading-none">
            {isEdit ? 'Edit Job' : 'New Job'}
          </h2>
          <button aria-label="Close" onClick={onClose} className="text-muted hover:text-ink p-0.5"><X className="w-4 h-4" /></button>
        </div>

        {/* Locked type badge */}
        {isTypeLocked && (
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] text-muted">Type</span>
            <span className="border-2 border-ink px-2 py-0.5 text-[13px] font-bold font-mono uppercase tracking-[0.06em] bg-accent text-accent-on rounded-base">
              {TYPE_LABELS[type] ?? type}
            </span>
            {typeof existingParams.outfitId === 'string' && (
              <span className="text-[12px] font-mono text-muted">outfit locked</span>
            )}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {/* Name */}
          <Input
            label="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Morning Outfit"
            required
          />

          {/* Schedule picker */}
          <div>
            <span className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] text-muted mb-2 block">
              Schedule
            </span>
            <SchedulePicker value={schedule} onChange={setSchedule} />
          </div>

          {/* daily_outfit: city + theme */}
          {(type === 'daily_outfit' || (isEdit && job?.type === 'daily_outfit')) && (
            <>
              <div className="flex flex-col gap-1">
                <Input
                  label="Location (city)"
                  value={city}
                  onChange={e => { setCity(e.target.value); setGeoError(null) }}
                  placeholder="e.g. Toronto"
                  error={geoError ?? undefined}
                />
                <p className="text-[12px] font-mono text-muted">Defaults to your current location — leave blank to keep it.</p>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[12px] font-bold font-mono uppercase tracking-[0.1em] text-muted">
                  Theme / Prompt (optional)
                </label>
                <textarea
                  value={theme}
                  onChange={e => setTheme(e.target.value)}
                  placeholder="e.g. formal business meeting, casual weekend, gym day..."
                  rows={2}
                  className="border-2 border-ink px-3 py-2 text-sm font-mono outline-none focus:bg-surface-dim bg-paper resize-none"
                />
                <p className="text-[12px] font-mono text-muted">Guides the AI outfit suggestion</p>
              </div>
            </>
          )}


          {error && <p className="text-[14px] font-mono text-error">{error}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="submit" loading={saving} className="flex-1">
              {isEdit ? 'Save changes' : 'Create job'}
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </div>
  )
}
