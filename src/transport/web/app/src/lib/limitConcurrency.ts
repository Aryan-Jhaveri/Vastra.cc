// Bounded-concurrency runner for the Add Item flow. Bulk detection and the
// crop → classify pass used to fire every request at once: 3 photos × 8 boxes
// meant 24 parallel full-resolution decodes on the phone and 24 categorize
// calls racing the server's 30/min per-user limit. Tasks queue FIFO behind
// `max` in-flight slots; a rejection frees its slot like a success does.

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

export function limitConcurrency(max: number): Limiter {
  if (!Number.isInteger(max) || max < 1) throw new Error('limitConcurrency: max must be a positive integer')
  let active = 0
  const waiting: Array<() => void> = []

  const release = () => {
    active--
    const next = waiting.shift()
    if (next) next()
  }

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active++
        let run: Promise<T>
        try {
          run = task()
        } catch (err) {
          run = Promise.reject(err)
        }
        run.then(resolve, reject).finally(release)
      }
      if (active < max) start()
      else waiting.push(start)
    })
}
