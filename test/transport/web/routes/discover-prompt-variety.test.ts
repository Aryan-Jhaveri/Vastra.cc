import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

// Issue #330 — Discover PROMPT mode showed the same "Based on these items" and
// Related Outfits for every prompt: with the prefilter off (or no item
// vectors) the pool was the whole closet newest-first, nothing re-ranked it,
// and Related Outfits seeded from that same unfiltered closet. Like the #282
// file, the REAL ranking code runs and only generateDecisions is mocked.

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


// Prompt → Noul per item category. "formal" charms shirt+blazer; "beach"
// charms tee+jeans. Keyed off state.inspiration (the typed prompt).
const ITEM_SCORES: Record<string, Record<string, number>> = {
  formal: { shirt: 0.9, blazer: 0.85, jeans: 0.2, tee: 0.1 },
  beach: { tee: 0.95, jeans: 0.8, shirt: 0.3, blazer: 0.05 },
}
// Prompt → Noul per saved outfit name. Mixed/Other stay under the 0.55 gate.
const OUTFIT_SCORES: Record<string, Record<string, number>> = {
  formal: { Office: 0.9, Beach: 0.1, Mixed: 0.3, Other: 0.2 },
  beach: { Beach: 0.9, Office: 0.1, Mixed: 0.3, Other: 0.2 },
}

const savedOutfits = [
  // Mixed holds every item — under the old hit-count seeding it led every prompt.
  { id: 'mixed', name: 'Mixed', itemIds: '["shirt","blazer","jeans","tee"]' },
  { id: 'office', name: 'Office', itemIds: '["shirt","blazer"]' },
  { id: 'beach', name: 'Beach', itemIds: '["tee","jeans"]' },
  { id: 'other', name: 'Other', itemIds: '["orphan"]' },
].map((o, i) => ({ ...o, userId: 'self', occasion: null, notes: null, season: '[]', tags: '[]', coverImageUri: null, source: 'manual', createdAt: Date.now() - i * 1000 }))

function promptKey(state: any): string {
  const text = String(state?.inspiration ?? '')
  return text.includes('beach') ? 'beach' : 'formal'
}

function installJevMock() {
  vi.mocked(decisionsMod.generateDecisions).mockImplementation(async (state: any, questions: Record<string, any>) => {
    const key = promptKey(state)
    const answers: Record<string, unknown> = {}
    for (const [qid, q] of Object.entries(questions)) {
      const instr = String((q as any).instructions ?? '')
      const outfit = instr.match(/"name":"([^"]*)"/)?.[1]
      const category = instr.match(/"category":"([^"]*)"/)?.[1] ?? ''
      const noul = instr.includes('saved outfit')
        ? OUTFIT_SCORES[key]![outfit ?? ''] ?? 0
        : ITEM_SCORES[key]![category] ?? 0.5
      answers[qid] = { type: 'noul', noul }
    }
    return { answers, usage: { cost: 0.0001, inputTokens: 300, outputTokens: 0 }, model: 'typesafe/jev-1.13', id: 'req_prompt_variety' }
  })
}

async function submitPrompt(prompt: string): Promise<{ shortlist: any; related: any; text: string }> {
  const res = await request(makeApp())
    .post('/stream')
    .send({ mode: 'prompt', prompt })
    .buffer()
    .parse((r: any, cb: any) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks).toString('utf-8')))
      r.on('error', (e: Error) => cb(e))
    })
  const text = res.body as unknown as string
  const shortlist = text.match(/event: shortlist\ndata: ({.*?})\n\n/s)
  const related = text.match(/event: related_outfits\ndata: ({.*?})\n\n/s)
  expect(shortlist).toBeTruthy()
  expect(related).toBeTruthy()
  return { shortlist: JSON.parse(shortlist![1]!), related: JSON.parse(related![1]!), text }
}

beforeEach(() => {
  vi.clearAllMocks()
  // The failure mode from #330: prefilter off, no item vectors.
  process.env.DISCOVER_PREFILTER_ENABLED = 'false'
  process.env.DISCOVER_RETRIEVAL_ENABLED = 'false'
  vi.mocked(itemsTools.listItems).mockResolvedValue(closet as any)
  vi.mocked(outfitsTools.listOutfits).mockResolvedValue(savedOutfits as any)
  vi.mocked(weatherTools.getCurrentWeather).mockResolvedValue(null as any)
  vi.mocked(embeddingsMod.shouldUsePreFilter).mockReturnValue(false)
  vi.mocked(embeddingsMod.getAllEmbeddings).mockReturnValue(new Map() as any)
  vi.mocked(embeddingsMod.reciprocalRankFusion).mockImplementation(
    (a: Map<string, number>, b: Map<string, number>, k: number, c = 60) => {
      const scores = new Map<string, number>()
      for (const id of new Set([...a.keys(), ...b.keys()])) {
        let s = 0
        if (a.has(id)) s += 1 / (c + a.get(id)!)
        if (b.has(id)) s += 1 / (c + b.get(id)!)
        scores.set(id, s)
      }
      return new Map([...scores.entries()].sort((x, y) => y[1] - x[1]).slice(0, k))
    },
  )
  installJevMock()
})

describe('POST /stream (prompt) — variety across prompts with no prefilter (#330)', () => {
  it('different prompts reorder "Based on these items"', async () => {
    const formal = await submitPrompt('all black formal evening')
    const beach = await submitPrompt('yellow beach streetwear')
    const formalPool = formal.shortlist.pool.map((i: any) => i.id)
    const beachPool = beach.shortlist.pool.map((i: any) => i.id)

    expect(formalPool).toEqual(['shirt', 'blazer', 'jeans', 'tee'])
    expect(beachPool).toEqual(['tee', 'jeans', 'shirt', 'blazer'])
    // The strip itself leads with the prompt-fitting pieces.
    expect(beach.shortlist.items.map((i: any) => i.id).slice(0, 2)).toEqual(['tee', 'jeans'])
  })

  it('different prompts lead Related Outfits with the matching outfit, not the biggest one', async () => {
    const formal = await submitPrompt('all black formal evening')
    const beach = await submitPrompt('yellow beach streetwear')
    expect(formal.related.outfits[0].id).toBe('office')
    expect(beach.related.outfits[0].id).toBe('beach')
    expect(formal.related.outfits.map((o: any) => o.id)).not.toEqual(beach.related.outfits.map((o: any) => o.id))
  })

  it('item-seeded outfits follow the prompt even when every Jev outfit score is under the gate', async () => {
    vi.mocked(decisionsMod.generateDecisions).mockImplementation(async (state: any, questions: Record<string, any>) => {
      const key = promptKey(state)
      const answers: Record<string, unknown> = {}
      for (const [qid, q] of Object.entries(questions)) {
        const instr = String((q as any).instructions ?? '')
        const category = instr.match(/"category":"([^"]*)"/)?.[1] ?? ''
        // Outfits all score 0.1 → signal 1 empty; items still ranked.
        answers[qid] = { type: 'noul', noul: instr.includes('saved outfit') ? 0.1 : ITEM_SCORES[key]![category] ?? 0.5 }
      }
      return { answers, usage: { cost: 0, inputTokens: 0, outputTokens: 0 }, model: null, id: null }
    })
    const formal = await submitPrompt('all black formal evening')
    const beach = await submitPrompt('yellow beach streetwear')
    expect(formal.related.source).toBe('item-seeded')
    expect(formal.related.outfits[0].id).toBe('office')
    expect(beach.related.outfits[0].id).toBe('beach')
  })

  it('runs one item-ranking Jev batch per request — compose reuses the pool ranking', async () => {
    await submitPrompt('all black formal evening')
    const itemBatches = vi.mocked(decisionsMod.generateDecisions).mock.calls
      .filter(c => Object.values(c[1] as Record<string, any>).some(q => /closet item/.test(q.instructions)))
    expect(itemBatches).toHaveLength(1)
    expect(Object.values(itemBatches[0]![1] as Record<string, any>)[0].instructions).toMatch(/match the described inspiration vibe/)
  })

  it('when Jev is down, Related Outfits are not seeded from the unfiltered closet', async () => {
    vi.mocked(decisionsMod.generateDecisions).mockRejectedValue(new Error('jev down'))
    const { shortlist, related } = await submitPrompt('all black formal evening')
    // Pool falls back to closet order, complete.
    expect(shortlist.pool.map((i: any) => i.id)).toEqual(['shirt', 'blazer', 'jeans', 'tee'])
    // No prompt signal at all → nothing, rather than the same size-ranked list.
    expect(related.outfits).toEqual([])
    expect(related.source).toBe('none')
  })
})

describe('outfit-embedding fallback reads the variant outfits are written under (#330)', () => {
  it('asks getAllEmbeddings for the metadata variant, not main', async () => {
    vi.mocked(decisionsMod.generateDecisions).mockRejectedValue(new Error('jev down'))
    const vecs = new Map([['office', new Float32Array(4)]])
    vi.mocked(embeddingsMod.getAllEmbeddings).mockImplementation(((_u: string, level: string, variant?: string) =>
      level === 'outfit' && variant === 'metadata' ? vecs : new Map()) as any)
    vi.mocked(embeddingsMod.topKTextWithScores).mockResolvedValue([{ id: 'office', score: 0.8 }])

    const { related } = await submitPrompt('all black formal evening')
    const outfitVariants = vi.mocked(embeddingsMod.getAllEmbeddings).mock.calls
      .filter(c => c[1] === 'outfit').map(c => c[2])
    expect(outfitVariants).toContain('metadata')
    expect(outfitVariants).not.toContain('main')
    expect(related.source).toBe('embedding')
    expect(related.outfits[0].id).toBe('office')
  })
})
