/**
 * Combined entry point for Render (or any single-process deployment).
 * Starts the Express web server.
 *
 * Env vars:
 *   PORT               — assigned by Render; falls back to WEB_PORT, then 3000
 */
import 'dotenv/config'
import { app, installLiveImportLock, assertGcpProjectId, runBootChecks } from './transport/web/server.js'

const PORT = parseInt(process.env.PORT ?? process.env.WEB_PORT ?? '3000', 10)
installLiveImportLock()

// #315 — server.ts only runs assertGcpProjectId when invoked directly; the
// Docker CMD goes through this entrypoint, so enforce it here too. The guard
// is a no-op unless HOSTED_MODE is on (self-host boots without GCP_PROJECT_ID).
assertGcpProjectId()
runBootChecks()

const server = app.listen(PORT, () => {
  console.log(`Closet web server running on port ${PORT}`)
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use`)
  } else {
    console.error('Server error:', err)
  }
  process.exit(1)
})
