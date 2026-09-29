import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import sharp from 'sharp'
import * as z4 from 'zod'

const TEST_DIR = '/tmp/closet-agent-test'
const U = 'self'
const OTHER = 'user_other'

async function makeTempJpeg(): Promise<string> {
  mkdirSync(TEST_DIR, { recursive: true })
  const path = join(TEST_DIR, `agent_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`)
  await sharp({
    create: { width: 80, height: 80, channels: 3, background: { r: 80, g: 120, b: 200 } },
  }).jpeg().toFile(path)
  return path
}

import { db } from '../../src/db/client.js'
import { items, outfits, users, aiCalls, settings, collections, collectionOutfits } from '../../src/db/schema.js'
import { eq } from 'drizzle-orm'

const __dirname = dirname(fileURLToPath(import.meta.url))

beforeAll(() => {
  for (const sub of ['items', 'tags', 'tryon', 'user', 'outfits']) {
    mkdirSync(join(TEST_DIR, 'images', sub), { recursive: true })
  }
  migrate(db, { migrationsFolder: join(__dirname, '../../src/db/migrations') })

  // Ensure both test users exist (setup.ts seeds 'self'; create 'user_other').
  for (const id of [U, OTHER]) {
    const existing = db.select().from(users).where(eq(users.id, id)).get()
    if (!existing) {
      db.insert(users).values({ id, email: `${id}@local.closet`, createdAt: Date.now() }).run()
    }
  }
})

beforeEach(() => {
  db.delete(aiCalls).run()
  db.delete(collectionOutfits).run()
  db.delete(collections).run()
  db.delete(outfits).run()
  db.delete(items).run()
  db.delete(settings).where(eq(settings.key, 'serverLocation')).run()
  db.delete(settings).where(eq(settings.key, 'userSizes')).run()
  db.delete(settings).where(eq(settings.key, 'sizesAgentContext')).run()
})

function seedItem(userId: string, id: string, category = 'tops') {
  const now = Date.now()
  db.insert(items).values({
    id, userId, imageUri: `images/items/${id}.jpg`, category,
    createdAt: now, updatedAt: now,
  }).run()
  return id
}

function setServerLocation(userId: string, lat: number, lon: number, name: string) {
  db.insert(settings).values({
    key: 'serverLocation', userId,
    value: JSON.stringify({ enabled: true, lat, lon, name }),
  })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value: JSON.stringify({ enabled: true, lat, lon, name }) } })
    .run()
}

// ─── Registry / schema tests (no DB needed) ────────────────────────────────────

describe('agent tool registry — schema integrity', () => {
  it('every tool has a unique snake_case name', async () => {
    const { AGENT_TOOLS } = await import('../../src/agent/tools.js')
    const names = AGENT_TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('every tool has name, description, input (zod), scope, and handler', async () => {
    const { AGENT_TOOLS } = await import('../../src/agent/tools.js')
    for (const tool of AGENT_TOOLS) {
      expect(typeof tool.name).toBe('string')
      expect(tool.name.length).toBeGreaterThan(0)
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(10)
      expect(tool.input).toBeDefined()
      expect(['read', 'write', 'ai']).toContain(tool.scope)
      expect(typeof tool.handler).toBe('function')
    }
  })

  it('every zod schema converts to valid JSON Schema', async () => {
    const { AGENT_TOOLS } = await import('../../src/agent/tools.js')
    for (const tool of AGENT_TOOLS) {
      const schema = z4.toJSONSchema(tool.input as z4.ZodType)
      expect(schema.type).toBe('object')
      expect(typeof schema).toBe('object')
      // Should not carry the $schema draft annotation (MCP/ModelTool expect bare schema).
      const { $schema, ...rest } = schema as Record<string, unknown>
      expect(Object.keys(rest).length).toBeGreaterThan(0)
    }
  })

  it('no tool schema contains userId / user_id / email properties', async () => {
    const { AGENT_TOOLS, inputToJsonSchema } = await import('../../src/agent/tools.js')
    for (const tool of AGENT_TOOLS) {
      const jsonSchema = inputToJsonSchema(tool)
      const flat = JSON.stringify(jsonSchema).toLowerCase()
      expect(flat).not.toContain('user_id')
      expect(flat).not.toContain('userid')
      expect(flat).not.toContain('"email"')
    }
  })

  it('toModelTool produces a ModelTool-compatible shape', async () => {
    const { AGENT_TOOLS, toModelTool } = await import('../../src/agent/tools.js')
    const tool = AGENT_TOOLS[0]
    const mt = toModelTool(tool)
    expect(mt.name).toBe(tool.name)
    expect(typeof mt.description).toBe('string')
    expect(mt.parameters.type).toBe('object')
  })

  it('getTool returns the tool by name, undefined for unknown', async () => {
    const { getTool, AGENT_TOOLS } = await import('../../src/agent/tools.js')
    expect(getTool(AGENT_TOOLS[0].name)).toBeDefined()
    expect(getTool('nonexistent_tool')).toBeUndefined()
  })

  it('executeTool throws on unknown tool', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    await expect(executeTool('nope', {}, { userId: U, identity: {} }))
      .rejects.toThrow(/Unknown tool/)
  })

  it('executeTool throws on invalid input', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    // get_item requires { id: string }
    await expect(executeTool('get_item', {}, { userId: U, identity: {} }))
      .rejects.toThrow(/Invalid input/)
  })
})

// ─── Tenant isolation tests (needs DB) ─────────────────────────────────────────

describe('agent tools — tenant isolation', () => {
  it('get_item returns "not found" for another user\'s item, not the item', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const itemId = seedItem(OTHER, 'other_item')
    await expect(
      executeTool('get_item', { id: itemId }, { userId: U, identity: {} }),
    ).rejects.toThrow(/not found/)
  })

  it('search_closet only returns the caller\'s items', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    seedItem(U, 'my_item')
    seedItem(OTHER, 'other_item')
    const result = await executeTool('search_closet', {}, { userId: U, identity: {} }) as {
      results: { id: string }[]
    }
    const ids = result.results.map(r => r.id)
    expect(ids).toContain('my_item')
    expect(ids).not.toContain('other_item')
  })

  it('get_outfit returns "not found" for another user\'s outfit', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createOutfit } = await import('../../src/tools/outfits.js')
    const otherItem = seedItem(OTHER, 'other_outfit_item')
    const outfit = await createOutfit({ name: 'Other', itemIds: [otherItem] }, OTHER)
    await expect(
      executeTool('get_outfit', { id: outfit.id }, { userId: U, identity: {} }),
    ).rejects.toThrow(/not found/)
  })

  it('create_outfit rejects another user\'s item ids', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const foreignId = seedItem(OTHER, 'foreign_for_outfit')
    await expect(
      executeTool('create_outfit',
        { name: 'Steal', item_ids: [foreignId] },
        { userId: U, identity: {} },
      ),
    ).rejects.toThrow(/Item foreign_for_outfit not found/)
  })

  it('list_outfits only returns the caller\'s outfits', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createOutfit } = await import('../../src/tools/outfits.js')
    const myItem = seedItem(U, 'my_outfit_item')
    const otherItem = seedItem(OTHER, 'other_outfit_item_2')
    await createOutfit({ name: 'Mine', itemIds: [myItem] }, U)
    await createOutfit({ name: 'Theirs', itemIds: [otherItem] }, OTHER)
    const result = await executeTool('list_outfits', {}, { userId: U, identity: {} }) as {
      results: { name: string }[]
    }
    const names = result.results.map(r => r.name)
    expect(names).toContain('Mine')
    expect(names).not.toContain('Theirs')
  })

  it('list_collections only returns the caller\'s collections', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createCollection } = await import('../../src/tools/collections.js')
    await createCollection({ name: 'My Coll' }, U)
    await createCollection({ name: 'Their Coll' }, OTHER)
    const result = await executeTool('list_collections', {}, { userId: U, identity: {} }) as {
      results: { name: string }[]
    }
    const names = result.results.map(r => r.name)
    expect(names).toContain('My Coll')
    expect(names).not.toContain('Their Coll')
  })
})

// ─── Read tool behaviour ───────────────────────────────────────────────────────

describe('agent tools — read tools', () => {
  it('search_closet with query matches brand', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { addItem } = await import('../../src/tools/items.js')
    const src = await makeTempJpeg()
    await addItem({ imagePath: src, category: 'tops', brand: 'Nike' }, U)
    const result = await executeTool('search_closet', { query: 'Nike' }, { userId: U, identity: {} }) as {
      results: { brand: string | null }[]
    }
    expect(result.results.length).toBeGreaterThanOrEqual(1)
    expect(result.results[0].brand).toBe('Nike')
  })

  it('search_closet caps results at 25 and reports truncation', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    // Seed 30 items
    for (let i = 0; i < 30; i++) {
      seedItem(U, `cap_${i}`)
    }
    const result = await executeTool('search_closet', {}, { userId: U, identity: {} }) as {
      results: unknown[]; truncated: boolean; total: number
    }
    expect(result.results.length).toBe(25)
    expect(result.truncated).toBe(true)
    expect(result.total).toBe(30)
  })

  it('get_item returns full item details', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const id = seedItem(U, 'detail_item', 'bottoms')
    const result = await executeTool('get_item', { id }, { userId: U, identity: {} }) as {
      id: string; category: string; imageUri: string
    }
    expect(result.id).toBe(id)
    expect(result.category).toBe('bottoms')
    expect(result.imageUri).toMatch(/^images\//)
  })

  it('get_weather throws when no location is provided and none is saved', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    await expect(
      executeTool('get_weather', {}, { userId: U, identity: {} }),
    ).rejects.toThrow(/No location provided/)
  })
})

// ─── Write tool behaviour ──────────────────────────────────────────────────────

describe('agent tools — write tools', () => {
  it('create_outfit creates an outfit from the caller\'s items', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const id1 = seedItem(U, 'create_a')
    const id2 = seedItem(U, 'create_b')
    const result = await executeTool('create_outfit',
      { name: 'Test Outfit', item_ids: [id1, id2], occasion: 'casual' },
      { userId: U, identity: {} },
    ) as { id: string; name: string }
    expect(result.id).toBeDefined()
    expect(result.name).toBe('Test Outfit')
  })
})

// ─── Identity never reaches the model ──────────────────────────────────────────

function containsKeyDeep(value: unknown, keys: Set<string>): boolean {
  if (Array.isArray(value)) return value.some(v => containsKeyDeep(v, keys))
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => keys.has(k) || containsKeyDeep(v, keys))
  }
  return false
}

describe('agent tools — identity guard', () => {
  const IDENTITY_KEYS = new Set(['userId', 'user_id', 'email'])

  it('no read/write tool result contains userId / user_id / email', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const ctx = { userId: U, identity: {} }
    const a = seedItem(U, 'leak_a')
    const b = seedItem(U, 'leak_b')
    const created = await executeTool('create_outfit', { name: 'Leak', item_ids: [a, b] }, ctx) as { id: string }

    const results = [
      created,
      await executeTool('get_item', { id: a }, ctx),
      await executeTool('get_outfit', { id: created.id }, ctx),
      await executeTool('search_closet', {}, ctx),
      await executeTool('search_closet', { brand: 'x' }, ctx),
      await executeTool('list_outfits', {}, ctx),
      await executeTool('list_collections', {}, ctx),
    ]
    for (const r of results) expect(containsKeyDeep(r, IDENTITY_KEYS)).toBe(false)
  })

  it('get_outfit hydrates items through the same projection', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const ctx = { userId: U, identity: {} }
    const a = seedItem(U, 'hyd_a')
    const b = seedItem(U, 'hyd_b')
    const created = await executeTool('create_outfit', { name: 'Hyd', item_ids: [a, b] }, ctx) as { id: string }
    const result = await executeTool('get_outfit', { id: created.id }, ctx) as {
      itemIds: string[]; items: { id: string }[]
    }
    expect(result.itemIds).toEqual([a, b])
    expect(result.items.map(i => i.id).sort()).toEqual([a, b])
  })

  it.each(['', '   '])('executeTool rejects an empty ctx.userId (%j) before dispatch', async (userId) => {
    const { executeTool } = await import('../../src/agent/tools.js')
    setServerLocation(U, 43.65, -79.38, 'Toronto')
    await expect(executeTool('get_weather', {}, { userId, identity: {} }))
      .rejects.toThrow(/userId is required/)
  })
})

// ─── Sizes tools (#329) ────────────────────────────────────────────────────────

describe('agent tools — sizes (#329)', () => {
  it('get_my_sizes is read scope, and no agent tool can write sizes', async () => {
    const { getTool, AGENT_TOOLS } = await import('../../src/agent/tools.js')
    expect(getTool('get_my_sizes')?.scope).toBe('read')
    expect(getTool('set_my_size')).toBeUndefined()
    const writes = AGENT_TOOLS.filter(t => t.scope === 'write').map(t => t.name)
    expect(writes).toContain('create_outfit')
    expect(writes.some(n => /size/.test(n))).toBe(false)
  })

  it('get_my_sizes returns { sizes } when the toggle is on by default', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { updateSettings } = await import('../../src/settings.js')
    updateSettings({ userSizes: { tops: 'M', bottoms: '32 × 30' } }, U)
    const result = await executeTool('get_my_sizes', {}, { userId: U, identity: {} })
    expect(result).toEqual({ sizes: { tops: 'M', bottoms: '32 × 30' }, editAt: '/settings/sizes' })
  })

  it('get_my_sizes returns { sizes: {} } when none are set', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    expect(await executeTool('get_my_sizes', {}, { userId: U, identity: {} })).toEqual({ sizes: {}, editAt: '/settings/sizes' })
  })

  it('get_my_sizes returns { disabled: true } (and no sizes) when sizesAgentContext is off', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { updateSettings } = await import('../../src/settings.js')
    updateSettings({ userSizes: { tops: 'M' }, sizesAgentContext: false }, U)
    const result = await executeTool('get_my_sizes', {}, { userId: U, identity: {} })
    expect(result).toEqual({ disabled: true, editAt: '/settings/sizes' })
    expect(JSON.stringify(result)).not.toContain('"M"')
  })

  it('get_my_sizes never returns another user\'s sizes', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { updateSettings } = await import('../../src/settings.js')
    updateSettings({ userSizes: { shoes: 'US 11' } }, OTHER)
    expect(await executeTool('get_my_sizes', {}, { userId: U, identity: {} })).toEqual({ sizes: {}, editAt: '/settings/sizes' })
  })

  it('search_closet includes each item\'s size on every path (cards, query, brand)', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const now = Date.now()
    db.insert(items).values({
      id: 'sized_item', userId: U, imageUri: 'images/items/sized_item.jpg', category: 'tops',
      brand: 'Uniqlo', size: 'M', aiDescription: 'oxford shirt', createdAt: now, updatedAt: now,
    }).run()
    const ctx = { userId: U, identity: {} }
    for (const input of [{}, { query: 'oxford' }, { brand: 'Uniqlo' }]) {
      const result = await executeTool('search_closet', input, ctx) as { results: { id: string; size: string | null }[] }
      const row = result.results.find(r => r.id === 'sized_item')
      expect(row, JSON.stringify(input)).toBeDefined()
      expect(row!.size).toBe('M')
    }
  })

  it('search_closet `size` filter matches case/space-insensitively and skips unsized items', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const now = Date.now()
    const row = (id: string, size: string | null, brand: string | null = null) => ({
      id, userId: U, imageUri: `images/items/${id}.jpg`, category: 'bottoms', brand, size,
      aiDescription: 'trousers', createdAt: now, updatedAt: now,
    })
    db.insert(items).values([
      row('sz_a', '32 × 30', 'Levis'), row('sz_b', '32x30'), row('sz_c', 'M'), row('sz_none', null),
    ]).run()
    db.insert(items).values({ ...row('sz_other', '32x30'), userId: OTHER }).run()
    const ctx = { userId: U, identity: {} }
    for (const input of [{ size: '32X30' }, { size: '32 x 30', query: 'trousers' }, { size: '32x30', brand: 'Levis' }]) {
      const result = await executeTool('search_closet', input, ctx) as { results: { id: string }[] }
      const ids = result.results.map(r => r.id).sort()
      expect(ids, JSON.stringify(input)).toEqual(input.brand ? ['sz_a'] : ['sz_a', 'sz_b'])
    }
    const m = await executeTool('search_closet', { size: ' m ' }, ctx) as { results: { id: string }[] }
    expect(m.results.map(r => r.id)).toEqual(['sz_c'])
  })

  it('get_item includes size', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const now = Date.now()
    db.insert(items).values({
      id: 'sized_item2', userId: U, imageUri: 'images/items/sized_item2.jpg', category: 'shoes',
      size: 'US 10', createdAt: now, updatedAt: now,
    }).run()
    const result = await executeTool('get_item', { id: 'sized_item2' }, { userId: U, identity: {} }) as { size: string }
    expect(result.size).toBe('US 10')
  })
})

// ─── AI tool writes ai_calls with identity ─────────────────────────────────────

describe('agent tools — suggest_outfit (ai scope)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('writes an ai_calls row carrying the identity fields', async () => {
    // Mock the Gemini fallback path (no OPENROUTER_API_KEY → Jev throws).
    vi.doMock('../../src/ai/client.js', () => ({
      generateJSONWithUsage: vi.fn().mockResolvedValue({
        data: [{ item_ids: ['s1', 's2'], name: 'Suggested', occasion: 'casual', reasoning: 'ok' }],
        usage: { tokensIn: 200, tokensOut: 100 },
      }),
      VISION_MODEL: 'gemini-2.5-flash',
      TEXT_MODEL: 'gemini-2.5-flash',
      IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
      providerForModel: () => 'gemini',
    }))
    // Mock listOutfits to return [] so Jev path returns no suggestions
    // → falls through to Gemini compose.
    vi.doMock('../../src/tools/outfits.js', () => ({
      listOutfits: vi.fn().mockResolvedValue([]),
      createOutfit: vi.fn(),
      getOutfit: vi.fn(),
      getOutfitWithItems: vi.fn(),
      deleteOutfit: vi.fn(),
      updateOutfit: vi.fn(),
      markOutfitWorn: vi.fn(),
      OutfitItemOwnershipError: class extends Error {},
    }))

    // Seed two items for the user + a saved location.
    seedItem(U, 's1')
    seedItem(U, 's2')
    setServerLocation(U, 40.7, -74.0, 'NYC')

    const { executeTool } = await import('../../src/agent/tools.js')

    const identity = {
      runId: 'run_test_1',
      turnId: 'turn_test_1',
      stepId: 'step_test_1',
      toolCallId: 'call_test_1',
    }

    const result = await executeTool('suggest_outfit',
      { occasion: 'work' },
      { userId: U, identity },
    ) as { suggestions: { name: string }[] }

    expect(result.suggestions.length).toBeGreaterThanOrEqual(1)
    expect(result.suggestions[0].name).toBe('Suggested')
    // Hydrated with item views so the model (and the Ask tab) can describe the
    // pieces instead of reciting ids; never a raw row with userId.
    const first = result.suggestions[0] as unknown as { items: { id: string }[]; savedOutfit: boolean; reasoning: string }
    expect(first.items.map(i => i.id)).toEqual(['s1', 's2'])
    expect(first.savedOutfit).toBe(false)
    expect(first.reasoning).toBe('ok')
    expect(JSON.stringify(result)).not.toContain(`"userId"`)

    // The ai_calls row should carry the identity fields.
    const calls = db.select().from(aiCalls).where(eq(aiCalls.userId, U)).all()
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const suggestCall = calls.find(c => c.task === 'suggest')
    expect(suggestCall).toBeDefined()
    expect(suggestCall!.runId).toBe('run_test_1')
    expect(suggestCall!.turnId).toBe('turn_test_1')
    expect(suggestCall!.stepId).toBe('step_test_1')
    expect(suggestCall!.toolCallId).toBe('call_test_1')
  })

  it('returns early when closet has fewer than 2 items (no AI call)', async () => {
    seedItem(U, 'only_one')
    setServerLocation(U, 40.7, -74.0, 'NYC')

    const { executeTool } = await import('../../src/agent/tools.js')
    const result = await executeTool('suggest_outfit',
      {},
      { userId: U, identity: {} },
    ) as { suggestions: unknown[]; reason: string }

    expect(result.suggestions).toEqual([])
    expect(result.reason).toMatch(/fewer than 2 items/)
    // No ai_calls row should be written.
    const calls = db.select().from(aiCalls).where(eq(aiCalls.userId, U)).all()
    expect(calls.filter(c => c.task === 'suggest')).toHaveLength(0)
  })
})

describe('suggestionView', () => {
  it('drops the Jev score string and flags the suggestion as a saved outfit', async () => {
    const { suggestionView } = await import('../../src/agent/tools.js')
    const byId = new Map([['a', { id: 'a', userId: U, imageUri: 'images/items/a.jpg', category: 'tops' } as never]])
    const view = suggestionView({ item_ids: ['a', 'gone'], name: 'Summer Casual', occasion: 'casual', reasoning: 'Jev-Noul score 0.79 for 17.4°C Partly cloudy.' }, byId)
    expect(view).toMatchObject({ name: 'Summer Casual', reasoning: null, savedOutfit: true, item_ids: ['a', 'gone'] })
    expect((view.items as { id: string }[]).map(i => i.id)).toEqual(['a'])
    expect(JSON.stringify(view)).not.toContain('userId')
  })
})

// ─── Location input (#333) ─────────────────────────────────────────────────────

// Mock both the Open-Meteo geocoder and the forecast endpoint so no real
// network call leaves the test. Returns geocoder JSON for geocoding-api URLs
// and a minimal current-weather payload otherwise.
function mockOpenMeteo() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('geocoding-api.open-meteo.com')) {
      return new Response(
        JSON.stringify({ results: [{ latitude: 43.65, longitude: -79.38, name: 'Toronto', country: 'Canada' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(
      JSON.stringify({ current: { temperature_2m: 5, weather_code: 3, precipitation: 0, wind_speed_10m: 10 } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  })
}

describe('agent tools — location input (#333)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('explicit `location` beats the saved location', async () => {
    setServerLocation(U, 40.7, -74.0, 'NYC')
    const fetchMock = mockOpenMeteo()
    const { executeTool } = await import('../../src/agent/tools.js')
    const result = await executeTool('get_weather', { location: 'Toronto' }, { userId: U, identity: {} }) as {
      location: { name: string; lat: number; lon: number }
      weather: { temperature: number }
    }
    expect(result.location.name).toMatch(/Toronto/)
    expect(result.location.lat).toBeCloseTo(43.65)
    expect(result.location.lon).toBeCloseTo(-79.38)
    expect(result.weather.temperature).toBe(5)
    // The geocoder URL carries the place name, not the saved NYC coords.
    const geoUrl = String(fetchMock.mock.calls[0][0])
    expect(geoUrl).toContain('Toronto')
    fetchMock.mockRestore()
  })

  it('explicit `lat`+`lon` beats the saved location (no geocoder call)', async () => {
    setServerLocation(U, 40.7, -74.0, 'NYC')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('geocoding-api')) throw new Error('geocoder must not run for lat/lon input')
      return new Response(
        JSON.stringify({ current: { temperature_2m: 5, weather_code: 3, precipitation: 0, wind_speed_10m: 10 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const { executeTool } = await import('../../src/agent/tools.js')
    const result = await executeTool('get_weather', { lat: 43.65, lon: -79.38 }, { userId: U, identity: {} }) as {
      location: { name: string; lat: number; lon: number }
    }
    expect(result.location.lat).toBe(43.65)
    expect(result.location.lon).toBe(-79.38)
    fetchMock.mockRestore()
  })

  it('omitted location falls back to the saved location (no geocoder call)', async () => {
    setServerLocation(U, 40.7, -74.0, 'NYC')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('geocoding-api')) throw new Error('geocoder must not run when using saved location')
      return new Response(
        JSON.stringify({ current: { temperature_2m: 12, weather_code: 0, precipitation: 0, wind_speed_10m: 5 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    const { executeTool } = await import('../../src/agent/tools.js')
    const result = await executeTool('get_weather', {}, { userId: U, identity: {} }) as {
      location: { name: string; lat: number; lon: number }
    }
    expect(result.location.name).toBe('NYC')
    expect(result.location.lat).toBe(40.7)
    fetchMock.mockRestore()
  })

  it('both missing → error that mentions both options', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const err = await executeTool('get_weather', {}, { userId: U, identity: {} }).catch(e => e as Error)
    expect(err).toBeInstanceOf(Error)
    // Mentions the explicit-input option AND the saved-location option.
    expect(err.message).toMatch(/location|lat.*lon/i)
    expect(err.message.toLowerCase()).toContain('settings')
  })

  it('invalid lat (out of range) → validation error, no outbound call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { executeTool } = await import('../../src/agent/tools.js')
    await expect(executeTool('get_weather', { lat: 999, lon: 0 }, { userId: U, identity: {} }))
      .rejects.toThrow(/Invalid input/)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('over-long location name → validation error, no outbound call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { executeTool } = await import('../../src/agent/tools.js')
    await expect(
      executeTool('get_weather', { location: 'a'.repeat(101) }, { userId: U, identity: {} }),
    ).rejects.toThrow(/Invalid input/)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('a mix of `location` and `lat`+`lon` → validation error', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    await expect(
      executeTool('get_weather', { location: 'Toronto', lat: 43, lon: -79 }, { userId: U, identity: {} }),
    ).rejects.toThrow(/Invalid input/)
  })

  it('partial coords (lat without lon) → validation error', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    await expect(
      executeTool('get_weather', { lat: 43 }, { userId: U, identity: {} }),
    ).rejects.toThrow(/Invalid input/)
  })

  it('nothing is written to settings after a call with an explicit location', async () => {
    const fetchMock = mockOpenMeteo()
    const { executeTool } = await import('../../src/agent/tools.js')
    await executeTool('get_weather', { location: 'Toronto' }, { userId: U, identity: {} })
    fetchMock.mockRestore()
    const row = db.select().from(settings).where(eq(settings.key, 'serverLocation')).all()
      .find(r => r.userId === U)
    expect(row).toBeUndefined()
  })

  it('the geocoder request URL contains no userId', async () => {
    const fetchMock = mockOpenMeteo()
    const { executeTool } = await import('../../src/agent/tools.js')
    await executeTool('get_weather', { location: 'Toronto' }, { userId: U, identity: {} })
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0])
      expect(url).not.toMatch(/userId/i)
      expect(url).not.toMatch(/user_id/i)
    }
    fetchMock.mockRestore()
  })

  it('suggest_outfit also accepts a location input and returns the resolved location', async () => {
    vi.resetModules()
    vi.doMock('../../src/ai/client.js', () => ({
      generateJSONWithUsage: vi.fn().mockResolvedValue({
        data: [{ item_ids: ['loc_s1', 'loc_s2'], name: 'Suggested', occasion: 'casual', reasoning: 'ok' }],
        usage: { tokensIn: 200, tokensOut: 100 },
      }),
      VISION_MODEL: 'gemini-2.5-flash',
      TEXT_MODEL: 'gemini-2.5-flash',
      IMAGE_GEN_MODEL: 'gemini-3.1-flash-image-preview',
      providerForModel: () => 'gemini',
    }))
    vi.doMock('../../src/tools/outfits.js', () => ({
      listOutfits: vi.fn().mockResolvedValue([]),
      createOutfit: vi.fn(),
      getOutfit: vi.fn(),
      getOutfitWithItems: vi.fn(),
      deleteOutfit: vi.fn(),
      updateOutfit: vi.fn(),
      markOutfitWorn: vi.fn(),
      OutfitItemOwnershipError: class extends Error {},
    }))
    const fetchMock = mockOpenMeteo()
    seedItem(U, 'loc_s1')
    seedItem(U, 'loc_s2')
    const { executeTool } = await import('../../src/agent/tools.js')
    const result = await executeTool(
      'suggest_outfit',
      { location: 'Toronto', occasion: 'work' },
      { userId: U, identity: {} },
    ) as { location: { name: string }; suggestions: { name: string }[] }
    expect(result.location.name).toMatch(/Toronto/)
    expect(result.suggestions[0].name).toBe('Suggested')
    fetchMock.mockRestore()
  })
})

// ─── Outfit composition + pre-confirm checks (#337) ────────────────────────────

const ctxU = { userId: U, identity: {} }
const ctxOther = { userId: OTHER, identity: {} }

// The suggest_outfit suites above vi.doMock tools/outfits.js and ai/client.js;
// those stubs outlive their tests, so drop them before the suites below.
function useRealModules() {
  beforeEach(() => {
    vi.doUnmock('../../src/tools/outfits.js')
    vi.doUnmock('../../src/ai/client.js')
    vi.resetModules()
  })
}

/** Seeds one wearable look for `userId`: top, bottom, shoes, jacket. */
function seedLook(userId: string, prefix: string): string[] {
  return [
    seedItem(userId, `${prefix}_top`, 'tops'),
    seedItem(userId, `${prefix}_bottom`, 'bottoms'),
    seedItem(userId, `${prefix}_shoes`, 'shoes'),
    seedItem(userId, `${prefix}_jacket`, 'outerwear'),
  ]
}

describe('agent tools — outfit composition (#337)', () => {
  useRealModules()

  it('accepts one item per slot', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const ids = seedLook(U, 'ok')
    const result = await executeTool('create_outfit', { name: 'Red look', item_ids: ids }, ctxU) as { itemIds: string[] }
    expect(result.itemIds).toEqual(ids)
  })

  it('rejects more than 6 items at the schema level (the 9-item "outfit")', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const ids = Array.from({ length: 9 }, (_, i) => seedItem(U, `nine_${i}`))
    await expect(executeTool('create_outfit', { name: 'Everything', item_ids: ids }, ctxU)).rejects.toThrow(/Invalid input/)
  })

  it('rejects three tops, two pairs of shoes, or the same item twice', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const tops = [seedItem(U, 't1'), seedItem(U, 't2'), seedItem(U, 't3')]
    await expect(executeTool('create_outfit', { name: 'x', item_ids: tops }, ctxU)).rejects.toThrow(/at most 2 tops/)
    const shoes = [seedItem(U, 's1', 'shoes'), seedItem(U, 's2', 'shoes')]
    await expect(executeTool('create_outfit', { name: 'x', item_ids: shoes }, ctxU)).rejects.toThrow(/at most 1 shoes item/)
    await expect(executeTool('create_outfit', { name: 'x', item_ids: [tops[0], tops[0]] }, ctxU)).rejects.toThrow(/same item twice/)
    expect(db.select().from(outfits).all()).toHaveLength(0)
  })

  it('rejects a copy of a saved outfit and names the original', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createOutfit } = await import('../../src/tools/outfits.js')
    const ids = seedLook(U, 'dup')
    await createOutfit({ name: 'Sophisticated Professional', itemIds: ids }, U)
    await expect(
      executeTool('create_outfit', { name: 'Toronto Work Day', item_ids: [...ids].reverse() }, ctxU),
    ).rejects.toThrow(/same items as the saved outfit "Sophisticated Professional"/)
  })

  it("another user's identical outfit is not a duplicate", async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createOutfit } = await import('../../src/tools/outfits.js')
    const theirs = seedLook(OTHER, 'theirs')
    await createOutfit({ name: 'Theirs', itemIds: theirs }, OTHER)
    const mine = seedLook(U, 'mine')
    await expect(executeTool('create_outfit', { name: 'Mine', item_ids: mine }, ctxU)).resolves.toBeDefined()
  })
})

describe('agent tools — prepareWrite / describeAction (#337)', () => {
  useRealModules()

  it('returns the Confirm card summary for a valid proposal', async () => {
    const { prepareWrite } = await import('../../src/agent/tools.js')
    const ids = seedLook(U, 'pw')
    expect(await prepareWrite('create_outfit', { name: 'All red', item_ids: ids }, ctxU))
      .toEqual({ ok: true, summary: '“All red” · 4 items' })
  })

  it('returns an error (and writes nothing) for a proposal that would fail', async () => {
    const { prepareWrite } = await import('../../src/agent/tools.js')
    const tops = [seedItem(U, 'pw1'), seedItem(U, 'pw2'), seedItem(U, 'pw3')]
    const r = await prepareWrite('create_outfit', { name: 'x', item_ids: tops }, ctxU)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(/at most 2 tops/)
    expect((await prepareWrite('create_outfit', { name: '' }, ctxU)).ok).toBe(false)
    expect(db.select().from(outfits).all()).toHaveLength(0)
  })

  it('summaries use names looked up for the caller, never ids', async () => {
    const { prepareWrite, describeAction } = await import('../../src/agent/tools.js')
    const { createOutfit } = await import('../../src/tools/outfits.js')
    const { createCollection } = await import('../../src/tools/collections.js')
    const o1 = await createOutfit({ name: 'Work', itemIds: seedLook(U, 'sw1') }, U)
    const o2 = await createOutfit({ name: 'Drinks', itemIds: seedLook(U, 'sw2') }, U)
    const coll = await createCollection({ name: 'Toronto trip' }, U)
    const add = await prepareWrite('add_outfits_to_collection', { collection_id: coll.id, outfit_ids: [o1.id, o2.id] }, ctxU)
    expect(add).toEqual({ ok: true, summary: 'Add 2 outfits to “Toronto trip”' })
    const rename = await describeAction('update_outfit', { id: o1.id, name: 'Conference' }, ctxU)
    expect(rename).toBe('Update “Work”: rename to “Conference”')
    expect(rename).not.toContain(o1.id)
    // Another user's collection: no summary, and prepareWrite refuses.
    expect(await describeAction('update_collection', { id: coll.id, name: 'x' }, ctxOther)).toBeNull()
    const foreign = await prepareWrite('update_collection', { id: coll.id, name: 'x' }, ctxOther)
    expect(foreign.ok === false && foreign.error).toMatch(/not found/)
  })
})

// ─── update_outfit + collections (#338) ────────────────────────────────────────

describe('agent tools — update_outfit (#338)', () => {
  useRealModules()

  it('renames and swaps items, returning the hydrated outfit', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createOutfit } = await import('../../src/tools/outfits.js')
    const ids = seedLook(U, 'upd')
    const outfit = await createOutfit({ name: 'Old', itemIds: ids }, U)
    const boots = seedItem(U, 'upd_boots', 'shoes')
    const swapped = [ids[0], ids[1], boots, ids[3]]
    const result = await executeTool('update_outfit', { id: outfit.id, name: 'New', item_ids: swapped }, ctxU) as {
      name: string; itemIds: string[]; items: { id: string }[]
    }
    expect(result.name).toBe('New')
    expect(result.itemIds).toEqual(swapped)
    expect(result.items.map(i => i.id).sort()).toEqual([...swapped].sort())
  })

  it('keeping the same items is not flagged as a copy of itself', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createOutfit } = await import('../../src/tools/outfits.js')
    const ids = seedLook(U, 'self')
    const outfit = await createOutfit({ name: 'Same', itemIds: ids }, U)
    await expect(executeTool('update_outfit', { id: outfit.id, item_ids: ids, notes: 'n' }, ctxU)).resolves.toBeDefined()
  })

  it("rejects another user's item ids and another user's outfit", async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createOutfit } = await import('../../src/tools/outfits.js')
    const mine = await createOutfit({ name: 'Mine', itemIds: seedLook(U, 'uo') }, U)
    const foreignItem = seedItem(OTHER, 'uo_foreign', 'shoes')
    await expect(executeTool('update_outfit', { id: mine.id, item_ids: [foreignItem] }, ctxU))
      .rejects.toThrow(/Item uo_foreign not found/)
    await expect(executeTool('update_outfit', { id: mine.id, name: 'Stolen' }, ctxOther))
      .rejects.toThrow(/Outfit .* not found/)
    expect(db.select().from(outfits).where(eq(outfits.id, mine.id)).get()?.name).toBe('Mine')
  })

  it('requires at least one change', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    await expect(executeTool('update_outfit', { id: 'x' }, ctxU)).rejects.toThrow(/Change at least one field/)
  })
})

describe('agent tools — collections (#338)', () => {
  useRealModules()

  async function savedOutfit(userId: string, prefix: string, name = prefix) {
    const { createOutfit } = await import('../../src/tools/outfits.js')
    return createOutfit({ name, itemIds: seedLook(userId, prefix) }, userId)
  }

  it('create_collection creates it with saved outfits and returns the hydrated collection', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const work = await savedOutfit(U, 'cc1', 'Work')
    const drinks = await savedOutfit(U, 'cc2', 'Drinks')
    const result = await executeTool('create_collection', {
      name: 'Toronto trip', description: 'Pack list', outfit_ids: [work.id, drinks.id],
    }, ctxU) as { name: string; description: string; outfits: { name: string; items: unknown[] }[]; total: number }
    expect(result.name).toBe('Toronto trip')
    expect(result.outfits.map(o => o.name)).toEqual(['Work', 'Drinks'])
    expect(result.outfits[0].items).toHaveLength(4)
    expect(result.total).toBe(2)
    // Pointed at the saved outfits — no copies.
    expect(db.select().from(outfits).all()).toHaveLength(2)
  })

  it("create_collection with another user's outfit fails and leaves no collection behind", async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const theirs = await savedOutfit(OTHER, 'ccf')
    await expect(executeTool('create_collection', { name: 'Trip', outfit_ids: [theirs.id] }, ctxU))
      .rejects.toThrow(/Outfit .* not found/)
    expect(db.select().from(collections).where(eq(collections.userId, U)).all()).toHaveLength(0)
  })

  it('create_collection rejects a second collection with the same name', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createCollection } = await import('../../src/tools/collections.js')
    await createCollection({ name: 'Toronto Trip' }, U)
    await expect(executeTool('create_collection', { name: 'toronto trip' }, ctxU))
      .rejects.toThrow(/already exists/)
    // Another user's same-named collection doesn't count.
    await expect(executeTool('create_collection', { name: 'Toronto Trip' }, ctxOther)).resolves.toBeDefined()
  })

  it('add / remove outfits, and remove rejects an outfit that is not in it', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createCollection } = await import('../../src/tools/collections.js')
    const coll = await createCollection({ name: 'Trip' }, U)
    const a = await savedOutfit(U, 'ar1')
    const b = await savedOutfit(U, 'ar2')
    const added = await executeTool('add_outfits_to_collection', { collection_id: coll.id, outfit_ids: [a.id, b.id] }, ctxU) as { total: number }
    expect(added.total).toBe(2)
    const removed = await executeTool('remove_outfits_from_collection', { collection_id: coll.id, outfit_ids: [a.id] }, ctxU) as {
      outfits: { id: string }[]
    }
    expect(removed.outfits.map(o => o.id)).toEqual([b.id])
    // The outfit itself is kept.
    expect(db.select().from(outfits).where(eq(outfits.id, a.id)).get()).toBeDefined()
    await expect(executeTool('remove_outfits_from_collection', { collection_id: coll.id, outfit_ids: [a.id] }, ctxU))
      .rejects.toThrow(/not in this collection/)
  })

  it('update_collection renames and clears the description', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createCollection } = await import('../../src/tools/collections.js')
    const coll = await createCollection({ name: 'Old', description: 'desc' }, U)
    const result = await executeTool('update_collection', { id: coll.id, name: 'New', description: '' }, ctxU) as {
      name: string; description: string | null
    }
    expect(result).toMatchObject({ name: 'New', description: null })
  })

  it("every collection tool treats another user's collection as not found", async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const { createCollection, addOutfitsToCollection } = await import('../../src/tools/collections.js')
    const theirColl = await createCollection({ name: 'Theirs' }, OTHER)
    const theirOutfit = await savedOutfit(OTHER, 'xo')
    await addOutfitsToCollection(theirColl.id, [theirOutfit.id], OTHER)
    const mine = await savedOutfit(U, 'xm')
    const notFound = /Collection .* not found/
    await expect(executeTool('get_collection', { id: theirColl.id }, ctxU)).rejects.toThrow(notFound)
    await expect(executeTool('add_outfits_to_collection', { collection_id: theirColl.id, outfit_ids: [mine.id] }, ctxU)).rejects.toThrow(notFound)
    await expect(executeTool('remove_outfits_from_collection', { collection_id: theirColl.id, outfit_ids: [theirOutfit.id] }, ctxU)).rejects.toThrow(notFound)
    await expect(executeTool('update_collection', { id: theirColl.id, name: 'Mine now' }, ctxU)).rejects.toThrow(notFound)
    // My collection can't take their outfit either.
    const myColl = await createCollection({ name: 'Mine' }, U)
    await expect(executeTool('add_outfits_to_collection', { collection_id: myColl.id, outfit_ids: [theirOutfit.id] }, ctxU))
      .rejects.toThrow(/Outfit .* not found/)
    const their = db.select().from(collections).where(eq(collections.id, theirColl.id)).get()
    expect(their?.name).toBe('Theirs')
  })

  it('collection results carry no identity fields', async () => {
    const { executeTool } = await import('../../src/agent/tools.js')
    const o = await savedOutfit(U, 'idf')
    const result = await executeTool('create_collection', { name: 'Clean', outfit_ids: [o.id] }, ctxU)
    expect(containsKeyDeep(result, new Set(['userId', 'user_id', 'email']))).toBe(false)
  })
})

// ─── get_forecast (#338) ───────────────────────────────────────────────────────

describe('agent tools — get_forecast (#338)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  function mockForecast() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      const start = url.searchParams.get('start_date')!
      const end = url.searchParams.get('end_date')!
      const time: string[] = []
      for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
        time.push(d.toISOString().slice(0, 10))
      }
      const fill = (v: number) => time.map(() => v)
      return new Response(JSON.stringify({ daily: {
        time, temperature_2m_max: fill(14), temperature_2m_min: fill(6), weather_code: fill(61),
        precipitation_probability_max: fill(70), precipitation_sum: fill(3.2), wind_speed_10m_max: fill(20),
      } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
  }

  it('returns one entry per day for the requested range', async () => {
    const fetchMock = mockForecast()
    const { executeTool } = await import('../../src/agent/tools.js')
    const result = await executeTool('get_forecast', { lat: 43.65, lon: -79.38, start_date: '2026-10-02', days: 3 }, ctxU) as {
      days: { date: string; tempMax: number; condition: string; precipitationProbability: number }[]
    }
    expect(result.days.map(d => d.date)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04'])
    expect(result.days[0]).toMatchObject({ tempMax: 14, precipitationProbability: 70 })
    expect(typeof result.days[0].condition).toBe('string')
    fetchMock.mockRestore()
  })

  it('rounds coords like get_weather and sends no userId', async () => {
    const fetchMock = mockForecast()
    const { executeTool } = await import('../../src/agent/tools.js')
    await executeTool('get_forecast', { lat: 43.651, lon: -79.383 }, ctxU)
    const url = new URL(String(fetchMock.mock.calls[0][0]))
    expect(url.searchParams.get('latitude')).toBe('43.5')
    expect(url.searchParams.get('longitude')).toBe('-79.5')
    expect(url.toString()).not.toMatch(/user_?id/i)
    expect(url.toString()).not.toContain(U)
    fetchMock.mockRestore()
  })

  it('defaults to 3 days starting today', async () => {
    const fetchMock = mockForecast()
    const { executeTool } = await import('../../src/agent/tools.js')
    const result = await executeTool('get_forecast', { lat: 0, lon: 0 }, ctxU) as { days: { date: string }[] }
    expect(result.days).toHaveLength(3)
    expect(result.days[0].date).toBe(new Date().toISOString().slice(0, 10))
    fetchMock.mockRestore()
  })

  it('rejects more than 7 days, a malformed date, and a missing location (no outbound call)', async () => {
    const fetchMock = mockForecast()
    const { executeTool } = await import('../../src/agent/tools.js')
    await expect(executeTool('get_forecast', { lat: 0, lon: 0, days: 8 }, ctxU)).rejects.toThrow(/Invalid input/)
    await expect(executeTool('get_forecast', { lat: 0, lon: 0, start_date: 'next friday' }, ctxU)).rejects.toThrow(/Invalid input/)
    await expect(executeTool('get_forecast', {}, ctxU)).rejects.toThrow(/No location provided/)
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockRestore()
  })
})
