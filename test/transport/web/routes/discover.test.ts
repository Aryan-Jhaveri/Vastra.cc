import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'

vi.mock('../../../../src/ai/instrumented.js', () => ({
  runInstrumented: vi.fn((input: any) => input.call({}).then((r: any) => r.result)),
}))

vi.mock('../../../../src/tools/items.js', () => ({
  listItems: vi.fn(),
}))

vi.mock('../../../../src/tools/outfits.js', () => ({
  listOutfits: vi.fn(),
}))

vi.mock('../../../../src/tools/weather.js', () => ({
  getCurrentWeather: vi.fn(),
}))

vi.mock('../../../../src/tools/share.js', () => ({
  getSharePayload: vi.fn(),
}))

vi.mock('../../../../src/ai/inspiration.js', () => ({
  analyzeInspiration: vi.fn(),
}))

vi.mock('../../../../src/ai/discover.js', () => ({
  matchClosetToContext: vi.fn(),
  rankSavedOutfitsWithJev: vi.fn(),
  rankItemsForOccasionWithJev: vi.fn(),
  rankItemsForInspirationWithJev: vi.fn(),
}))

vi.mock('../../../../src/ai/embed.js', () => ({
  embedText: vi.fn(),
  // Outfit text vectors are stored under the 'metadata' variant; readers must
  // ask for the same one or retrieval silently returns nothing.
  OUTFIT_TEXT_VARIANT: 'metadata',
}))

vi.mock('../../../../src/ai/embedImage.js', () => ({
  embedImage: vi.fn(),
  embedItemImage: vi.fn(),
}))

vi.mock('../../../../src/ai/discoverEvents.js', () => ({
  logDiscoverEvent: vi.fn(),
}))

vi.mock('../../../../src/storage/embeddings.js', () => ({
  topKHybrid: vi.fn(),
  shouldUsePreFilter: vi.fn(),
  getAllEmbeddings: vi.fn(),
  topKText: vi.fn(),
  topKTextWithScores: vi.fn(),
  topKImageFromBuffer: vi.fn(),
  reciprocalRankFusion: vi.fn(),
}))

// #329 privacy: the settings getter is a spy that WOULD hand back sizes, so a
// Discover path that started reading settings would leak them into prompts.
vi.mock('../../../../src/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/settings.js')>()
  return {
    ...actual,
    getSettings: vi.fn(() => ({ userSizes: { tops: 'ZZSIZE-TOPS', shoes: 'ZZSIZE-SHOES' }, sizesAgentContext: true })),
  }
})

import * as settingsMod from '../../../../src/settings.js'
import * as itemsTools from '../../../../src/tools/items.js'
import * as outfitsTools from '../../../../src/tools/outfits.js'
import * as weatherTools from '../../../../src/tools/weather.js'
import * as shareTools from '../../../../src/tools/share.js'
import * as inspirationMod from '../../../../src/ai/inspiration.js'
import * as discoverMod from '../../../../src/ai/discover.js'
import * as embedMod from '../../../../src/ai/embed.js'
import * as embedImageMod from '../../../../src/ai/embedImage.js'
import * as discoverEventsMod from '../../../../src/ai/discoverEvents.js'
import * as embeddingsMod from '../../../../src/storage/embeddings.js'
import discoverRouter from '../../../../src/transport/web/routes/discover.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', discoverRouter)
  return app
}

const mockItem = {
  id: 'item1',
  imageUri: 'images/items/test.jpg',
  category: 'tops',
  subcategory: 'T-shirt',
  primaryColor: 'white',
  colors: '["white"]',
  material: 'cotton',
  brand: null,
  size: null,
  season: '["summer"]',
  tags: '["casual"]',
  aiDescription: null,
  occasion: '["casual"]',
  wearContext: null,
  materialSource: null,
  careInstructions: '[]',
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  tagImageUri: null,
}

const mockOutfit = {
  id: 'outfit1',
  name: 'Summer Look',
  itemIds: '["item1"]',
  occasion: 'casual',
  season: '["summer"]',
  tags: '[]',
  aiGenerated: 1,
  weatherContext: null,
  notes: null,
  coverImageUri: null,
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
}

beforeEach(() => {
  vi.clearAllMocks()
  // vi.clearAllMocks() wipes call history but NOT implementations
  // (mockReturnValue/mockResolvedValue persist). Under --sequence.shuffle a
  // Track A test can leave DISCOVER_RETRIEVAL_ENABLED='true' plus populated
  // embedding mocks behind, flipping a later weather-mode POST / onto the
  // retrieval path ('retrieved', LLM never called). Reset the env flags and
  // every retrieval-path mock to inert defaults here — describe blocks and
  // individual tests re-enable what they need (their beforeEach/it bodies
  // run after this one).
  process.env.DISCOVER_RETRIEVAL_ENABLED = 'false'
  process.env.DISCOVER_PREFILTER_ENABLED = 'false'
  vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(new Map() as any)
  vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([])
  vi.mocked(embeddingsMod.topKText).mockResolvedValue([])
  vi.mocked(embeddingsMod.topKHybrid).mockResolvedValue([])
  vi.mocked(embeddingsMod.topKImageFromBuffer).mockResolvedValue([])
  vi.mocked(embeddingsMod.shouldUsePreFilter).mockReturnValue(false)
  vi.mocked(itemsTools.listItems).mockResolvedValue([mockItem, { ...mockItem, id: 'item2' }] as any)
  vi.mocked(outfitsTools.listOutfits).mockResolvedValue([mockOutfit] as any)
  vi.mocked(discoverMod.matchClosetToContext).mockResolvedValue({
    data: [
      { item_ids: ['item1'], name: 'AI Look', occasion: 'casual', reasoning: 'Looks good' },
    ],
    usage: { tokensIn: 200, tokensOut: 100 },
  })
  // Default: Jev saved-outfit ranker throws so tests hit the embedding fallback
  // unless they override with mockResolvedValue explicitly.
  vi.mocked(discoverMod.rankSavedOutfitsWithJev).mockRejectedValue(new Error('jev not mocked'))
  // Default: pool-level Jev ranking returns nothing — cold pool keeps embedding order.
  vi.mocked(discoverMod.rankItemsForOccasionWithJev).mockResolvedValue([])
  // Inspiration modes: Jev keeps the pool order by default (#330).
  vi.mocked(discoverMod.rankItemsForInspirationWithJev).mockImplementation(async ({ items }) => items)
  // Real RRF implementation for the mock
  vi.mocked(embeddingsMod.reciprocalRankFusion).mockImplementation(
    (textRanks: Map<string, number>, imageRanks: Map<string, number>, k: number, c = 60) => {
      const scores = new Map<string, number>()
      const allIds = new Set([...textRanks.keys(), ...imageRanks.keys()])
      for (const id of allIds) {
        let score = 0
        if (textRanks.has(id)) score += 1 / (c + (textRanks.get(id) ?? 0) + 1)
        if (imageRanks.has(id)) score += 1 / (c + (imageRanks.get(id) ?? 0) + 1)
        scores.set(id, score)
      }
      return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k))
    },
  )
})

describe('POST / (discover)', () => {
  it('returns suggestions from matchClosetToContext for prompt mode', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'prompt', prompt: 'cozy outfit' })

    expect(res.status).toBe(200)
    expect(res.body.context).toEqual({
      description: 'cozy outfit',
      source: 'prompt',
      retrievalMode: 'generated',
    })
    expect(res.body.suggestions).toHaveLength(1)
    expect(res.body.suggestions[0].name).toBe('AI Look')
  })

  it('returns early if < 2 items', async () => {
    vi.mocked(itemsTools.listItems).mockResolvedValue([mockItem] as any)
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'prompt', prompt: 'anything' })

    expect(res.status).toBe(200)
    expect(res.body.context.description).toBe('Not enough items')
    expect(res.body.suggestions).toHaveLength(0)
  })

  it('validates body schema', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'prompt', prompt: '' })

    expect(res.status).toBe(400)
  })

  it('accepts weather mode', async () => {
    vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue({
      temperature: 22, weatherCode: 1, condition: 'Sunny',
      precipitation: 0, windSpeed: 10, icon: 'sunny',
    } as any)

    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'weather', lat: 52, lon: 13 })

    expect(res.status).toBe(200)
    expect(res.body.context.source).toBe('weather')
    expect(res.body.context.description).toContain("Today's weather")
    expect(res.body.context.retrievalMode).toBe('generated')
  })

  it('passes occasion to LLM and telemetry in weather mode', async () => {
    vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue({
      temperature: 22, weatherCode: 1, condition: 'Sunny',
      precipitation: 0, windSpeed: 10, icon: 'sunny',
    } as any)

    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'weather', lat: 52, lon: 13, occasion: 'work' })

    expect(res.status).toBe(200)
    expect(discoverMod.matchClosetToContext).toHaveBeenCalledWith(
      expect.stringContaining('work outfit, 22°C'),
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      'prompt',
      'work',
    )
  })
})

describe('POST / (discover) — Track A: Outfit retrieval', () => {
  beforeEach(() => {
    process.env.DISCOVER_RETRIEVAL_ENABLED = 'true'
    process.env.DISCOVER_PREFILTER_ENABLED = 'false'
  })

  it('skips retrieval when disabled', async () => {
    process.env.DISCOVER_RETRIEVAL_ENABLED = 'false'
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(new Map() as any)

    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'prompt', prompt: 'cozy outfit' })

    expect(res.body.context.retrievalMode).toBe('generated')
    expect(embeddingsMod.getAllEmbeddings).not.toHaveBeenCalled()
  })

  it('uses retrieval path when weather mode + >= 10 embeddings + >= 2 strong scores', async () => {
    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 10; i++) {
      outfits.set(`outfit${i}`, new Float32Array(1024))
    }
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)
    vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([
      { id: 'outfit1', score: 0.72 },
      { id: 'outfit2', score: 0.55 },
    ])
    vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue({
      temperature: 22, weatherCode: 2, condition: 'Partly cloudy', precipitation: 0, windSpeed: 10, icon: '⛅',
    } as any)

    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'weather', lat: 43.5, lon: -79.5 })

    expect(res.body.context.retrievalMode).toBe('retrieved')
    expect(res.body.suggestions).toHaveLength(1)
    expect(res.body.suggestions[0].reasoning).toBe('Matched from your saved outfits')
    expect(discoverMod.matchClosetToContext).not.toHaveBeenCalled()
    expect(discoverEventsMod.logDiscoverEvent).toHaveBeenCalledWith(
      expect.objectContaining({ shortlistSource: 'outfit_retrieval' })
    )
  })

  it('does NOT use retrieval for prompt mode (short-query embedding is too weak)', async () => {
    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 10; i++) outfits.set(`outfit${i}`, new Float32Array(1024))
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)
    vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([
      { id: 'outfit1', score: 0.9 }, { id: 'outfit2', score: 0.85 },
    ])

    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'prompt', prompt: 'all yellow' })

    expect(res.body.context.retrievalMode).toBe('generated')
    expect(embeddingsMod.topKTextWithScores).not.toHaveBeenCalled()
    expect(discoverMod.matchClosetToContext).toHaveBeenCalled()
  })

  it('falls through to LLM when top retrieval score < 0.50 (weather mode)', async () => {
    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 10; i++) outfits.set(`outfit${i}`, new Float32Array(1024))
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)
    vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([
      { id: 'outfit1', score: 0.35 }, { id: 'outfit2', score: 0.30 },
    ])
    vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue({
      temperature: 22, weatherCode: 2, condition: 'Partly cloudy', precipitation: 0, windSpeed: 10, icon: '⛅',
    } as any)

    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'weather', lat: 43.5, lon: -79.5 })

    expect(res.body.context.retrievalMode).toBe('generated')
    expect(discoverMod.matchClosetToContext).toHaveBeenCalled()
  })

  it('falls through to LLM when < 10 outfit embeddings (weather mode)', async () => {
    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 5; i++) outfits.set(`outfit${i}`, new Float32Array(1024))
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)
    vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue({
      temperature: 22, weatherCode: 2, condition: 'Partly cloudy', precipitation: 0, windSpeed: 10, icon: '⛅',
    } as any)

    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'weather', lat: 43.5, lon: -79.5 })

    expect(res.body.context.retrievalMode).toBe('generated')
    expect(discoverMod.matchClosetToContext).toHaveBeenCalled()
  })

  it('falls through to LLM when < 2 strong-scored results (weather mode)', async () => {
    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 10; i++) outfits.set(`outfit${i}`, new Float32Array(1024))
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)
    vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([{ id: 'outfit1', score: 0.72 }])
    vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue({
      temperature: 22, weatherCode: 2, condition: 'Partly cloudy', precipitation: 0, windSpeed: 10, icon: '⛅',
    } as any)

    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'weather', lat: 43.5, lon: -79.5 })

    expect(res.body.context.retrievalMode).toBe('generated')
    expect(discoverMod.matchClosetToContext).toHaveBeenCalled()
  })

  it('does not use retrieval for shared mode', async () => {
    vi.mocked(shareTools.getSharePayload).mockReturnValue({
      id: 'share1',
      senderHandle: 'test',
      description: 'test desc',
      imageUris: '[]',
    } as any)

    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 10; i++) {
      outfits.set(`outfit${i}`, new Float32Array(1024))
    }
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)

    const app = makeApp()
    const res = await request(app)
      .post('/')
      .send({ mode: 'shared', shareId: 'share1' })

    expect(res.status).toBe(200)
    expect(embeddingsMod.getAllEmbeddings).not.toHaveBeenCalled()
  })
})

describe('POST /stream (discover streaming)', () => {
  beforeEach(() => {
    process.env.DISCOVER_RETRIEVAL_ENABLED = 'false'
    process.env.DISCOVER_PREFILTER_ENABLED = 'false'
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(new Map() as any)
    vi.mocked(outfitsTools.listOutfits).mockResolvedValue([mockOutfit] as any)
  })

  async function readSSE(res: request.Response): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
      res.on('error', reject)
    })
  }

  it('returns all three SSE phases for prompt mode', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'cozy outfit' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    expect(text).toContain('event: shortlist')
    expect(text).toContain('event: related_outfits')
    expect(text).toContain('event: suggestions')
    expect(text).toContain('event: done')
    expect(text).toContain('retrievalMode')
  })

  it('sends pool in shortlist event', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'cozy outfit' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    expect(text).toContain('"pool"')
  })

  it('sends related_outfits with empty results when no saved outfits', async () => {
    vi.mocked(outfitsTools.listOutfits).mockResolvedValue([])
    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'cozy outfit' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    expect(text).toContain('event: related_outfits')
    const match = text.match(/event: related_outfits\ndata: ({.*})/)
    expect(match).toBeTruthy()
    const data = JSON.parse(match![1])
    expect(data.outfits).toEqual([])
    expect(data.pool).toEqual([])
  })

  it('sends related_outfits with hydrated outfits when embeddings exist and clear the similarity gate', async () => {
    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 10; i++) outfits.set(`outfit${i}`, new Float32Array(1024))
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)
    vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([
      { id: 'outfit1', score: 0.7 }, { id: 'outfit2', score: 0.55 },
    ])

    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'cozy outfit' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    expect(text).toContain('event: related_outfits')

    const match = text.match(/event: related_outfits\ndata: ({.*})/)
    expect(match).toBeTruthy()
    const data = JSON.parse(match![1])
    expect(data.source).toBe('fused')
    expect(data.outfits.length).toBeGreaterThan(0)
  })

  it('drops below-threshold embedding matches from related_outfits (prompt mode "all yellow" → purple bug fix)', async () => {
    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 10; i++) outfits.set(`outfit${i}`, new Float32Array(1024))
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)
    // All scores below the 0.30 gate — none should surface.
    vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([
      { id: 'outfit1', score: 0.15 }, { id: 'outfit2', score: 0.10 },
    ])
    // Outfit whose items don't overlap the shortlist — signal 2 stays silent.
    vi.mocked(outfitsTools.listOutfits).mockResolvedValue([
      { ...mockOutfit, id: 'outfit1', itemIds: '["orphan"]' },
    ] as any)

    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'all yellow' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    const match = text.match(/event: related_outfits\ndata: ({.*})/)
    expect(match).toBeTruthy()
    const data = JSON.parse(match![1])
    expect(data.outfits).toEqual([])
    expect(data.source).toBe('none')
  })

  it('recency backfill never fires standalone (signals 1+2 empty → empty result, both modes)', async () => {
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(new Map() as any)
    vi.mocked(discoverMod.rankSavedOutfitsWithJev).mockResolvedValue([]) // no Jev matches
    vi.mocked(outfitsTools.listOutfits).mockResolvedValue([
      { ...mockOutfit, id: 'recent1', itemIds: '["orphan1"]', createdAt: Date.now() },
      { ...mockOutfit, id: 'recent2', itemIds: '["orphan2"]', createdAt: Date.now() - 1000 },
    ] as any)
    vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue({
      temperature: 5, weatherCode: 3, condition: 'Cold', precipitation: 0, windSpeed: 10, icon: '❄️',
    } as any)

    const app = makeApp()
    // Weather mode was the last remaining "standalone-recency" case.
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'weather', lat: 43.5, lon: -79.5 })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    const match = text.match(/event: related_outfits\ndata: ({.*})/)
    expect(match).toBeTruthy()
    const data = JSON.parse(match![1])
    expect(data.source).toBe('none')
    expect(data.outfits).toEqual([])
  })

  it('Jev-Noul saved-outfit ranking surfaces relevant outfits (source=jev)', async () => {
    vi.mocked(discoverMod.rankSavedOutfitsWithJev).mockResolvedValue(['outfit1'])
    vi.mocked(outfitsTools.listOutfits).mockResolvedValue([
      { ...mockOutfit, id: 'outfit1', itemIds: '["orphan"]', name: 'Sunshine Look' },
    ] as any)

    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'all yellow' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    const match = text.match(/event: related_outfits\ndata: ({.*})/)
    expect(match).toBeTruthy()
    const data = JSON.parse(match![1])
    expect(data.source).toBe('jev')
    expect(data.outfits.length).toBe(1)
    expect(data.outfits[0].name).toBe('Sunshine Look')
  })

  it('falls back to text-embedding signal 1 when Jev ranker throws', async () => {
    vi.mocked(discoverMod.rankSavedOutfitsWithJev).mockRejectedValue(new Error('jev down'))
    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 10; i++) outfits.set(`outfit${i}`, new Float32Array(1024))
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)
    vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([
      { id: 'outfit1', score: 0.72 },
    ])
    vi.mocked(outfitsTools.listOutfits).mockResolvedValue([
      { ...mockOutfit, id: 'outfit1', itemIds: '["orphan"]', name: 'Fallback Look' },
    ] as any)

    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'cozy' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    const match = text.match(/event: related_outfits\ndata: ({.*})/)
    const data = JSON.parse(match![1])
    expect(data.source).toBe('embedding')
    expect(data.outfits.length).toBe(1)
    expect(data.outfits[0].name).toBe('Fallback Look')
  })

  it('LLM still runs even when related outfits are found', async () => {
    const outfits = new Map<string, Float32Array>()
    for (let i = 0; i < 10; i++) {
      outfits.set(`outfit${i}`, new Float32Array(1024))
    }
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(outfits)
    vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([
      { id: 'outfit1', score: 0.7 }, { id: 'outfit2', score: 0.55 },
    ])

    const app = makeApp()
    await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'cozy outfit' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    // LLM should always run (no short-circuit)
    expect(discoverMod.matchClosetToContext).toHaveBeenCalled()
  })

  it('sends error for invalid body', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: '' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    expect(text).toContain('event: error')
  })

  it('sends error for not enough items', async () => {
    vi.mocked(itemsTools.listItems).mockResolvedValue([mockItem] as any)
    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'anything' })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    expect(text).toContain('event: error')
    expect(text).toContain('Not enough items')
  })

  it('accepts weather mode in stream', async () => {
    vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue({
      temperature: 22, weatherCode: 1, condition: 'Sunny',
      precipitation: 0, windSpeed: 10, icon: 'sunny',
    } as any)

    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'weather', lat: 52, lon: 13 })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    expect(text).toContain('event: shortlist')
    expect(text).toContain('event: related_outfits')
    expect(text).toContain('event: suggestions')
    expect(text).toContain('event: done')
    expect(discoverMod.matchClosetToContext).toHaveBeenCalled()
  })

  it('excludes items when excludeIds is provided', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    vi.mocked(embeddingsMod.shouldUsePreFilter).mockReturnValue(true)
    // Return many IDs so the pre-filter can find >= 12 after filtering excludes
    const allIds = Array.from({ length: 50 }, (_, i) => `it${i}`)
    // Make listItems return those items
    const manyItems = allIds.map(id => ({ ...mockItem, id }))
    vi.mocked(itemsTools.listItems).mockResolvedValue(manyItems as any)
    vi.mocked(embeddingsMod.topKText).mockResolvedValue(allIds)

    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'cozy outfit', excludeIds: { items: ['it0', 'it1'] } })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    expect(text).toContain('event: shortlist')
    expect(embeddingsMod.topKText).toHaveBeenCalled()
    const calls = vi.mocked(embeddingsMod.topKText).mock.calls
    // topKText(queryText, embedFn, userId, level, variant, k) — k is at index 5
    const hasExpandedK = calls.some((call: any[]) => call[5] > 12)
    expect(hasExpandedK).toBe(true)
  })

  it('excluded items are absent from shortlist.pool', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    vi.mocked(embeddingsMod.shouldUsePreFilter).mockReturnValue(true)
    const allIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p']
    const manyItems = allIds.map(id => ({ ...mockItem, id }))
    vi.mocked(itemsTools.listItems).mockResolvedValue(manyItems as any)
    vi.mocked(embeddingsMod.topKText).mockResolvedValue(allIds)

    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'cozy outfit', excludeIds: { items: ['a', 'b'] } })
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    const shortlistMatch = text.match(/event: shortlist\ndata: ({.*?})\n\nevent:/s)
    expect(shortlistMatch).toBeTruthy()
    const shortlistData = JSON.parse(shortlistMatch![1])
    const poolIds: string[] = shortlistData.pool.map((i: any) => i.id)
    expect(poolIds).not.toContain('a')
    expect(poolIds).not.toContain('b')
  })

  it('parses excludeIds sent as JSON string (image mode)', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    vi.mocked(embeddingsMod.shouldUsePreFilter).mockReturnValue(true)
    const allIds = ['x', 'y', 'z', 'w', 'v', 'u', 't', 's', 'r', 'q', 'p', 'o', 'n', 'm', 'l', 'k']
    const manyItems = allIds.map(id => ({ ...mockItem, id }))
    vi.mocked(itemsTools.listItems).mockResolvedValue(manyItems as any)
    vi.mocked(embeddingsMod.topKText).mockResolvedValue(allIds)

    const app = makeApp()
    // Simulate FormData-serialized excludeIds (arrives as JSON string via multer)
    const res = await request(app)
      .post('/stream')
      .field('mode', 'prompt')
      .field('prompt', 'sunny day')
      .field('excludeIds', JSON.stringify({ items: ['x', 'y'] }))
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })

    const text = res.body as unknown as string
    const shortlistMatch = text.match(/event: shortlist\ndata: ({.*?})\n\nevent:/s)
    expect(shortlistMatch).toBeTruthy()
    const shortlistData = JSON.parse(shortlistMatch![1])
    const poolIds: string[] = shortlistData.pool.map((i: any) => i.id)
    expect(poolIds).not.toContain('x')
    expect(poolIds).not.toContain('y')
  })

  // ── Issue #283: image-mode shortlist must respond to the uploaded image ──

  const oneHot = (dim: number, idx: number): Float32Array => {
    const v = new Float32Array(dim)
    v[idx] = 1
    return v
  }

  const cosine = (a: Float32Array, b: Float32Array): number => {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
    return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb))
  }

  async function submitImage(buffer: Buffer): Promise<string> {
    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .field('mode', 'image')
      .attach('image', buffer, 'inspiration.jpg')
      .buffer()
      .parse((res: any, cb: any) => { readSSE(res).then(t => cb(null, t)).catch(e => cb(e)) })
    return res.body as unknown as string
  }

  function extractShortlist(text: string): { items: any[]; pool: any[]; source: string } {
    const match = text.match(/event: shortlist\ndata: ({.*?})\n\n/s)
    expect(match).toBeTruthy()
    return JSON.parse(match![1]!)
  }

  it('image mode: visually different uploads surface different shortlists (issue #283)', async () => {
    process.env.DISCOVER_PREFILTER_ENABLED = 'true'
    vi.mocked(embeddingsMod.shouldUsePreFilter).mockReturnValue(true)
    vi.mocked(discoverMod.rankSavedOutfitsWithJev).mockResolvedValue([])

    // 24 candidate items, each with a one-hot image embedding.
    const allIds = Array.from({ length: 24 }, (_, i) => `it${i}`)
    const manyItems = allIds.map(id => ({ ...mockItem, id }))
    vi.mocked(itemsTools.listItems).mockResolvedValue(manyItems as any)

    const imageMap = new Map(allIds.map((id, i) => [id, oneHot(24, i)] as [string, Float32Array]))
    vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(imageMap as any)

    // embedImage derives the query vector from the file bytes: upload A aligns
    // with it14, upload B with it22 (beyond the top-12 tie window, so the
    // shortlist membership genuinely differs, not just the order).
    vi.mocked(embedImageMod.embedImage).mockImplementation(async (buf: Buffer) => {
      const first = buf[0]
      if (first === 66) return oneHot(24, 22) // 'B'
      return oneHot(24, 14) // 'A' (or anything else)
    })

    // Real cosine top-K over the item embeddings — the same math the mocked
    // module would run, so different query vectors genuinely sort differently.
    vi.mocked(embeddingsMod.topKImageFromBuffer).mockImplementation(
      async (buffer: Buffer, embedFn: any, _userId: string, k: number) => {
        const qv = await embedFn(buffer)
        const scored = [...imageMap.entries()]
          .map(([id, vec]) => ({ id, score: cosine(qv as Float32Array, vec) }))
          .sort((a, b) => b.score - a.score)
        return scored.slice(0, k).map(s => s.id)
      },
    )

    // Different descriptors + canonical colors per image feed contextText (Layer 2→3).
    vi.mocked(inspirationMod.analyzeInspiration).mockImplementation(async (b64: string) => {
      const buf = Buffer.from(b64, 'base64')
      const isB = buf[0] === 66
      return {
        data: {
          description: isB
            ? 'Baggy yellow streetwear with an oversized hoodie silhouette in heavyweight cotton'
            : 'Sleek black formal two-piece, tailored slim silhouette in fine wool',
          vibe: isB ? 'bold streetwear' : 'sleek formal',
          dominantColors: isB ? ['mustard', 'black'] : ['black', 'white'],
          garmentHints: isB ? ['oversized hoodie'] : ['single-breasted blazer'],
          materials: isB ? ['cotton'] : ['wool'],
        },
        usage: { tokensIn: 100, tokensOut: 50 },
      } as any
    })
    vi.mocked(embeddingsMod.topKText).mockResolvedValue(allIds)

    const textA = await submitImage(Buffer.from('A'))
    const textB = await submitImage(Buffer.from('B'))

    const a = extractShortlist(textA)
    const b = extractShortlist(textB)

    const idsA = a.items.map((i: any) => i.id)
    const idsB = b.items.map((i: any) => i.id)
    expect(a.source).toBe('image')
    expect(b.source).toBe('image')
    // Image aligned with it14 surfaces it14 (and not it22); vice versa for it22.
    expect(idsA).toContain('it14')
    expect(idsA).not.toContain('it22')
    expect(idsB).toContain('it22')
    expect(idsB).not.toContain('it14')
    // The two uploads genuinely differ in what the pre-filter returns.
    expect(idsA).not.toEqual(idsB)

    // Layered fix: canonical color names + materials reach the text pipeline
    // (embedding pool + downstream Jev) in the same vocabulary items use.
    const promptCalls = vi.mocked(embeddingsMod.topKText).mock.calls.map((c: any[]) => String(c[0]))
    expect(promptCalls.some(t => t.includes('Primary colors: mustard, black') && t.includes('Materials: cotton'))).toBe(true)

    // Both submissions ran distinct vision analyses (different base64 input).
    const inspirationCalls = vi.mocked(inspirationMod.analyzeInspiration).mock.calls.map((c: any[]) => c[0])
    expect(inspirationCalls).toHaveLength(2)
    expect(inspirationCalls[0]).not.toBe(inspirationCalls[1])
  })
})

describe('Discover never reads or forwards the user\'s sizes (#329)', () => {
  it('prompt mode (POST / and /stream) never calls getSettings, and no outbound call carries sizes', async () => {
    const app = makeApp()
    await request(app).post('/').send({ mode: 'prompt', prompt: 'cozy outfit' })
    await request(app).post('/stream').send({ mode: 'prompt', prompt: 'what fits me?' })
      .buffer()
      .parse((res: any, cb: any) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf-8')))
      })
    expect(settingsMod.getSettings).not.toHaveBeenCalled()
    const outbound = JSON.stringify([
      vi.mocked(discoverMod.matchClosetToContext).mock.calls,
      vi.mocked(discoverMod.rankItemsForOccasionWithJev).mock.calls,
      vi.mocked(discoverMod.rankItemsForInspirationWithJev).mock.calls,
      vi.mocked(discoverMod.rankSavedOutfitsWithJev).mock.calls,
      vi.mocked(inspirationMod.analyzeInspiration).mock.calls,
      vi.mocked(embedMod.embedText).mock.calls,
      vi.mocked(discoverEventsMod.logDiscoverEvent).mock.calls,
    ])
    expect(vi.mocked(discoverMod.matchClosetToContext).mock.calls.length).toBeGreaterThan(0)
    expect(outbound).not.toContain('ZZSIZE')
  })
})
