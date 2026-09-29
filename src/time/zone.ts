// Local wall-clock time for a user-supplied IANA zone. The server runs in UTC
// (Render), so `new Date().getHours()` is the wrong hour for everyone else:
// 3pm in Toronto read as "evening". Chat sends the browser's zone; MCP falls
// back to the location's zone from the weather lookup; otherwise UTC.

const MAX_ZONE_LENGTH = 64
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]*$/

/** A valid IANA zone name in canonical form, or undefined. Never throws. */
export function normalizeTimeZone(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const zone = raw.trim()
  if (!zone || zone.length > MAX_ZONE_LENGTH || !ZONE_SHAPE.test(zone)) return undefined
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

export interface LocalTime {
  /** 0–23 */
  hour: number
  /** 0 = Sunday … 6 = Saturday, like Date#getDay */
  weekday: number
  /** YYYY-MM-DD */
  date: string
  timeZone: string
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Wall-clock hour, weekday and date at `now` in `timeZone` (UTC when missing or invalid). */
export function localTime(now: Date, timeZone?: string): LocalTime {
  const zone = normalizeTimeZone(timeZone) ?? 'UTC'
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
    }).formatToParts(now).map(p => [p.type, p.value]),
  )
  return {
    hour: Number(parts.hour) % 24,
    weekday: WEEKDAYS.indexOf(parts.weekday),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    timeZone: zone,
  }
}
