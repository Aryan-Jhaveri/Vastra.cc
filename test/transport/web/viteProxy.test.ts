import { describe, it, expect } from 'vitest'
import config from '../../../src/transport/web/app/vite.config'

// The dev tunnel (scripts/dev.ts) points at Vite, so every Express surface a
// remote client needs must be proxied here. /mcp isn't under /api — without
// its own entry the tunnel serves the SPA for /mcp and sandboxed MCP clients
// have no route to the server.
describe('vite dev proxy', () => {
  const proxy = (config as { server?: { proxy?: Record<string, unknown> } }).server?.proxy ?? {}

  it.each(['/api', '/images', '/mcp'])('proxies %s to Express on :3000', (path) => {
    expect(proxy[path]).toMatchObject({ target: 'http://localhost:3000' })
  })

  it.each(['/api', '/images', '/mcp'])('keeps changeOrigin false for %s (CSRF Origin/Host match)', (path) => {
    expect(proxy[path]).toMatchObject({ changeOrigin: false })
  })
})
