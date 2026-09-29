import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import cookieParser from 'cookie-parser'
import { join, normalize, resolve, sep } from 'path'

let getSharePayloadMock = vi.fn()

const DATA_DIR = '/tmp/closet-test-images'
const mkdirSync = vi.fn()

let existsSyncMock = vi.fn()

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return { ...actual, existsSync: (...args: Parameters<typeof actual.existsSync>) => existsSyncMock(...args), mkdirSync }
})

vi.mock('../../src/db/client.js', () => ({
  db: {},
  DATA_DIR,
}))

vi.mock('../../src/db/queries.js', () => ({
  getSessionByToken: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
  setSetting: vi.fn(),
}))

vi.mock('../../src/storage/images.js', async () => {
  const actual = await vi.importActual('../../src/storage/images.js')
  return actual
})

vi.mock('../../src/transport/web/routes/items.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/outfits.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/weather.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/userPhotos.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/tryon.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/jobs.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/settings.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/collections.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/discover.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/share.js', () => ({ default: express.Router() }))
vi.mock('../../src/transport/web/routes/push.js', () => ({ default: express.Router() }))
vi.mock('../../src/jobs/seed.js', () => ({ seedDefaultJobs: vi.fn() }))
vi.mock('../../src/jobs/types/index.js', () => ({ registerBuiltInJobTypes: vi.fn() }))
vi.mock('drizzle-orm/better-sqlite3/migrator', () => ({ migrate: vi.fn() }))

function makeApp() {
  const app = express()
  app.use(cookieParser())
  app.use(express.json())

  // Simulate requireSession by setting req.userId from a header
  app.use('/images', (req, _res, next) => {
    const userId = req.headers['x-test-userid'] as string
    if (userId) {
      req.userId = userId
      next()
    } else {
      _res.status(401).json({ error: 'Unauthorized' })
    }
  })

  // Inline the /images route handler (same logic as server.ts)
  app.use('/images', (req, res) => {
    const safe = normalize(req.path).replace(/\\/g, '/')
    if (safe.includes('..')) return res.status(400).send('Invalid path')
    const relativePath = `images/${safe.replace(/^\//, '')}`

    function tryResolveUser(path: string): string | null {
      const userRel = `users/${req.userId}/${path}`
      const userAbs = join(DATA_DIR, userRel)
      if (existsSyncMock(userAbs)) return userRel
      if (req.userId === 'self') {
        const legacyAbs = join(DATA_DIR, path)
        if (existsSyncMock(legacyAbs)) return path
      }
      return null
    }

    function tryResolveShare(path: string): string | null {
      const m = path.match(/^images\/share\/([A-Za-z0-9_-]+)\/(.+)$/)
      if (!m) return null
      const payload = getSharePayloadMock(m[1])
      if (!payload) return null
      if (payload.expiresAt && payload.expiresAt < Date.now()) return null
      const ownerRel = `users/${payload.userId}/${path}`
      return existsSyncMock(join(DATA_DIR, ownerRel)) ? ownerRel : null
    }

    const serveRelativePath = tryResolveUser(relativePath) ?? tryResolveShare(relativePath)
    if (!serveRelativePath) return res.status(404).send('Not found')

    const resolved = resolve(join(DATA_DIR, serveRelativePath))
    const userImagesRoot = resolve(join(DATA_DIR, 'users', req.userId, 'images'))
    const legacyImagesRoot = resolve(join(DATA_DIR, 'images'))
    const sharedUsersRoot = resolve(join(DATA_DIR, 'users'))
    const isCrossUserShare =
      resolved.startsWith(sharedUsersRoot + sep) &&
      /\/images\/share\//.test(resolved.slice(sharedUsersRoot.length))
    if (
      !resolved.startsWith(userImagesRoot) &&
      !resolved.startsWith(legacyImagesRoot) &&
      !isCrossUserShare
    ) {
      return res.status(400).send('Invalid path')
    }

    res.sendFile(serveRelativePath, { root: DATA_DIR })
  })

  return app
}

describe('cross-user image isolation', () => {
  beforeEach(() => {
    existsSyncMock = vi.fn().mockReturnValue(false)
    getSharePayloadMock = vi.fn().mockReturnValue(undefined)
  })

  it('returns 404 when user B requests an image only in user A per-user dir', async () => {
    const userAPath = join(DATA_DIR, 'users', 'user-A', 'images', 'items', 'abc123.jpg')

    // Only user A's path exists on disk
    existsSyncMock.mockImplementation((p: string) => p === userAPath)

    const app = makeApp()

    const res = await request(app)
      .get('/images/items/abc123.jpg')
      .set('x-test-userid', 'user-B')

    expect(res.status).toBe(404)
  })

  it('returns 200 when the owning user requests their own image', async () => {
    const userAPath = join(DATA_DIR, 'users', 'user-A', 'images', 'items', 'abc123.jpg')

    existsSyncMock.mockImplementation((p: string) => p === userAPath)

    const app = makeApp()

    // Mock sendFile to not actually try to send a file
    vi.spyOn(app.response, 'sendFile').mockImplementation(function (this: any, ..._args: any[]) {
      return this.status(200).send('ok')
    })

    const res = await request(app)
      .get('/images/items/abc123.jpg')
      .set('x-test-userid', 'user-A')

    expect(res.status).toBe(200)
  })

  it('blocks path traversal attempts', async () => {
    const app = makeApp()

    // normalize() collapses ../ so a bare ../ passes through normalization
    // but slash-prefixed traversal is caught
    const res = await request(app)
      .get('/images/..%2f..%2fetc%2fpasswd')
      .set('x-test-userid', 'user-A')

    // express decodes %2f but normalize may or may not collapse
    // either 400 or 404 is acceptable (no file exists)
    expect([400, 404]).toContain(res.status)
  })

  it('allows legacy fallback for self user', async () => {
    const legacyPath = join(DATA_DIR, 'images', 'items', 'old-legacy.jpg')

    existsSyncMock.mockImplementation((p: string) => p === legacyPath)

    const app = makeApp()

    vi.spyOn(app.response, 'sendFile').mockImplementation(function (this: any, ..._args: any[]) {
      return this.status(200).send('ok')
    })

    const res = await request(app)
      .get('/images/items/old-legacy.jpg')
      .set('x-test-userid', 'self')

    expect(res.status).toBe(200)
  })

  it('denies legacy fallback for non-self users', async () => {
    const legacyPath = join(DATA_DIR, 'images', 'items', 'old-legacy.jpg')

    existsSyncMock.mockImplementation((p: string) => p === legacyPath)

    const app = makeApp()

    const res = await request(app)
      .get('/images/items/old-legacy.jpg')
      .set('x-test-userid', 'user-B')

    expect(res.status).toBe(404)
  })

  it('serves a share image to a viewer who is not the payload owner', async () => {
    // User A owns the share; the file lives under their tree.
    const ownerPath = join(DATA_DIR, 'users', 'user-A', 'images', 'share', 'PAYLOAD1', 'pic.jpg')
    existsSyncMock.mockImplementation((p: string) => p === ownerPath)
    getSharePayloadMock.mockImplementation((id: string) =>
      id === 'PAYLOAD1' ? { id, userId: 'user-A', expiresAt: Date.now() + 60_000 } : undefined,
    )

    const app = makeApp()
    vi.spyOn(app.response, 'sendFile').mockImplementation(function (this: any) {
      return this.status(200).send('ok')
    })

    const res = await request(app)
      .get('/images/share/PAYLOAD1/pic.jpg')
      .set('x-test-userid', 'user-B')

    expect(res.status).toBe(200)
  })

  it('404s a share image when the payload is expired', async () => {
    const ownerPath = join(DATA_DIR, 'users', 'user-A', 'images', 'share', 'PAYLOAD2', 'pic.jpg')
    existsSyncMock.mockImplementation((p: string) => p === ownerPath)
    getSharePayloadMock.mockImplementation((id: string) =>
      id === 'PAYLOAD2' ? { id, userId: 'user-A', expiresAt: Date.now() - 1 } : undefined,
    )

    const app = makeApp()

    const res = await request(app)
      .get('/images/share/PAYLOAD2/pic.jpg')
      .set('x-test-userid', 'user-B')

    expect(res.status).toBe(404)
  })

  it('404s a share image when no payload exists for the id', async () => {
    const ownerPath = join(DATA_DIR, 'users', 'user-A', 'images', 'share', 'GHOST', 'pic.jpg')
    existsSyncMock.mockImplementation((p: string) => p === ownerPath)
    // getSharePayloadMock returns undefined by default

    const app = makeApp()

    const res = await request(app)
      .get('/images/share/GHOST/pic.jpg')
      .set('x-test-userid', 'user-B')

    expect(res.status).toBe(404)
  })
})
