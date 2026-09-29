import morgan from 'morgan'
import type { Request, Response } from 'express'

// Custom token: the authenticated userId (populated by attachSession /
// requireSession), or '-' when the request is unauthenticated.
morgan.token<Request, Response>('userId', (req) => req.userId || '-')

const FORMAT =
  ':date[iso] :method :url :status :res[content-length] - :response-time ms user=:userId'

// Don't log static asset traffic — it's high-volume and drowns out the
// per-route / per-user signal we actually want (#165).
function skip(req: Request): boolean {
  return req.path.startsWith('/images') || req.path.startsWith('/assets')
}

// Factory so tests can inject a capture stream instead of polluting stdout.
// Defaults to morgan's stdout stream in real usage.
export function requestLogger(stream?: morgan.StreamOptions) {
  return morgan<Request, Response>(FORMAT, {
    skip,
    ...(stream ? { stream } : {}),
  })
}
