// Must stay the first import: modules imported below (src/db/client.ts)
// read CLOSET_DATA_DIR at load time. Loaded later, DATA_DIR silently falls
// back to ~/.closet and the dev server opens an empty closet.
import 'dotenv/config'
import { findRelated, lastRelatedResult, relatedQuotaHandler } from './routes/related.js'
import { isDecisionsConfigured } from '../../ai/decisionsProvider.js'
import { perUserRateLimit } from './middleware/perUserRateLimit.js'
import express from 'express'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { join, dirname, normalize, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, writeFileSync, rmSync } from 'fs'
import { db, DATA_DIR, getSqlite } from '../../db/client.js'
import { users } from '../../db/schema.js'
import { eq } from 'drizzle-orm'
import { reconcileMigrations } from '../../db/reconcileMigrations.js'
import { mkdirSync } from 'fs'
import { authGuard, getPassword, sessionToken, safeEqual, requireSession, requireAdmin, attachSession, requireShopEnabled, isHostedMode, requireTokensEnabled, requireChatEnabled } from './middleware.js'
import { requestLogger } from './logger.js'
import { getSystemSetting, setSystemSetting } from '../../db/queries.js'
import itemsRouter from './routes/items.js'
import outfitsRouter from './routes/outfits.js'
import weatherRouter from './routes/weather.js'
import userPhotosRouter from './routes/userPhotos.js'
import tryonRouter from './routes/tryon.js'
import jobsRouter from './routes/jobs.js'
import settingsRouter from './routes/settings.js'
import collectionsRouter from './routes/collections.js'
import discoverRouter from './routes/discover.js'
import shareRouter from './routes/share.js'
import shareTargetRouter from './routes/shareTarget.js'
import { getSharePayload } from '../../tools/share.js'
import pushRouter from './routes/push.js'
import accountRouter from './routes/account.js'
import suggestOccasionsRouter from './routes/suggest-occasions.js'
import analyticsRouter from './routes/analytics.js'
import { googleStart, googleCallback } from './routes/googleAuth.js'
import { isGoogleOAuthConfigured } from '../../auth/googleOAuth.js'
import { registerBuiltInJobTypes } from '../../jobs/types/index.js'
import { hostedHooks } from '../../hostedHooks.js'
import { registerHostedHooks, registerHostedPreJsonRoutes, registerHostedRoutes } from '../../hosted/index.js'
import { getSettings, updateSettings } from '../../settings.js'
import { seedDefaultJobs } from '../../jobs/seed.js'
import { initScheduler } from '../../jobs/scheduler.js'
import { initBackupCron } from '../../backups/cron.js'
import { checkImageIntegrity, checkTryonIntegrity } from '../../storage/integrityCheck.js'
import { importPaths } from '../../db/safeImport.mjs'
import authRouter from './routes/auth.js'
import ucpProfileRouter from './routes/ucpProfile.js'
import shopRouter from './routes/shop.js'
import { isShopEnabled } from '../../commerce/shopify/enabled.js'
import tokensRouter from './routes/tokens.js'
import chatRouter from './routes/chat.js'
import connectorsRouter from './routes/connectors.js'
import tagsRouter from './routes/tags.js'
import { uploadErrorResponse } from './upload.js'
import { trustProxySetting } from './trustProxy.js'
import { describeInstanceConfig } from '../../setup/instanceConfig.js'
import { initImageSweepCron } from '../../storage/imageSweep.js'
import adminEmbeddingsRouter from './routes/adminEmbeddings.js'
import { isChatEnabled } from '../../agent/chatEnabled.js'
import { mcpRouter } from '../mcp/server.js'

const missingLogCache = new Set<string>()

const __filename = fileURLToPath(import.meta.url)
import { cookieOpts } from './cookies.js'

const __dirname = dirname(__filename)

// #358 — hosted extras (wallet billing, per-user keys, hosted jobs) register
// before anything reads the hooks, e.g. the job types below.
if (isHostedMode()) registerHostedHooks()

// Register job types so the web server knows their schemas
registerBuiltInJobTypes()

// Run migrations on startup
mkdirSync(DATA_DIR, { recursive: true })
const migrationsFolder = join(__dirname, '../../db/migrations')
reconcileMigrations(getSqlite(), migrationsFolder)

// Seed default jobs (idempotent — only inserts if missing)
seedDefaultJobs()

// Seed WEB_AUTH_PASSWORD env var into DB settings on first startup.
// Skipped under VITEST so importing this module from a test (e.g.
// account.test.ts) doesn't pollute other tests' DBs or hit mocked db.
if (!process.env.VITEST && process.env.WEB_AUTH_PASSWORD && !getSystemSetting('password')) {
  setSystemSetting('password', process.env.WEB_AUTH_PASSWORD)
  console.log('[server] Seeded WEB_AUTH_PASSWORD into settings DB')
}

// Start the in-process cron scheduler
initScheduler()

// Monthly orphaned-image sweep (#362); IMAGE_SWEEP=off|report|apply.
if (!process.env.VITEST) initImageSweepCron()

// Start the nightly backup cron (requires BACKUP_ENCRYPTION_SECRET)
{
  const secret = process.env.BACKUP_ENCRYPTION_SECRET
  if (!secret || Buffer.from(secret, 'base64').length !== 32) {
    console.error('[startup] BACKUP_ENCRYPTION_SECRET missing or not exactly 32 bytes — backups disabled')
  } else {
    initBackupCron()
  }
}

const ADMIN_FALLBACK = process.env.ADMIN_BEARER_FALLBACK === 'true'

// Ensure legacy admin-fallback user exists at startup (so wallet.ts doesn't
// need to special-case 'self' — the signup grant applies uniformly to all users).
if (ADMIN_FALLBACK) {
  try {
    const existing = db.select().from(users).where(eq(users.id, 'self')).get()
    if (!existing) {
      db.insert(users).values({
        id: 'self',
        email: 'self@local.closet',
        createdAt: Date.now(),
      }).run()
      console.log('[server] Created legacy admin-fallback user "self"')
    }
  } catch (err) {
    // Silently skip during tests (db mocked as empty object)
    console.warn('[server] Could not check/create "self" user (DB might be mocked):', (err as Error).message)
  }
}

const app = express()
const PORT = parseInt(process.env.PORT ?? process.env.WEB_PORT ?? '3000', 10)
const isDev = process.env.NODE_ENV !== 'production'

// Which proxies may set the client IP (TRUST_PROXY, see trustProxy.ts): one hop
// on Render, only local/private proxies on self-host. express-rate-limit keys
// on req.ip, so a spoofable IP would void every per-IP limit.
app.set('trust proxy', trustProxySetting())


// Cookie parser (for image auth cookie)
app.use(cookieParser())

// Security headers via helmet
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://avatars.githubusercontent.com", "https://github.com",
        // Shop row product images (#324) — mirrors SHOPIFY_CDN_HOST_SUFFIXES in commerce/shopify/cdn.ts.
        "https://*.shopify.com", "https://*.shopifycdn.com", "https://shopifyassets.com", "https://*.shopifyassets.com"],
      connectSrc: ["'self'", "https://raw.githubusercontent.com"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}))

// CORS in dev (Vite runs on :5173)
if (isDev) {
  app.use(cors({
    origin: 'http://localhost:5173',
    credentials: true,
  }))
}

// Stripe webhook needs the raw request body for signature verification, so it
// must be registered BEFORE the global JSON parser. No session auth — Stripe
// authenticates via the signature header.
// #315 — billing is a hosted-only surface; unmounted (404) when self-hosted.
if (isHostedMode()) registerHostedPreJsonRoutes(app)

app.use(express.json())

// Request logging (#165): attachSession resolves req.userId without rejecting
// (so auth/public routes still flow through), then morgan logs every request
// with per-route + per-user attribution. Static asset traffic (/images, /assets)
// is skipped inside requestLogger to keep the volume sane.
app.use(attachSession)
app.use(requestLogger())

// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
})

const assetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
})

// Public — frontend checks this to decide which auth UI to show
app.get('/api/auth/status', (_req, res) => {
  const hosted = isHostedMode()
  res.json({
    hasPassword: Boolean(getPassword()),
    adminFallback: ADMIN_FALLBACK,
    google: isGoogleOAuthConfigured(),
    // #324 — the frontend hides the shop row, ♡ Liked items and "Shop for".
    shopEnabled: isShopEnabled(),
    // #321 — personal API tokens are hidden in HOSTED_MODE until #248 lands.
    tokensEnabled: !hosted,
    // #328 — the Ask tab. Off on vastra.cc until #248 (CHAT_ENABLED=true);
    // on for self-host whenever a text model is usable.
    chatEnabled: isChatEnabled(),
    // #332 — "Find related" sections show only with a decision provider
    // (Jev, a TypeSafe endpoint such as CLM, or DECISIONS_PROVIDER=llm).
    relatedEnabled: isDecisionsConfigured(),
    // #315 — the frontend hides the wallet / balance / insufficient-tokens UI
    // when billing is off (self-host). billing is on iff HOSTED_MODE.
    hostedMode: hosted,
    billing: hosted,
  })
})

// ─── UCP platform profile (#323) — public; 404s unless SHOP_ROW_ENABLED=true ──
app.use('/.well-known/ucp', requireShopEnabled, ucpProfileRouter)

// ─── Google OAuth (#17) — credential-gated; 404s when not configured ──────────
app.get('/api/auth/google/start', authLimiter, googleStart)
app.get('/api/auth/google/callback', authLimiter, googleCallback)

// ─── Magic-link auth (send-link / verify-preview / verify-confirm / signout / me) ─
// Rate-limiting is applied per-route inside authRouter so that read-only paths
// like GET /api/auth/me aren't throttled the same as send-link.
app.use('/api/auth', authRouter)

// ─── Legacy admin-password escape hatch (gated by ADMIN_BEARER_FALLBACK) ──────
// Lets a Render operator sign in with WEB_AUTH_PASSWORD when there's no
// usable user session — without re-introducing the deprecated password flow
// for end-users. Mounted at the exact `/api/auth` path so it doesn't shadow
// any of authRouter's sub-paths.
app.post('/api/auth', authLimiter, (req, res) => {
  if (!ADMIN_FALLBACK) {
    return res.status(404).json({ error: 'Not found' })
  }
  const { password, remember } = req.body as { password?: string; remember?: boolean }
  const expected = process.env.WEB_AUTH_PASSWORD
  if (expected && !safeEqual(password ?? '', expected)) {
    return res.status(401).json({ error: 'Wrong password' })
  }
  const tok = sessionToken(password ?? '')
  // Admin form is session-scoped unless remember is passed; cookie-only (#295).
  res.cookie('closet-auth', tok, cookieOpts(req, remember === true))
  res.json({ ok: true })
})

// Admin-only: rotates the system-wide fallback password (the '__system__' row).
// requireAdmin (after requireSession) blocks normal logged-in users from
// overwriting it when ADMIN_BEARER_FALLBACK is enabled.
app.post('/api/settings/password', authLimiter, requireSession, requireAdmin, (req, res) => {
  const { current, newPassword } = req.body as { current?: string; newPassword?: string }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' })
  }
  const existing = getPassword()
  if (existing) {
    if (!current || current !== existing) {
      return res.status(401).json({ error: 'Current password is incorrect' })
    }
  }
  setSystemSetting('password', newPassword)
  const tok = sessionToken(newPassword)
  res.cookie('closet-auth', tok, cookieOpts(req))
  res.json({ ok: true })
})

// Image serving — per-user storage with legacy fallback
app.use('/images', assetLimiter, requireSession, (req, res) => {
  const userId = req.userId!
  const safe = normalize(req.path).replace(/\\/g, '/')
  if (safe.includes('..')) return res.status(400).send('Invalid path')
  const relativePath = `images/${safe.replace(/^\//, '')}`

  function tryResolve(path: string): string | null {
    const userRel = `users/${userId}/${path}`
    const userAbs = join(DATA_DIR, userRel)
    if (existsSync(userAbs)) return userRel
    if (userId === 'self') {
      const legacyAbs = join(DATA_DIR, path)
      if (existsSync(legacyAbs)) return path
    }
    return null
  }

  // Share snapshots are owned by the sender's tree but readable by any
  // viewer who has the share id (the id is the capability). Resolve against
  // the payload owner if the path is images/share/<payloadId>/...
  function tryResolveShare(path: string): string | null {
    const m = path.match(/^images\/share\/([A-Za-z0-9_-]+)\/(.+)$/)
    if (!m) return null
    const payload = getSharePayload(m[1])
    if (!payload) return null
    if (payload.expiresAt && payload.expiresAt < Date.now()) return null
    const ownerRel = `users/${payload.userId}/${path}`
    return existsSync(join(DATA_DIR, ownerRel)) ? ownerRel : null
  }

  let serveRelativePath = tryResolve(relativePath) ?? tryResolveShare(relativePath)

  // If the requested file doesn't exist and looks like a thumb, fall back to
  // the full-size original (e.g. abc_thumb.jpg → abc.jpg).
  if (!serveRelativePath) {
    const thumbMatch = relativePath.match(/^(.+)_thumb(\.[^.]+)$/)
    if (thumbMatch) {
      const originalPath = thumbMatch[1] + thumbMatch[2]
      serveRelativePath = tryResolve(originalPath) ?? tryResolveShare(originalPath)
    }
  }

  if (!serveRelativePath) {
    const cacheKey = `${userId}:${relativePath}`
    if (!missingLogCache.has(cacheKey)) {
      missingLogCache.add(cacheKey)
      console.log(`[images] 404 missing path: ${userId}/${relativePath}`)
    }
    return res.status(404).send('Not found')
  }

  const resolved = resolve(join(DATA_DIR, serveRelativePath))
  const userImagesRoot = resolve(join(DATA_DIR, 'users', userId, 'images'))
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

// PWA share-target (#134 Phase 1) — top-level, NOT under /api so it isn't
// requireSession-guarded (anonymous OS shares must reach the login+claim path).
// attachSession (line above) populates req.userId for logged-in users; absent it,
// the route mints an anonymous claimable row. Rate-limited inside the router.
app.use('/share-target', shareTargetRouter)

// CSRF protection for cookie-only sessions (#295). The browser no longer
// stores the session token, so mutations authenticate with the httpOnly
// cookie; a cookie alone must not be enough — cross-site forms ride the
// victim's cookie. A mutation passes if ANY of:
//   1. requireSession authenticated the request with a VALID BEARER —
//      non-browser clients (admin scripts, CLI). Cross-site JS cannot set
//      an Authorization header without a CORS preflight, which this server
//      rejects. The mere PRESENCE of the header must NOT bypass CSRF:
//      browsers auto-attach cached HTTP Basic credentials, and such a
//      request authenticates via the cookie — so the check is on
//      req.authVia, not on the header (#295 review item 2).
//   2. Cookie-authenticated AND the custom `X-Requested-With: vastra` header
//      (same preflight logic — cross-site forms and beacons cannot add
//      custom headers) AND, when Origin is present, it matches the request
//      host (browser POSTs always carry Origin).
const CSRF_HEADER = 'x-requested-with'
const CSRF_HEADER_VALUE = 'vastra'

function requireCsrfForMutations(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (req.authVia === 'bearer') return next()

  if (req.headers[CSRF_HEADER] !== CSRF_HEADER_VALUE) {
    res.status(403).json({ error: 'CSRF proof missing' })
    return
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost: URL | null = null
    try { originHost = new URL(origin) } catch { /* malformed Origin */ }
    if (!originHost || originHost.host !== req.get('host')) {
      res.status(403).json({ error: 'Cross-origin request rejected' })
      return
    }
  }
  next()
}

// API routes — session auth (cookie or bearer) + CSRF proof for mutations
// #332 — "Find related" on detail cards. Full paths, so they sit beside the
// entity routers without a shared prefix router. POST uses quota, so it also
// gets a small burst limit; the daily cap lives in related_requests.
const relatedBurst = perUserRateLimit(60_000, 5)
for (const [kind, base] of [['item', '/api/items'], ['outfit', '/api/outfits'], ['collection', '/api/collections']] as const) {
  app.post(`${base}/:id/related`, requireSession, requireCsrfForMutations, relatedBurst, findRelated(kind))
  app.get(`${base}/:id/related`, requireSession, lastRelatedResult(kind))
}
app.get('/api/related/quota', requireSession, relatedQuotaHandler)
app.use('/api/items', requireSession, requireCsrfForMutations, itemsRouter)
app.use('/api/outfits', requireSession, requireCsrfForMutations, outfitsRouter)
app.use('/api/weather', requireSession, weatherRouter)
app.use('/api/user-photos', requireSession, requireCsrfForMutations, userPhotosRouter)
app.use('/api/tryon', requireSession, requireCsrfForMutations, tryonRouter)
app.use('/api/jobs', requireSession, requireCsrfForMutations, jobsRouter)
app.use('/api/settings', requireSession, requireCsrfForMutations, settingsRouter)
app.use('/api/collections', requireSession, requireCsrfForMutations, collectionsRouter)
app.use('/api/tags', requireSession, requireCsrfForMutations, tagsRouter)
app.use('/api/discover', requireSession, requireCsrfForMutations, discoverRouter)
app.use('/api/share', requireSession, requireCsrfForMutations, shareRouter)
app.use('/api/push', requireSession, requireCsrfForMutations, pushRouter)
// #315 — billing + admin metrics are hosted-only surfaces. Unmounted (404)
// when self-hosted so a self-hosted instance exposes no Stripe/wallet/admin
// financial endpoints. The /api 404 catch-all below returns JSON for them.
if (isHostedMode()) registerHostedRoutes(app, { requireSession, requireAdmin, requireCsrfForMutations })
// #289 — admin-only Test connection for the self-hosted model server. Mounted
// in both modes: it only probes the instance's own OPENAI_COMPAT_BASE_URL.
app.use('/api/admin/connectors', requireSession, requireCsrfForMutations, requireAdmin, connectorsRouter)
// #315 — Settings › Instance: the active config, read-only, secrets as set/unset.
app.get('/api/admin/config', requireSession, requireAdmin, (_req, res) => { res.json(describeInstanceConfig()) })
app.use('/api/admin/embeddings', requireSession, requireCsrfForMutations, requireAdmin, adminEmbeddingsRouter)
app.use('/api/account', requireSession, requireCsrfForMutations, accountRouter)
app.use('/api/suggest/occasions', requireSession, requireCsrfForMutations, suggestOccasionsRouter)
app.use('/api/events', requireSession, requireCsrfForMutations, analyticsRouter)
app.use('/api/shop', requireShopEnabled, requireSession, requireCsrfForMutations, shopRouter)

// #321 — Personal API token management (Settings → Connections). Hidden in
// HOSTED_MODE until #248 (Helmet CSP, bearer-only mutations, rate limits)
// lands — a remote MCP endpoint on the public SaaS is a bigger attack surface.
// requireTokensEnabled 404s per request in HOSTED_MODE; the frontend reads
// `tokensEnabled` from /api/auth/status to decide whether to show the UI.
app.use('/api/tokens', requireTokensEnabled, requireSession, requireCsrfForMutations, tokensRouter)
// #328 — in-app chat (Ask tab). The gate, session and CSRF run before the
// router, so a request that fails CSRF never takes the turn lease or counts
// toward a rate limit.
app.use('/api/chat', requireChatEnabled, requireSession, requireCsrfForMutations, chatRouter)

// #317 — MCP server transport (Streamable HTTP at /mcp). Mounted BEFORE
// the /api catch-all and the SPA fallback: /mcp is NOT under /api, so
// without an explicit mount the SPA fallback (prod sendFile index.html,
// dev reverse-proxy to Vite) would shadow it. Auth is bearer-only via
// requireApiToken (#321): no cookie auth, and the mount is behind
// requireTokensEnabled so /mcp 404s in HOSTED_MODE exactly like the
// token routes. Rate-limited per token inside the router.
app.use('/mcp', mcpRouter)

// #315 — unmatched /api/* requests return a JSON 404 instead of falling
// through to the SPA index.html (which would 200 and mask missing routes,
// including the billing/admin surfaces unmounted when self-hosted).
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' })
})

// Upload limits (upload.ts): a rejected multipart body is a 400/413, not a 500.
app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  const upload = uploadErrorResponse(err)
  if (upload) { res.status(upload.status).json(upload.body); return }
  next(err)
})

// Production: serve built SPA
if (!isDev) {
  const distDir = join(__dirname, 'app/dist')
  const noCachePaths = new Set(['/sw.js', '/registerSW.js', '/manifest.webmanifest', '/index.html', '/'])
  app.use((req, res, next) => {
    if (noCachePaths.has(req.path)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Expires', '0')
    }
    next()
  })
  app.use(express.static(distDir, {
    setHeaders(res, path) {
      if (path.endsWith('sw.js') || path.endsWith('registerSW.js') || path.endsWith('manifest.webmanifest')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
      }
    },
  }))
  app.get('/{*path}', assetLimiter, (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.sendFile(join(distDir, 'index.html'))
  })
}

// Dev: tunnels (e.g. a Cloudflare quick tunnel) typically point at port 3000
// where Express runs. The SPA lives on the Vite dev server (5173). Without a
// fallback, hitting an SPA path on Express (e.g. /auth/verify from a magic
// link) returns "Cannot GET". Reverse-proxy non-API/non-images requests to
// Vite so the tunnel side works without re-pointing it at 5173.
if (isDev) {
  const VITE_TARGET = new URL(process.env.VITE_DEV_URL || 'http://localhost:5173')
  app.use(async (req, res, next) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/images') ||
      req.path.startsWith('/share-target')
    ) return next()
    try {
      const { request } = await import('http')
      const proxyReq = request(
        {
          method: req.method,
          hostname: VITE_TARGET.hostname,
          port: VITE_TARGET.port || 80,
          path: req.originalUrl,
          headers: { ...req.headers, host: VITE_TARGET.host },
        },
        proxyRes => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
          proxyRes.pipe(res)
        },
      )
      proxyReq.on('error', err => {
        console.error('[dev-spa-proxy]', (err as Error).message)
        if (!res.headersSent) res.status(502).send('Vite dev server not reachable')
      })
      req.pipe(proxyReq)
    } catch (err) {
      next(err)
    }
  })
}

export { app }

export function assertGcpProjectId(): void {
  // #315 — only the hosted SaaS needs GCP_PROJECT_ID to keep image-embedding
  // (Vertex) off the Developer-API personal-billing fallback. A self-hosted
  // install runs in mock mode without any GCP project, so the guard must not
  // fire when HOSTED_MODE is off.
  if (isHostedMode() && !process.env.GCP_PROJECT_ID) {
    throw new Error('Refusing to start: GCP_PROJECT_ID required in HOSTED_MODE to prevent Developer-API personal-billing fallback.')
  }
}

// Boot-time checks registered by the hosted extras (e.g. #345 unpriced paid models).
export function runBootChecks(): void {
  for (const check of hostedHooks().bootChecks) check()
}

let removeImportLock: (() => void) | null = null

export function installLiveImportLock(): void {
  if (removeImportLock) return
  const liveLockPath = importPaths(DATA_DIR).lockPath
  writeFileSync(liveLockPath, `${process.pid}\n${new Date().toISOString()}\n`)
  removeImportLock = () => rmSync(liveLockPath, { force: true })
  process.once('exit', removeImportLock)
  process.once('SIGINT', () => { removeImportLock?.(); process.exit(130) })
  process.once('SIGTERM', () => { removeImportLock?.(); process.exit(143) })
}

// Only listen when run directly (not imported in tests)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assertGcpProjectId()
  runBootChecks()
  installLiveImportLock()
  // Startup integrity check — non-blocking, don't crash on errors
  try {
    checkImageIntegrity()
  } catch (err) {
    console.warn('[server] integrity check failed:', (err as Error).message)
  }
  try {
    checkTryonIntegrity()
  } catch (err) {
    console.warn('[server] tryon integrity check failed:', (err as Error).message)
  }

  const server = app.listen(PORT, () => {
    console.log(`Closet web server running on http://localhost:${PORT}`)
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Kill the old process first:\n  kill $(lsof -ti :${PORT})`)
    } else {
      console.error('Server error:', err)
    }
    process.exit(1)
  })
}
