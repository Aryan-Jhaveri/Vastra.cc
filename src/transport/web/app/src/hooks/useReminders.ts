import { useState, useEffect, useCallback } from 'react'
import { fetchUpcomingJobs, fetchJobHistory } from '../api/jobs'
import type { UpcomingJob, JobRun } from '../api/jobs'

export function useReminders() {
  const [upcoming, setUpcoming] = useState<UpcomingJob[]>([])
  const [history, setHistory] = useState<JobRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([fetchUpcomingJobs(7), fetchJobHistory(14)])
      .then(([up, hist]) => {
        if (!cancelled) {
          setUpcoming(up)
          setHistory(hist)
        }
      })
      .catch(err => { if (!cancelled) setError(String(err)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tick])

  const refetch = useCallback(() => setTick(t => t + 1), [])

  // Auto-refresh so the scheduler's fresh job runs surface without a manual
  // reload: poll every 30s while the tab is visible, refetch immediately when
  // the tab regains visibility (e.g. returning after tapping a push), and
  // refetch when the service worker signals a job fired. All torn down on unmount.
  useEffect(() => {
    const POLL_MS = 30_000
    let intervalId: ReturnType<typeof setInterval> | undefined

    const stopPolling = () => {
      if (intervalId !== undefined) {
        clearInterval(intervalId)
        intervalId = undefined
      }
    }
    const startPolling = () => {
      stopPolling()
      intervalId = setInterval(() => {
        if (document.visibilityState === 'visible') refetch()
      }, POLL_MS)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refetch()
        startPolling()
      } else {
        stopPolling()
      }
    }

    const onSwMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | undefined)?.type === 'JOB_FIRED') refetch()
    }

    if (document.visibilityState === 'visible') startPolling()
    document.addEventListener('visibilitychange', onVisibilityChange)

    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
    sw?.addEventListener('message', onSwMessage)

    return () => {
      stopPolling()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      sw?.removeEventListener('message', onSwMessage)
    }
  }, [refetch])

  return { upcoming, history, loading, error, refetch }
}
