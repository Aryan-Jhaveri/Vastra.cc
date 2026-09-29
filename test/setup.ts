import { beforeAll, beforeEach } from 'vitest'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { db, getSqlite } from '../src/db/client.js'
import { reconcileMigrations } from '../src/db/reconcileMigrations.js'
import { users } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import request from 'supertest'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Run once per test process before any test file. Ensures every test file
// sees a fully-migrated schema regardless of which file vitest picks up
// first under sequential file mode.
reconcileMigrations(getSqlite(), join(__dirname, '../src/db/migrations'))

// Seed the 'self' user so instrumented AI calls (which now write ai_calls
// rows for analytics) have a valid user reference.
const existing = db.select().from(users).where(eq(users.id, 'self')).get()
if (!existing) {
  db.insert(users).values({
    id: 'self',
    email: 'self@local.closet',
    createdAt: Date.now(),
  }).run()
}

// #358 — register the hosted extras (wallet billing, per-user keys, hosted
// jobs) the way server.ts does at boot, but only for the hosted run (the root
// config sets HOSTED_MODE=true). The self-host run (vitest.selfhost.config.ts)
// leaves HOSTED_MODE unset and never loads src/hosted, as in the open-source
// export. The hooks only take effect while HOSTED_MODE is 'true', so hosted-run
// tests that delete it still get self-host behaviour. Imported in beforeAll,
// after the test file's vi.mock calls are registered, so hosted modules pick
// up each file's mocks.
const HOSTED_RUN = process.env.HOSTED_MODE === 'true'
beforeAll(async () => {
  if (!HOSTED_RUN) return
  const { registerHostedHooks } = await import('../src/hosted/index.js')
  registerHostedHooks()
})

// The weather cache is process-wide; each test starts cold.
// Files that vi.mock the module without this export skip it (a mock has no cache).
beforeEach(async () => {
  const mod = await import('../src/tools/weather.js') as Record<string, unknown>
  try {
    if (typeof mod.resetWeatherCache === 'function') (mod.resetWeatherCache as () => void)()
  } catch { /* strict vi.mock factory without the export */ }
})

// #308 — bind supertest's ephemeral server to 127.0.0.1, where it requests.
// supertest calls app.listen(0) with no host, which binds IPv6 `::`, then
// requests http://127.0.0.1:<port>. On macOS the `::` port picker ignores
// ports another process already holds on 127.0.0.1, so a test could land on
// one and its request reached that process instead (a stray 401 in whichever
// fast route test drew the port). Binding with a host is async, so the listen
// is deferred to end(); supertest still closes this._server afterwards.
type PendingListen = { app: { listen: Function; address: () => { port: number } | null }; path: string }
const Test = (request as unknown as { Test: { prototype: Record<string, any> } }).Test
const originalServerAddress = Test.prototype.serverAddress
const originalEnd = Test.prototype.end
Test.prototype.serverAddress = function (app: PendingListen['app'], path: string) {
  if (app.address()) return originalServerAddress.call(this, app, path)
  this._pendingListen = { app, path } satisfies PendingListen
  return `http://127.0.0.1:0${path}` // replaced in end() once bound
}
Test.prototype.end = function (fn: unknown) {
  const pending = this._pendingListen as PendingListen | undefined
  if (!pending) return originalEnd.call(this, fn)
  this._pendingListen = undefined
  this._server = pending.app.listen(0, '127.0.0.1', () => {
    this.url = `http://127.0.0.1:${pending.app.address()!.port}${pending.path}`
    originalEnd.call(this, fn)
  })
  return this
}
