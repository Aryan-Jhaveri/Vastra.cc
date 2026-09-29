import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { eq } from 'drizzle-orm'
import type { MessageRequest, ModelEvent, ModelToolCall } from '../../src/ai/messages.js'

// #341 — Ask shop tools, end to end through the chat route. Only the model
// stream and the Shopify catalog client are faked; the loop, DB, history,
// hydration and tool registry run for real.

interface Scripted { text?: string; toolCalls?: ModelToolCall[] }
const { script, requests } = vi.hoisted(() => ({
  script: [] as Scripted[],
  requests: [] as MessageRequest[],
}))

vi.mock('../../src/ai/client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/ai/client.js')>()
  const { validate } = await import('../../src/ai/messageAdapters.js')
  return {
    ...actual,
    streamMessages: (req: MessageRequest, model: string) => (async function* () {
      validate(req, !model.includes('/'), model)
      requests.push(structuredClone({ ...req, signal: undefined }))
      const next = script.shift()
      if (!next) throw new Error('script exhausted')
      if (next.text) yield { type: 'text_delta', text: next.text } as ModelEvent
      yield {
        type: 'complete',
        response: {
          message: { role: 'assistant', content: next.text ?? '', ...(next.toolCalls ? { toolCalls: next.toolCalls } : {}) },
          usage: { tokensIn: 10, tokensOut: 5 },
          finishReason: next.toolCalls?.length ? 'tool_calls' : 'stop',
        },
      } as ModelEvent
    })(),
  }
})

vi.mock('../../src/commerce/shopify/catalog.js', () => ({
  searchGlobalCatalog: vi.fn(),
  lookupGlobalCatalog: vi.fn(),
  LOOKUP_MAX_IDS: 50,
}))

vi.mock('../../src/tools/weather.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/tools/weather.js')>()),
  geocodeCity: vi.fn(),
}))

vi.mock('../../src/ai/shopRank.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../src/ai/shopRank.js')>()),
  rankShopProductsWithJev: vi.fn(async ({ products }: { products: unknown[] }) => [...products].reverse()),
}))

import { db } from '../../src/db/client.js'
import { chatMessages, chatThreads, chatTurnLeases, aiCalls, items, likedProducts, settings, users } from '../../src/db/schema.js'
import chatRouter from '../../src/transport/web/routes/chat.js'
import { searchGlobalCatalog, lookupGlobalCatalog, type ShopProduct } from '../../src/commerce/shopify/catalog.js'
import { rankShopProductsWithJev } from '../../src/ai/shopRank.js'
import { resetShopBudget, SHOP_CALLS_PER_MINUTE, takeShopCall } from '../../src/agent/shopBudget.js'
import { AGENT_TOOLS, isToolAvailable, toMinorUnits, inputToJsonSchema } from '../../src/agent/tools.js'
import { geocodeCity } from '../../src/tools/weather.js'

const U = 'self'
const gid = (n: string) => `gid://shopify/p/${n}`
const product = (id: string, title = `Product ${id}`): ShopProduct => ({
  id, title, imageUrl: 'https://cdn.shopify.com/x.jpg', price: '$40.00', merchant: 'Shop', url: 'https://shop.example/p', available: true,
})

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.userId = U; req.authVia = 'cookie'; next() })
  app.use('/api/chat', chatRouter)
  return app
}

function parseSse(text: string): Record<string, unknown>[] {
  return text.split('\n\n').flatMap(block => {
    const data = block.split('\n').find(l => l.startsWith('data: '))
    return data ? [JSON.parse(data.slice(6)) as Record<string, unknown>] : []
  })
}

async function send(message: string) {
  const res = await request(makeApp()).post('/api/chat/stream').send({ message })
  return parseSse(res.text)
}

function setSetting(key: string, value: unknown) {
  db.insert(settings).values({ key, userId: U, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: [settings.key, settings.userId], set: { value: JSON.stringify(value) } }).run()
}

function call(name: string, args: Record<string, unknown>, id: string): ModelToolCall {
  return { id, name, arguments: args as ModelToolCall['arguments'] }
}

beforeEach(() => {
  script.length = 0
  requests.length = 0
  vi.mocked(searchGlobalCatalog).mockReset()
  vi.mocked(lookupGlobalCatalog).mockReset()
  vi.mocked(geocodeCity).mockReset()
  vi.mocked(rankShopProductsWithJev).mockClear()
  resetShopBudget()
  db.delete(chatTurnLeases).run()
  db.delete(chatThreads).run()
  db.delete(aiCalls).run()
  db.delete(items).run()
  db.delete(likedProducts).run()
  for (const key of ['serverLocation', 'shopGender', 'userSizes']) db.delete(settings).where(eq(settings.key, key)).run()
  process.env.HOSTED_MODE = 'true'
  process.env.SHOP_ROW_ENABLED = 'true'
  // Nothing here may reach the network — a missed mock must fail loudly.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => { throw new Error(`unexpected network call: ${String(input)}`) })
})

afterEach(() => {
  delete process.env.SHOP_ROW_ENABLED
  vi.restoreAllMocks()
})

describe('shop tools — gating', () => {
  it('are declared (to the model and in the prompt) only while SHOP_ROW_ENABLED is on', async () => {
    delete process.env.SHOP_ROW_ENABLED
    script.push({ text: 'a' })
    await send('hi')
    const off = requests[0]
    expect(off.tools!.map(t => t.name)).not.toContain('search_shop')
    expect(off.tools!.map(t => t.name)).not.toContain('list_liked_products')
    expect(off.system).not.toContain('Shop:')

    process.env.SHOP_ROW_ENABLED = 'true'
    script.push({ text: 'b' })
    await send('hi again')
    const on = requests[1]
    expect(on.tools!.map(t => t.name)).toEqual(expect.arrayContaining(['search_shop', 'list_liked_products']))
    expect(on.system).toContain('garment words only')
  })

  it('a call to a shop tool while shop is off is refused without a catalog call', async () => {
    delete process.env.SHOP_ROW_ENABLED
    script.push({ toolCalls: [call('search_shop', { query: 'red shirt' }, 'c1')] }, { text: 'sorry' })
    const events = await send('find me a red shirt')
    expect(events.find(e => e.type === 'tool_result')).toMatchObject({ error: 'Unknown tool: search_shop' })
    expect(searchGlobalCatalog).not.toHaveBeenCalled()
  })

  it('isToolAvailable follows the flag (MCP tools/list uses the same filter)', () => {
    const shop = AGENT_TOOLS.filter(t => t.name === 'search_shop' || t.name === 'list_liked_products')
    expect(shop).toHaveLength(2)
    expect(shop.every(isToolAvailable)).toBe(true)
    delete process.env.SHOP_ROW_ENABLED
    expect(shop.some(isToolAvailable)).toBe(false)
    expect(shop.every(t => t.scope === 'read')).toBe(true)
  })
})

describe('search_shop', () => {
  it('sends country + gender from settings and nothing personal to the catalog', async () => {
    setSetting('serverLocation', { enabled: true, lat: 43.65, lon: -79.38, name: 'Toronto, Canada', countryCode: 'CA' })
    db.insert(settings).values({ key: 'shopGender', userId: U, value: 'female' }).run()
    setSetting('userSizes', { tops: 'M-SECRET' })
    const now = Date.now()
    db.insert(items).values({ id: 'closet_item_1', userId: U, imageUri: 'images/items/a.jpg', category: 'tops', brand: 'SecretBrandX', createdAt: now, updatedAt: now }).run()
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [product(gid('1')), product(gid('2'))], nextCursor: null, details: {} })
    script.push({ toolCalls: [call('search_shop', { query: 'navy chinos', item_ids: ['closet_item_1'] }, 'c1')] }, { text: 'done' })

    await send('what trousers would go with my shirt?')

    const outbound = vi.mocked(searchGlobalCatalog).mock.calls[0][0]
    expect(outbound).toMatchObject({ query: 'navy chinos', country: 'CA', gender: 'female' })
    const flat = JSON.stringify(vi.mocked(searchGlobalCatalog).mock.calls)
    for (const secret of [U, 'closet_item_1', 'SecretBrandX', 'M-SECRET', 'Toronto', '43.65', 'local.closet']) {
      expect(flat).not.toContain(secret)
    }
    // Ranked with the closet item via Jev (server side), and a bigger pool was requested.
    expect(outbound.limit).toBe(24)
    expect(rankShopProductsWithJev).toHaveBeenCalledOnce()
  })

  it('history stores product ids only; the model sees full products this request, ids on the next', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({
      products: [product(gid('1'), 'Red Linen Shirt'), product(gid('2'), 'Crimson Tee')], nextCursor: 'cur', details: {},
    })
    script.push({ toolCalls: [call('search_shop', { query: 'red linen shirt' }, 'c1')] }, { text: 'Try the linen one.' })
    const events = await send('show me red shirts to buy')

    // The live event carries the full cards.
    const live = events.find(e => e.type === 'tool_result') as { result: { products: ShopProduct[]; nextCursor: string } }
    expect(live.result.products.map(p => p.title)).toEqual(['Red Linen Shirt', 'Crimson Tee'])
    expect(live.result.nextCursor).toBe('cur')
    // The follow-up model call in the same request saw the titles.
    expect(JSON.stringify(requests[1].messages)).toContain('Red Linen Shirt')

    // The stored row has ids only — no titles, prices, URLs, images or cursor.
    const row = db.select().from(chatMessages).where(eq(chatMessages.role, 'tool')).get()!
    const stored = JSON.parse(row.content) as { productIds: string[] }
    expect(stored.productIds).toEqual([gid('1'), gid('2')])
    expect(row.content).not.toMatch(/Red Linen|Crimson|\$40|cdn\.shopify|shop\.example|cur/)

    // Next turn: the model gets ids + a note, not the catalog data.
    const threadId = events[0].threadId as string
    script.push({ text: 'ok' })
    await request(makeApp()).post('/api/chat/stream').send({ message: 'thanks', threadId })
    const replay = JSON.stringify(requests[2].messages)
    expect(replay).toContain(gid('1'))
    expect(replay).toContain('shown to the user as cards')
    expect(replay).not.toContain('Red Linen Shirt')
  })

  it('a thread reload re-reads products live and flags delisted ones', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [product(gid('1')), product(gid('2'))], nextCursor: null, details: {} })
    script.push({ toolCalls: [call('search_shop', { query: 'white sneakers' }, 'c1')] }, { text: 'Here.' })
    const events = await send('white sneakers to buy')
    const threadId = events[0].threadId as string

    vi.mocked(lookupGlobalCatalog).mockResolvedValue({ products: [product(gid('2'), 'Still Listed (new price)')], notFound: [gid('1')] })
    const got = await request(makeApp()).get(`/api/chat/threads/${threadId}`)
    const tool = got.body.messages.find((m: { role: string }) => m.role === 'tool')
    expect(tool.content.products.map((p: ShopProduct) => p.title)).toEqual(['Still Listed (new price)'])
    expect(tool.content.gone).toEqual([gid('1')])
    expect(vi.mocked(lookupGlobalCatalog).mock.calls[0][0].ids).toEqual([gid('1'), gid('2')])
  })

  it('the third search in one turn is a tool error, not a catalog call', async () => {
    vi.mocked(searchGlobalCatalog).mockResolvedValue({ products: [product(gid('1'))], nextCursor: null, details: {} })
    script.push(
      { toolCalls: [call('search_shop', { query: 'a' }, 's1'), call('search_shop', { query: 'b' }, 's2'), call('search_shop', { query: 'c' }, 's3')] },
      { text: 'done' },
    )
    const events = await send('lots of shopping')
    const results = events.filter(e => e.type === 'tool_result') as { id: string; error?: string }[]
    expect(results.filter(r => r.error)).toHaveLength(1)
    expect(results.find(r => r.error)!.error).toMatch(/At most 2 shop searches per message/)
    expect(searchGlobalCatalog).toHaveBeenCalledTimes(2)
  })

  it('a catalog failure is a tool error the model can explain', async () => {
    vi.mocked(searchGlobalCatalog).mockRejectedValue(new Error('timeout'))
    script.push({ toolCalls: [call('search_shop', { query: 'scarf' }, 'c1')] }, { text: 'The shop is down.' })
    const events = await send('a scarf to buy')
    expect(events.find(e => e.type === 'tool_result')).toMatchObject({ error: expect.stringMatching(/shop is unavailable/) })
  })
})

describe('search_shop filters — price, budget, size, location', () => {
  const noProducts = { products: [product(gid('1'))], nextCursor: null, details: {} }

  it('sends price in minor units, budget tiers, sizes and an explicit country over the saved one', async () => {
    setSetting('serverLocation', { enabled: true, lat: 43.65, lon: -79.38, name: 'Toronto, Canada', countryCode: 'CA' })
    vi.mocked(searchGlobalCatalog).mockResolvedValue(noProducts)
    script.push({ toolCalls: [call('search_shop', {
      query: 'black jeans', min_price: 40, max_price: 120.5, currency: 'usd',
      budget: ['low', 'medium'], sizes: ['32', '32', 'M'], country: 'us',
    }, 'c1')] }, { text: 'done' })

    const events = await send('black jeans under $120 in size 32, shipped to the US')

    expect(vi.mocked(searchGlobalCatalog).mock.calls[0][0]).toMatchObject({
      query: 'black jeans', country: 'US', currency: 'USD',
      minPriceMinor: 4000, maxPriceMinor: 12050, priceTiers: ['low', 'medium'], sizes: ['32', 'M'],
    })
    const result = (events.find(e => e.type === 'tool_result') as { result: { filters: Record<string, unknown> } }).result
    expect(result.filters).toEqual({
      country: 'US', currency: 'USD', minPrice: 40, maxPrice: 120.5, budget: ['low', 'medium'], sizes: ['32', 'M'],
    })
    // The applied filters survive into history (they're the user's own, not catalog data).
    const row = db.select().from(chatMessages).where(eq(chatMessages.role, 'tool')).get()!
    expect(JSON.parse(row.content).filters).toMatchObject({ country: 'US', sizes: ['32', 'M'] })
  })

  it('a place name is geocoded and only its country reaches the shop', async () => {
    vi.mocked(geocodeCity).mockResolvedValue({ lat: 19.07, lon: 72.87, name: 'Mumbai, India', countryCode: 'IN' })
    vi.mocked(searchGlobalCatalog).mockResolvedValue(noProducts)
    script.push({ toolCalls: [call('search_shop', { query: 'linen kurta', location: 'Mumbai' }, 'c1')] }, { text: 'done' })

    await send('a linen kurta I can get in Mumbai')

    expect(geocodeCity).toHaveBeenCalledWith('Mumbai')
    expect(vi.mocked(searchGlobalCatalog).mock.calls[0][0]).toMatchObject({ country: 'IN' })
    const flat = JSON.stringify(vi.mocked(searchGlobalCatalog).mock.calls)
    for (const leak of ['Mumbai', '19.07', '72.87']) expect(flat).not.toContain(leak)
  })

  it('falls back to the saved location country, and sends no price/size filters unless given', async () => {
    setSetting('serverLocation', { enabled: true, lat: 43.65, lon: -79.38, name: 'Toronto, Canada', countryCode: 'CA' })
    setSetting('userSizes', { tops: 'M' })
    vi.mocked(searchGlobalCatalog).mockResolvedValue(noProducts)
    script.push({ toolCalls: [call('search_shop', { query: 'white tee' }, 'c1')] }, { text: 'done' })

    await send('a white tee')

    const outbound = vi.mocked(searchGlobalCatalog).mock.calls[0][0]
    expect(outbound.country).toBe('CA')
    for (const k of ['currency', 'minPriceMinor', 'maxPriceMinor', 'priceTiers', 'sizes'] as const) expect(outbound[k]).toBeUndefined()
    expect(geocodeCity).not.toHaveBeenCalled()
  })

  it('a place with no country code is a tool error, not a catalog call', async () => {
    vi.mocked(geocodeCity).mockResolvedValue({ lat: 0, lon: 0, name: 'Somewhere' })
    script.push({ toolCalls: [call('search_shop', { query: 'scarf', location: 'Somewhere' }, 'c1')] }, { text: 'sorry' })
    const events = await send('a scarf shipped to Somewhere')
    expect(events.find(e => e.type === 'tool_result')).toMatchObject({ error: expect.stringMatching(/Pass `country`/) })
    expect(searchGlobalCatalog).not.toHaveBeenCalled()
  })

  it.each([
    [{ query: 'jeans', max_price: 100 }, /currency/],
    [{ query: 'jeans', location: 'Paris', country: 'FR' }, /not both/],
    [{ query: 'jeans', min_price: 200, max_price: 100, currency: 'EUR' }, /min_price/],
    [{ query: 'jeans', country: 'France' }, /alpha-2/],
    [{ query: 'jeans', budget: ['cheap'] }, /./],
  ])('rejects bad filters without a catalog call: %j', async (args, msg) => {
    script.push({ toolCalls: [call('search_shop', args, 'c1')] }, { text: 'sorry' })
    const events = await send('jeans')
    expect(events.find(e => e.type === 'tool_result')).toMatchObject({ error: expect.stringMatching(msg) })
    expect(searchGlobalCatalog).not.toHaveBeenCalled()
  })

  it('toMinorUnits follows each currency\'s decimals', () => {
    expect(toMinorUnits(120, 'CAD')).toBe(12000)
    expect(toMinorUnits(19.99, 'USD')).toBe(1999)
    expect(toMinorUnits(5000, 'JPY')).toBe(5000)
    expect(toMinorUnits(1.5, 'KWD')).toBe(1500)
  })

  it('the tool schema still converts to JSON Schema (MCP + model declarations)', () => {
    const tool = AGENT_TOOLS.find(t => t.name === 'search_shop')!
    const schema = inputToJsonSchema(tool) as { properties: Record<string, unknown> }
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(
      ['min_price', 'max_price', 'currency', 'budget', 'sizes', 'location', 'country'],
    ))
  })
})

describe('list_liked_products', () => {
  it('looks liked ids up live, newest first, and reports delisted ones', async () => {
    db.insert(likedProducts).values([
      { id: 'l1', userId: U, productId: gid('old'), savedItemId: null, createdAt: 1 },
      { id: 'l2', userId: U, productId: gid('new'), savedItemId: null, createdAt: 2 },
    ]).run()
    vi.mocked(lookupGlobalCatalog).mockResolvedValue({ products: [product(gid('new'), 'New Like')], notFound: [gid('old')] })
    script.push({ toolCalls: [call('list_liked_products', {}, 'c1')] }, { text: 'One is gone.' })
    const events = await send('what did I like?')
    const result = (events.find(e => e.type === 'tool_result') as { result: { products: ShopProduct[]; gone: string[]; total: number } }).result
    expect(vi.mocked(lookupGlobalCatalog).mock.calls[0][0].ids).toEqual([gid('new'), gid('old')])
    expect(result.products.map(p => p.title)).toEqual(['New Like'])
    expect(result).toMatchObject({ gone: [gid('old')], total: 2 })
    const row = db.select().from(chatMessages).where(eq(chatMessages.role, 'tool')).get()!
    expect(row.content).not.toContain('New Like')
  })
})

describe('shop budget', () => {
  it('caps shop calls per user per minute', () => {
    for (let i = 0; i < SHOP_CALLS_PER_MINUTE; i++) expect(takeShopCall('u_budget', { search: false })).toBeNull()
    expect(takeShopCall('u_budget', { search: false })).toMatch(/Shop limit reached/)
    expect(takeShopCall('u_other_budget', { search: false })).toBeNull()
  })
})

// Keep the test user around for the router's requireUserId.
it('seeded user exists', () => {
  expect(db.select().from(users).where(eq(users.id, U)).get()).toBeDefined()
})
