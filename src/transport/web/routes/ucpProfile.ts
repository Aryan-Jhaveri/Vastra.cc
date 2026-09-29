import { Router } from 'express'
import { createHash } from 'crypto'
import { buildPlatformProfile, platformSigningKey } from '../../../commerce/ucp/profile.js'

const router = Router()

// GET /.well-known/ucp — public UCP platform profile (#323, #324).
// Serves JSON (not HTML) with Cache-Control + ETag so Shopify's Global Catalog
// accepts it. Served even without UCP_SIGNING_KEY: the Global Catalog does not
// require signatures (#324). Per-store UCP (with signing) is a future path.
router.get('/', (_req, res) => {
  const key = platformSigningKey()
  const profile = buildPlatformProfile(key?.publicJwk)
  const body = JSON.stringify(profile)
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`
  res.set('Cache-Control', 'public, max-age=300')
  res.set('ETag', etag)
  res.type('application/json')
  res.send(body)
})

export default router
