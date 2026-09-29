import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { eq, ne } from 'drizzle-orm'
import { AddressInfo } from 'net'
import { db } from '../../../src/db/client.js'
import { users, apiTokens, items, outfits, aiCalls, settings } from '../../../src/db/schema.js'
import { createApiToken } from '../../../src/db/queries.js'
import { getSettings, updateSettings } from '../../../src/settings.js'

// #315 — the default vitest env is HOSTED_MODE=true, but personal API tokens
// only authenticate when self-hosted (requireApiToken 401s every token in
// HOSTED_MODE). This file exercises token auth on /mcp, so opt out by
// default; the HOSTED_MODE-gating test toggles the flag explicitly.
delete process.env.HOSTED_MODE

const { createMcpRouter } = await import('../../../src/transport/mcp/server.js')

function createUser(email: string): string {
  const id = `m-${email.replace(/[^a-z0-9]/g, '')}`
  const existing = db.select().from(users).where(eq(users.id, id)).get()
  if (!existing) {
    db.insert(users).values({ id, email: email.toLowerCase(), createdAt: Date.now() }).run()
  }
  return id
}

function seedItem(userId: string, id: string, category = 'tops', brand?: string): string {
  const now = Date.now()
  db.insert(items).values({
    id, userId, imageUri: `images/items/${id}.jpg`, category, brand: brand ?? null,
    createdAt: now, updatedAt: now,
  }).run()
  return id
}

function setServerLocation(userId: string, lat: number, lon: number, name: string): void {
  db.insert(settings).values({
    key: 'serverLocation', userId,
    value: JSON.stringify({ enabled: true, lat, lon, name }),
  })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value: JSON.stringify({ enabled: true, lat, lon, name }) } })
    .run()
}

function resetTables(): void {
  db.delete(aiCalls).run()
  db.delete(outfits).run()
  db.delete(items).run()
  db.delete(apiTokens).run()
  db.delete(settings).where(eq(settings.key, 'serverLocation')).run()
  db.delete(settings).where(eq(settings.key, 'userSizes')).run()
  db.delete(settings).where(eq(settings.key, 'sizesAgentContext')).run()
  db.delete(users).where(ne(users.id, 'self')).run()
}

// Mini app that mounts only the /mcp router (mirrors server.ts mount, minus
// the global express.json() which we add here). Token auth + rate limit run
// inside the router.
function makeApp(rateLimitMax?: number, aiRateLimitMax?: number): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/mcp', createMcpRouter({
    ...(rateLimitMax != null ? { rateLimitMax } : {}),
    ...(aiRateLimitMax != null ? { aiRateLimitMax } : {}),
  }))
  return app
}

// A single JSON-RPC request over POST /mcp with a bearer token. The MCP
// Streamable HTTP transport requires `Accept: application/json, text/event-stream`.
function mcpCall(app: express.Express, plaintext: string, payload: object) {
  return request(app).post('/mcp')
    .set('Authorization', `Bearer ${plaintext}`)
    .set('Accept', 'application/json, text/event-stream')
    .send(payload)
}

// ─── Auth gating: 401 before any MCP parsing ──────────────────────────────────

describe('MCP /mcp — auth gating (before any MCP parsing)', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })

  it('no Authorization header → 401 (not a JSON-RPC response)', async () => {
    const res = await request(makeApp()).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    // The response is the auth middleware's, not an MCP JSON-RPC message.
    expect(res.body.jsonrpc).toBeUndefined()
  })

  it('an invalid token → 401 (same body as no token, before MCP parsing)', async () => {
    const res = await mcpCall(makeApp(), 'vst_nope_nope_nope_nope_nope', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('a closet-auth cookie is ignored (bearer-only, 401)', async () => {
    const userId = createUser('cookie-mcp@test.com')
    const { plaintext } = await createApiToken(userId, 't', ['read'])
    const res = await request(makeApp())
      .post('/mcp')
      .set('Cookie', `closet-auth=${plaintext}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(res.status).toBe(401)
  })
})

// ─── HOSTED_MODE gating: /mcp 404s (JSON, before SPA fallback) ─────────────────

describe('MCP /mcp — HOSTED_MODE gating', () => {
  const original = process.env.HOSTED_MODE
  afterEach(() => {
    if (original === undefined) delete process.env.HOSTED_MODE
    else process.env.HOSTED_MODE = original
  })

  it('GET /mcp → JSON 404 in HOSTED_MODE', async () => {
    process.env.HOSTED_MODE = 'true'
    const res = await request(makeApp()).get('/mcp')
    expect(res.status).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.body).toEqual({ error: 'Not found' })
  })

  it('POST /mcp → JSON 404 in HOSTED_MODE (even with a token)', async () => {
    process.env.HOSTED_MODE = 'true'
    const res = await request(makeApp())
      .post('/mcp')
      .set('Authorization', 'Bearer vst_whatever')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Not found' })
  })
})

// ─── tools/list scope filtering ───────────────────────────────────────────────

const READ_TOOL_NAMES = [
  'search_closet', 'get_item', 'list_outfits', 'get_outfit', 'list_collections', 'get_collection',
  'get_weather', 'get_forecast', 'get_my_sizes',
  'find_related', 'discover_closet', 'list_my_photos',
]
const AI_TOOL_NAMES = ['suggest_outfit', 'try_on']
const WRITE_TOOL_NAMES = [
  'create_outfit', 'update_outfit', 'create_collection', 'add_outfits_to_collection',
  'remove_outfits_from_collection', 'update_collection',
]

async function listTools(plaintext: string) {
  const res = await mcpCall(makeApp(), plaintext, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  expect(res.status).toBe(200)
  expect(res.body.jsonrpc).toBe('2.0')
  return (res.body.result.tools as Array<{ name: string }>).map(t => t.name)
}

describe('MCP /mcp — tools/list scope filtering', () => {
  beforeEach(() => {
    resetTables(); vi.clearAllMocks()
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test')
    vi.stubEnv('DECISIONS_PROVIDER', '')
    vi.stubEnv('OPENROUTER_DISABLED', '')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('still lists find_related without a decision provider (keyword fallback)', async () => {
    vi.stubEnv('OPENROUTER_API_KEY', '')
    const userId = createUser('nodec@test.com')
    const { plaintext } = await createApiToken(userId, 'nodec', ['read'])
    const names = await listTools(plaintext)
    expect(names).toContain('find_related')
    expect(names).toContain('discover_closet')
  })

  it('marks try_on as not read-only (it saves Try On history)', async () => {
    const userId = createUser('ann@test.com')
    const { plaintext } = await createApiToken(userId, 'ann', ['read', 'ai'])
    const res = await mcpCall(makeApp(), plaintext, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const tools = res.body.result.tools as Array<{ name: string; annotations: { readOnlyHint?: boolean } }>
    expect(tools.find(t => t.name === 'try_on')!.annotations.readOnlyHint).toBe(false)
    expect(tools.find(t => t.name === 'suggest_outfit')!.annotations.readOnlyHint).toBe(true)
  })

  it('a read-only token sees exactly the read-scope tools', async () => {
    const userId = createUser('ro@test.com')
    const { plaintext } = await createApiToken(userId, 'ro', ['read'])
    const names = await listTools(plaintext)
    expect(names.sort()).toEqual(READ_TOOL_NAMES.slice().sort())
    // No write or ai tools.
    for (const w of WRITE_TOOL_NAMES) expect(names).not.toContain(w)
    expect(names).not.toContain('suggest_outfit')
  })

  it('a read+write token also sees the outfit and collection write tools (#338)', async () => {
    const userId = createUser('rw@test.com')
    const { plaintext } = await createApiToken(userId, 'rw', ['read', 'write'])
    const names = await listTools(plaintext)
    expect(names.sort()).toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort())
    expect(names).not.toContain('suggest_outfit')
  })

  it('a read+ai token also sees suggest_outfit', async () => {
    const userId = createUser('rai@test.com')
    const { plaintext } = await createApiToken(userId, 'rai', ['read', 'ai'])
    const names = await listTools(plaintext)
    expect(names).toContain('suggest_outfit')
    expect(names).not.toContain('create_outfit')
    expect(names.sort()).toEqual([...READ_TOOL_NAMES, ...AI_TOOL_NAMES].sort())
  })

  it('a read+write+ai token sees every tool', async () => {
    const userId = createUser('rwa@test.com')
    const { plaintext } = await createApiToken(userId, 'rwa', ['read', 'write', 'ai'])
    const names = await listTools(plaintext)
    expect(names.sort()).toEqual([...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES, ...AI_TOOL_NAMES].sort())
    expect(names).toContain('suggest_outfit')
    expect(names).toContain('create_outfit')
  })

  it('tools/list inputSchema exposes the optional location fields (#333)', async () => {
    const userId = createUser('loc@test.com')
    const { plaintext } = await createApiToken(userId, 'loc', ['read', 'ai'])
    const res = await mcpCall(makeApp(), plaintext, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    expect(res.status).toBe(200)
    const tools = res.body.result.tools as Array<{ name: string; inputSchema: Record<string, unknown> }>
    const weather = tools.find(t => t.name === 'get_weather')
    expect(weather).toBeDefined()
    const props = weather!.inputSchema.properties as Record<string, unknown>
    expect(props).toHaveProperty('location')
    expect(props).toHaveProperty('lat')
    expect(props).toHaveProperty('lon')
    // None of the location fields are required — all three are optional.
    const required = (weather!.inputSchema.required as string[] | undefined) ?? []
    for (const f of ['location', 'lat', 'lon']) {
      expect(required).not.toContain(f)
    }
    // No userId/user_id/email leaked in the schema.
    const flat = JSON.stringify(weather!.inputSchema).toLowerCase()
    expect(flat).not.toContain('user_id')
    expect(flat).not.toContain('userid')
    expect(flat).not.toContain('"email"')

    const suggest = tools.find(t => t.name === 'suggest_outfit')
    const sProps = suggest!.inputSchema.properties as Record<string, unknown>
    expect(sProps).toHaveProperty('location')
    expect(sProps).toHaveProperty('lat')
    expect(sProps).toHaveProperty('lon')
    expect(sProps).toHaveProperty('occasion')
  })
})

// ─── tools/call scope enforcement (rejected, not just hidden) ─────────────────

describe('MCP /mcp — tools/call scope enforcement (rejected, not just hidden)', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })

  it('a read-only token calling suggest_outfit (ai) → JSON-RPC MethodNotFound', async () => {
    const userId = createUser('scope-call-ai@test.com')
    const { plaintext } = await createApiToken(userId, 'ro', ['read'])
    const res = await mcpCall(makeApp(), plaintext, {
      jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'suggest_outfit', arguments: {} },
    })
    // The tool is REJECTED on call, not just hidden from tools/list.
    expect(res.body.error).toBeDefined()
    expect(res.body.error.code).toBe(-32601) // MethodNotFound
    expect(res.body.error.message).toMatch(/suggest_outfit/)
    expect(res.body.id).toBe(7)
  })

  it('a read-only token calling create_outfit (write) → MethodNotFound', async () => {
    const userId = createUser('scope-call-w@test.com')
    const { plaintext } = await createApiToken(userId, 'ro', ['read'])
    const res = await mcpCall(makeApp(), plaintext, {
      jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'create_outfit', arguments: { name: 'X', item_ids: ['x'] } },
    })
    expect(res.body.error.code).toBe(-32601)
    expect(res.body.error.message).toMatch(/create_outfit/)
  })

  it('no token can call set_my_size (removed — agents never write sizes); get_my_sizes is per-user', async () => {
    const userId = createUser('size-rw@test.com')
    const otherId = createUser('size-other@test.com')
    const { plaintext } = await createApiToken(userId, 'rwa', ['read', 'write', 'ai'])
    const { plaintext: otherToken } = await createApiToken(otherId, 'ro', ['read'])
    const set = await mcpCall(makeApp(), plaintext, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'set_my_size', arguments: { category: 'outerwear', size: 'L' } },
    })
    expect(set.body.error.code).toBe(-32601)
    expect(getSettings(userId).userSizes).toBeUndefined()

    updateSettings({ userSizes: { outerwear: 'L' } }, userId)
    const mine = await mcpCall(makeApp(), plaintext, {
      jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'get_my_sizes', arguments: {} },
    })
    expect(JSON.parse(mine.body.result.content[0].text)).toEqual({ sizes: { outerwear: 'L' }, editAt: '/settings/sizes' })
    const theirs = await mcpCall(makeApp(), otherToken, {
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'get_my_sizes', arguments: {} },
    })
    expect(JSON.parse(theirs.body.result.content[0].text)).toEqual({ sizes: {}, editAt: '/settings/sizes' })
  })
})

// ─── Cross-user isolation: token A can't read user B's items ──────────────────

describe('MCP /mcp — cross-user isolation', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })

  it('search_closet over /mcp returns only the token owner\'s items', async () => {
    const alice = createUser('alice@test.com')
    const bob = createUser('bob@test.com')
    seedItem(alice, 'alice_item_1', 'tops', 'Nike')
    seedItem(alice, 'alice_item_2', 'bottoms')
    seedItem(bob, 'bob_secret_item', 'tops', 'Gucci')
    const { plaintext: aliceToken } = await createApiToken(alice, 'alice-ro', ['read'])

    const res = await mcpCall(makeApp(), aliceToken, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'search_closet', arguments: {} },
    })
    expect(res.status).toBe(200)
    expect(res.body.result).toBeDefined()
    const text = res.body.result.content[0].text as string
    const parsed = JSON.parse(text) as { results: Array<{ id: string }> }
    const ids = parsed.results.map(r => r.id)
    expect(ids).toContain('alice_item_1')
    expect(ids).toContain('alice_item_2')
    // Token A (alice) cannot read user B's (bob's) items.
    expect(ids).not.toContain('bob_secret_item')
  })

  it('get_item over /mcp returns "not found" for another user\'s item (no leak)', async () => {
    const alice = createUser('alice2@test.com')
    const bob = createUser('bob2@test.com')
    seedItem(bob, 'bob_private_item', 'tops')
    const { plaintext: aliceToken } = await createApiToken(alice, 'alice-ro2', ['read'])

    const res = await mcpCall(makeApp(), aliceToken, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'get_item', arguments: { id: 'bob_private_item' } },
    })
    expect(res.status).toBe(200)
    expect(res.body.result.isError).toBe(true)
    expect(res.body.result.content[0].text).toMatch(/not found/)
  })
})

// ─── ai tool writes ai_calls with tool_call_id ───────────────────────────────

describe('MCP /mcp — ai tool writes ai_calls with tool_call_id', () => {
  beforeEach(() => {
    resetTables()
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('a suggest_outfit call records an ai_calls row carrying the request id', async () => {
    // Mock the Gemini compose fallback path so suggest_outfit succeeds
    // without real keys / network (mirrors test/agent/tools.test.ts). Jev
    // path is short-circuited by mocking listOutfits → [] (no outfits to
    // rank), so runInstrumented (Gemini compose) is the only ai_calls row.
    vi.doMock('../../../src/tools/weather.js', () => ({
      getCurrentWeather: vi.fn().mockResolvedValue({
        temperature: 12, condition: 'Cloudy', precipitation: 0, windSpeed: 8,
      }),
    }))
    vi.doMock('../../../src/ai/client.js', () => ({
      generateJSONWithUsage: vi.fn().mockResolvedValue({
        data: [{ item_ids: ['s1', 's2'], name: 'Suggested', occasion: 'casual', reasoning: 'ok' }],
        usage: { tokensIn: 200, tokensOut: 100 },
      }),
      VISION_MODEL: 'gemini-2.5-flash',
      TEXT_MODEL: 'gemini-2.5-flash',
      IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
      providerForModel: () => 'gemini',
    }))
    vi.doMock('../../../src/tools/outfits.js', () => ({
      listOutfits: vi.fn().mockResolvedValue([]),
      createOutfit: vi.fn(),
      getOutfit: vi.fn(),
      getOutfitWithItems: vi.fn(),
      deleteOutfit: vi.fn(),
      updateOutfit: vi.fn(),
      markOutfitWorn: vi.fn(),
      OutfitItemOwnershipError: class extends Error {},
    }))

    const userId = createUser('ai@test.com')
    seedItem(userId, 's1')
    seedItem(userId, 's2')
    setServerLocation(userId, 40.7, -74.0, 'NYC')
    const { plaintext } = await createApiToken(userId, 'ai', ['read', 'ai'])

    // Re-import the router AFTER the mocks are registered so the dynamic
    // imports inside the suggest handler pick them up.
    const { createMcpRouter: createMcpRouterMocked } = await import('../../../src/transport/mcp/server.js')
    const app = express()
    app.use(express.json())
    app.use('/mcp', createMcpRouterMocked())

    const res = await request(app)
      .post('/mcp')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0', id: 'call-ai-1', method: 'tools/call',
        params: { name: 'suggest_outfit', arguments: { occasion: 'work' } },
      })
    expect(res.status).toBe(200)
    expect(res.body.result.isError).toBeFalsy()
    const parsed = JSON.parse(res.body.result.content[0].text) as { suggestions: Array<{ name: string }> }
    expect(parsed.suggestions.length).toBeGreaterThanOrEqual(1)

    // The ai_calls row carries tool_call_id = the JSON-RPC request id.
    const calls = db.select().from(aiCalls).where(eq(aiCalls.userId, userId)).all()
    const suggestCall = calls.find(c => c.task === 'suggest' && c.success === 1)
    expect(suggestCall).toBeDefined()
    expect(suggestCall!.toolCallId).toBe('call-ai-1')
  })
})

// ─── Protocol smoke test with the SDK client against a listening server ──────

describe('MCP /mcp — protocol smoke (SDK client)', () => {
  beforeEach(() => { resetTables(); vi.clearAllMocks() })

  it('a real SDK client lists tools and calls search_closet end-to-end', async () => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const { ListToolsResultSchema, CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js')

    const userId = createUser('smoke@test.com')
    seedItem(userId, 'smoke_item', 'tops', 'Nike')
    const { plaintext } = await createApiToken(userId, 'smoke', ['read'])

    const app = makeApp()
    // IPv4 loopback explicitly: see the supertest note in test/setup.ts (#308).
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const url = new URL(`http://127.0.0.1:${port}/mcp`)
    try {
      const client = new Client({ name: 'smoke-client', version: '1.0.0' }, { capabilities: {} })
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${plaintext}` } },
      })
      await client.connect(transport)

      // Clients get told ids are handles for chaining calls, never for users.
      expect(client.getInstructions()).toMatch(/never show them to the user/)
      expect(client.getInstructions()).toMatch(/cannot search by id/)

      const toolsResult = await client.request({ method: 'tools/list', params: {} }, ListToolsResultSchema)
      const names = toolsResult.tools.map(t => t.name)
      expect(names).toContain('search_closet')
      expect(names).not.toContain('suggest_outfit') // read-only token

      const callResult = await client.request(
        { method: 'tools/call', params: { name: 'search_closet', arguments: {} } },
        CallToolResultSchema,
      )
      expect(callResult.isError).toBeFalsy()
      const parsed = JSON.parse(callResult.content[0]!.text) as { results: Array<{ id: string; brand: string | null }> }
      expect(parsed.results.map(r => r.id)).toContain('smoke_item')

      await client.close()
      await transport.close()
    } finally {
      server.close()
    }
  })
})

// ─── Rate limiting on /mcp ────────────────────────────────────────────────────

describe('MCP /mcp — rate limiting', () => {
  const originalVitest = process.env.VITEST
  beforeEach(() => {
    resetTables()
    vi.clearAllMocks()
    // perTokenRateLimit skips under VITEST; opt back in so the limiter fires.
    delete process.env.VITEST
  })
  afterEach(() => {
    if (originalVitest === undefined) delete process.env.VITEST
    else process.env.VITEST = originalVitest
  })

  it('returns 429 after the per-token budget is exhausted', async () => {
    const userId = createUser('rl@test.com')
    const { plaintext } = await createApiToken(userId, 'rl', ['read'])
    // Tight limiter: 3 req/min per token.
    const app = makeApp(3)
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
    // First 3 pass the limiter and reach the MCP handler (200-ish).
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post('/mcp')
        .set('Authorization', `Bearer ${plaintext}`)
        .set('Accept', 'application/json, text/event-stream')
        .send(init)
      expect(res.status).toBe(200)
    }
    // 4th is throttled before the MCP handler.
    const res = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${plaintext}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(init)
    expect(res.status).toBe(429)
    expect(res.body.error).toBe('rate_limited')
  })

  it('ai-scope tool calls have their own stricter budget; read calls are unaffected', async () => {
    const userId = createUser('rlai@test.com')
    const { plaintext } = await createApiToken(userId, 'rlai', ['read', 'ai'])
    // General budget 10/min, ai budget 2/min.
    const app = makeApp(10, 2)
    // suggest_outfit with no saved location returns an isError result (200),
    // which still counts toward the ai budget — no model call is needed here.
    const suggest = (id: number) => mcpCall(app, plaintext, {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'suggest_outfit', arguments: {} },
    })
    expect((await suggest(1)).status).toBe(200)
    expect((await suggest(2)).status).toBe(200)
    const third = await suggest(3)
    expect(third.status).toBe(429)
    expect(third.body.error).toBe('rate_limited')
    // Read tools still go through: they only count toward the general budget.
    const read = await mcpCall(app, plaintext, {
      jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_closet', arguments: {} },
    })
    expect(read.status).toBe(200)
    expect(read.body.result.isError).toBeFalsy()
  })
})
