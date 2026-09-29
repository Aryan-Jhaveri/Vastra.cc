import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Issue #282 — Discover/Suggest shortlist variety across occasions.
// Unlike discover.test.ts (which mocks src/ai/discover.js wholesale), this
// file lets the REAL pool-ranking code run and only mocks generateDecisions,
// so we verify that different occasion values produce different shortlist
// pool orderings for the same closet.

vi.mock('../../../../src/ai/instrumented.js', () => ({
  runInstrumented: vi.fn((input: any) => input.call({}).then((r: any) => r.result)),
  runInstrumentedDecisions: vi.fn((input: any) => input.call()),
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

vi.mock('../../../../src/ai/decisions.js', () => ({
  generateDecisions: vi.fn(),
  JEV_MODEL: 'typesafe/jev-1.13',
}))

vi.mock('../../../../src/ai/client.js', () => ({
  generateJSONWithUsage: vi.fn(async () => ({
    data: [
      { item_ids: ['shirt', 'jeans'], name: 'Composed Look', occasion: 'casual', reasoning: 'Composed from the ranked subset.' },
    ],
    usage: { tokensIn: 200, tokensOut: 100 },
  })),
  VISION_MODEL: 'gemini-2.5-flash',
}))

vi.mock('../../../../src/ai/embed.js', () => ({
  embedText: vi.fn(),
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

import * as itemsTools from '../../../../src/tools/items.js'
import * as outfitsTools from '../../../../src/tools/outfits.js'
import * as weatherTools from '../../../../src/tools/weather.js'
import * as decisionsMod from '../../../../src/ai/decisions.js'
import * as embeddingsMod from '../../../../src/storage/embeddings.js'
import discoverRouter from '../../../../src/transport/web/routes/discover.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/', discoverRouter)
  return app
}

const baseItem = {
  imageUri: 'images/items/test.jpg',
  subcategory: null,
  primaryColor: 'white',
  colors: '["white"]',
  material: 'cotton',
  brand: null,
  size: 'M',
  season: '[]',
  tags: '[]',
  aiDescription: null,
  occasion: '[]',
  wearContext: null,
  materialSource: null,
  careInstructions: '[]',
  timesWorn: 0,
  lastWornAt: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  tagImageUri: null,
}

// One item per category so the Jev mock can put a different category on top
// depending on the occasion. Insertion order (listItems order) is the
// "embedding order" fallback the tests compare against.
const closet = [
  { id: 'shirt', category: 'shirt' },
  { id: 'blazer', category: 'blazer' },
  { id: 'jeans', category: 'jeans' },
  { id: 'tee', category: 'tee' },
].map((p, i) => ({ ...baseItem, id: p.id, category: p.category, createdAt: Date.now() + i }))

// Category → Noul score per occasion. work charms shirt+blazer; casual charms
// jeans+tee. The two tables produce different stable orderings of the closet.
const JEV_SCORES: Record<string, Record<string, number>> = {
  work: { shirt: 0.9, blazer: 0.75, jeans: 0.3, tee: 0.2 },
  casual: { jeans: 0.9, tee: 0.8, shirt: 0.3, blazer: 0.15 },
}

function installJevMock() {
  vi.mocked(decisionsMod.generateDecisions).mockImplementation(async (state: any, questions: Record<string, any>) => {
    const occasion = (state?.occasion as string) ?? ''
    const table = JEV_SCORES[occasion] ?? JEV_SCORES.work!
    const answers: Record<string, unknown> = {}
    for (const [qid, q] of Object.entries(questions)) {
      const instr = String((q as any).instructions ?? '')
      const m = instr.match(/"category":"([^"]*)"/)
      const category = m?.[1] ?? ''
      answers[qid] = { type: 'noul', noul: table[category] ?? 0.5 }
    }
    return {
      answers,
      usage: { cost: 0.0001, inputTokens: 300, outputTokens: 0 },
      model: 'typesafe/jev-1.13',
      id: 'req_occasion_variety',
    }
  })
}

function captureJevStates(): any[] {
  return vi.mocked(decisionsMod.generateDecisions).mock.calls.map(c => c[0] as any)
}

async function submitWeather(occasion: string): Promise<{ shortlistData: any; text: string }> {
  const app = makeApp()
  const res = await request(app)
    .post('/stream')
    .send({ mode: 'weather', lat: 43.5, lon: -79.5, occasion })
    .buffer()
    .parse((r: any, cb: any) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf-8')))
      r.on('error', (e: Error) => cb(e))
    })

  const text = res.body as unknown as string
  const match = text.match(/event: shortlist\ndata: ({.*?})\n\n/s)
  expect(match).toBeTruthy()
  return { shortlistData: JSON.parse(match![1]!), text }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.DISCOVER_PREFILTER_ENABLED = 'false'
  process.env.DISCOVER_RETRIEVAL_ENABLED = 'false'
  vi.mocked(itemsTools.listItems).mockResolvedValue(closet as any)
  vi.mocked(outfitsTools.listOutfits).mockResolvedValue([] as any)
  vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue({
    temperature: 22, weatherCode: 1, condition: 'Sunny',
    precipitation: 0, windSpeed: 10, icon: 'sunny',
  } as any)
  vi.mocked(embeddingsMod.shouldUsePreFilter).mockReturnValue(false)
  vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(new Map() as any)
  installJevMock()
})

describe('POST /stream (weather) — occasion variety in the shortlist pool (#282)', () => {
  it('small closet (below the prefilter threshold): pool contains the whole wardrobe, not truncated', async () => {
    const { shortlistData } = await submitWeather('work')
    const poolIds = shortlistData.pool.map((i: any) => i.id)
    expect(poolIds).toHaveLength(4)
    expect(new Set(poolIds)).toEqual(new Set(['shirt', 'blazer', 'jeans', 'tee']))
  })

  it('different occasions produce different pool orderings for the same closet', async () => {
    const work = await submitWeather('work')
    const casual = await submitWeather('casual')

    const workPool = work.shortlistData.pool.map((i: any) => i.id)
    const casualPool = casual.shortlistData.pool.map((i: any) => i.id)

    // Embedding order (listItems order) would be identical — Jev reordered.
    expect(workPool).toEqual(['shirt', 'blazer', 'jeans', 'tee'])
    expect(casualPool).toEqual(['jeans', 'tee', 'shirt', 'blazer'])
    expect(workPool).not.toEqual(casualPool)
  })

  it('the shortlist event items adopt the occasion-tuned pool order', async () => {
    const work = await submitWeather('work')
    const workItems = work.shortlistData.items.map((i: any) => i.id)
    expect(workItems).toEqual(['shirt', 'blazer', 'jeans', 'tee'])
  })

  it('Jev state carries a structured occasion field (not just baked into text)', async () => {
    await submitWeather('casual')
    const states = captureJevStates()
    // At least one Jev call (pool ranking) saw the structured occasion.
    expect(states.some(s => s?.occasion === 'casual')).toBe(true)
    // No user identifiers leak into the decision state.
    for (const s of states) {
      expect(JSON.stringify(s)).not.toContain('userId')
      expect(JSON.stringify(s)).not.toContain('user_id')
    }
  })

  it('runs one item-ranking Jev batch per request — compose reuses the pool ranking', async () => {
    const { text } = await submitWeather('work')
    // No saved outfits, so every Jev call here is item ranking. Before the
    // reuse, matchClosetToContext fired a second Noul batch on the shortlist.
    expect(decisionsMod.generateDecisions).toHaveBeenCalledTimes(1)
    const questions = vi.mocked(decisionsMod.generateDecisions).mock.calls[0]![1] as Record<string, any>
    expect(Object.values(questions)[0].instructions).toMatch(/How well does this closet item fit/)
    // Compose still produced suggestions from the pre-ranked items.
    expect(text).toContain('Composed Look')
  })

  it('falls back to closet order when Jev fails — pool stays complete', async () => {
    vi.mocked(decisionsMod.generateDecisions).mockRejectedValue(new Error('jev down'))
    const { shortlistData } = await submitWeather('work')
    const poolIds = shortlistData.pool.map((i: any) => i.id)
    // All four items still present, in embedding/items order.
    expect(poolIds).toEqual(['shirt', 'blazer', 'jeans', 'tee'])
  })

  it('excluded items never re-enter the pool through Jev reordering', async () => {
    const app = makeApp()
    const res = await request(app)
      .post('/stream')
      .send({
        mode: 'weather', lat: 43.5, lon: -79.5, occasion: 'work',
        excludeIds: { items: ['shirt'] },
      })
      .buffer()
      .parse((r: any, cb: any) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf-8')))
        r.on('error', (e: Error) => cb(e))
      })
    const text = res.body as unknown as string
    const match = text.match(/event: shortlist\ndata: ({.*?})\n\n/s)
    expect(match).toBeTruthy()
    const data = JSON.parse(match![1]!)
    const poolIds = data.pool.map((i: any) => i.id)
    expect(poolIds).not.toContain('shirt')
    expect(poolIds).toHaveLength(3)
  })
})
// ── Related Outfits (#282) ────────────────────────────────────────────────────
// Before the fix, Suggest's Related Outfits ignored the occasion in two ways:
// the item-seeded signal was seeded from the embedding shortlist (same members
// for every occasion), and the 0.55 Jev gate emptied the Jev signal for
// occasions nothing cleared, leaving the same occasion-blind list every time.

const outfitBase = {
  userId: 'self', season: '[]', tags: '[]', aiGenerated: 0, weatherContext: null,
  notes: null, coverImageUri: null, timesWorn: 0, lastWornAt: null, updatedAt: Date.now(),
}
// listOutfits order puts `office` first, so an occasion-blind result leads with it.
const savedOutfits = [
  { ...outfitBase, id: 'office', name: 'Office', itemIds: '["shirt","blazer"]', occasion: 'work', createdAt: 2 },
  { ...outfitBase, id: 'weekend', name: 'Weekend', itemIds: '["jeans","tee"]', occasion: 'casual', createdAt: 1 },
]

function realRrf(a: Map<string, number>, b: Map<string, number>, k: number): Map<string, number> {
  const scores = new Map<string, number>()
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    let score = 0
    if (a.has(id)) score += 1 / (61 + a.get(id)!)
    if (b.has(id)) score += 1 / (61 + b.get(id)!)
    scores.set(id, score)
  }
  return new Map([...scores.entries()].sort((x, y) => y[1] - x[1]).slice(0, k))
}

async function relatedIds(occasion: string): Promise<string[]> {
  const { text } = await submitWeather(occasion)
  const match = text.match(/event: related_outfits\ndata: ({.*?})\n\n/s)
  expect(match).toBeTruthy()
  return JSON.parse(match![1]!).outfits.map((o: any) => o.id)
}

describe('POST /stream (weather) — shop query for the Related shop row (#324)', () => {
  it('sends garment words as the query and the weather as intent — never the display string', async () => {
    const { shortlistData } = await submitWeather('work')
    expect(shortlistData.contextDescription).toBe("Today's weather: Sunny, 22°C")
    expect(shortlistData.shop).toEqual({
      query: 'work lightweight shirt and trousers',
      intent: 'work outfit for sunny weather, around 22°C',
    })
    expect(shortlistData.shop.query).not.toMatch(/weather|°C/i)
  })

  it('prompt mode keeps the typed query and adds the current weather to intent', async () => {
    const res = await request(makeApp())
      .post('/stream')
      .send({ mode: 'prompt', prompt: 'date night', lat: 43.5, lon: -79.5 })
      .buffer()
      .parse((r: any, cb: any) => {
        const chunks: Buffer[] = []
        r.on('data', (c: Buffer) => chunks.push(c))
        r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf-8')))
        r.on('error', (e: Error) => cb(e))
      })
    const match = (res.body as unknown as string).match(/event: shortlist\ndata: ({.*?})\n\n/s)
    expect(match).toBeTruthy()
    expect(JSON.parse(match![1]!).shop).toEqual({
      query: 'date night',
      intent: 'Current weather: sunny, around 22°C',
    })
  })
})

describe('POST /stream (weather) — Related Outfits follow the occasion (#282)', () => {
  beforeEach(() => {
    vi.mocked(outfitsTools.listOutfits).mockResolvedValue(savedOutfits as any)
    vi.mocked(embeddingsMod.reciprocalRankFusion).mockImplementation(realRrf)
    // Scores for an occasion nothing in the closet clears the 0.55 gate on.
    JEV_SCORES.date = { jeans: 0.4, tee: 0.35, shirt: 0.2, blazer: 0.1 }
  })

  it('leads with the occasion-fitting outfit for each occasion', async () => {
    expect((await relatedIds('work'))[0]).toBe('office')
    expect((await relatedIds('casual'))[0]).toBe('weekend')
  })

  it('still ranks by Jev fit when no outfit clears the inspiration gate', async () => {
    // Old behaviour: empty Jev signal → listOutfits order (office first).
    expect(await relatedIds('date')).toEqual(['weekend', 'office'])
  })

  it('seeds the item-overlap signal from the Jev-ranked pool, not the embedding shortlist', async () => {
    // 10 neutral fillers (Noul 0.5) push shirt + blazer out of the top-12 seed
    // under "casual". Outfit ranking fails, so only the item signal is left.
    const fillers = Array.from({ length: 10 }, (_, i) => ({ ...baseItem, id: `f${i}`, category: 'filler', createdAt: i }))
    vi.mocked(itemsTools.listItems).mockResolvedValue([...closet, ...fillers] as any)
    const itemRanking = vi.mocked(decisionsMod.generateDecisions).getMockImplementation()!
    vi.mocked(decisionsMod.generateDecisions).mockImplementation(async (state: any, questions: any) => {
      if (String((Object.values(questions)[0] as any).instructions).includes('saved outfit')) {
        throw new Error('outfit ranking down')
      }
      return itemRanking(state, questions)
    })

    // Old seed (whole shortlist) hit both outfits equally → office first.
    expect((await relatedIds('casual'))[0]).toBe('weekend')
  })
})
